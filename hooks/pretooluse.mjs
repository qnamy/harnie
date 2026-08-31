#!/usr/bin/env node
// Fail closed for state-changing tools while leaving unrelated read-only tools usable.
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readStdin, findRoot, classifyCodex, canonicalRelPath, harnieControlSuffix, denyPreTool, allow, allowPreTool } from "./lib.mjs"
import { loadContext, recordPendingApproval, recordPendingRebind, taskWatchdogUsage } from "../scripts/execution.mjs"
import { decideWriteEdit, decideBash, decideTask, decideCodex, decideWatchdog, isControlPath } from "../scripts/guards.mjs"

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts")
const EXEC_CLI = join(SCRIPTS, "execution.mjs")
const TRUSTED_CLIS = new Set([join(SCRIPTS, "loop.mjs"), EXEC_CLI])
const p = await readStdin()
const toolName = p.tool_name || ""
const input = p.tool_input || {}
// 이 런타임에 arm-approval + AskUserQuestion 원샷 바인딩이 있는가. harnie 훅은 Claude와 Codex **양쪽에서**
// 돈다(0.14.0의 반대 전제는 틀렸다 — 그래서 approve 차단이 Codex에서도 발화해 dev-solo의 M 승인이 막혔다).
// Codex 판별은 공식 훅 계약이 "Codex-specific extension"으로 명시한 둘로 한다: 페이로드의 `turn_id`,
// 플러그인 훅 환경변수 `PLUGIN_ROOT`. `CLAUDE_PLUGIN_ROOT`는 Codex도 호환용으로 설정하므로 판별에 못 쓴다.
// 모르면 바인딩이 있는 쪽으로 본다 — 오분류의 두 방향 중 자가승인이 열리는 쪽이 더 나쁘다.
const isCodex = p.turn_id != null || process.env.PLUGIN_ROOT != null
const hookBoundApproval = !isCodex

try {
  // 0.14 D1: run root = 세션 cwd의 git repo root. harnie가 worktree를 만들지 않으므로 해석은 findRoot 하나다.
  const root = findRoot(p.cwd)
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const { rel, abs, escapes } = canonicalRelPath(root, input.file_path || input.notebook_path)
    if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${input.file_path || input.notebook_path}`)
    if (isControlPath(rel)) denyPreTool(`control/route 파일 직접 쓰기 금지(${rel}) — 훅/CLI만`)
    // **다른 harnie run의 control 파일**이면 outside 여부와 무관하게 차단(권위 보호는 repo 경계와 무관) —
    // 별개 repo로 밖을 가리키는 절대경로가 여기 걸린다(그 경로는 rel이 `.harnie/`로 시작하지 않아 위
    // isControlPath(rel)만으론 못 잡는다).
    const foreign = harnieControlSuffix(abs)
    if (foreign && isControlPath(foreign)) denyPreTool(`다른 harnie run의 control 파일 직접 쓰기 금지(${abs}) — 훅/CLI만`)
  }
  const ctx = loadContext(root)
  // 0.14 D4: 게이트 조건은 `ctx.active` 하나다. 세션 소유 여부는 보지 않는다 — run root가 사용자 트리이고
  // 두 런타임이 한 run을 번갈아 잡으므로, "이 세션이 owner인가"는 더 이상 판정 가능한 질문이 아니다.
  // 잠긴 트리에서 나오는 출구는 execution.mjs abandon이고, deny 문구가 그것을 안내한다.
  if (!ctx.active) {
    if (toolName === "Bash") {
      // 비활성 트리에서도 slug를 넘긴다 — 권위 부여가 아니라 신뢰 CLI **분류 입력**이다(autoAllow는 track 미전달로 꺼짐).
      const d = decideBash({ command: input.command, trustedClis: TRUSTED_CLIS, activeRoot: root, activeSlug: ctx.slug ?? null, hookBoundApproval })
      if (d.deny) denyPreTool(d.reason)
    }
    allow()
  } else {
    // S mode(0.11): 승인 게이트가 없으므로 planning-phase 제약(소스 쓰기·서브에이전트·codex read-only)을 걷는다 —
    // 유효 phase를 executing으로 매핑해 post-approval 규칙(빌더 게이팅·threadId 귀속)만 적용한다. control 보호는 불변.
    const rawPhase = ctx.failClosed ? "planning" : ctx.phase
    const phase = !ctx.failClosed && ctx.mode === "S" ? "executing" : rawPhase
    const slug = ctx.failClosed ? " " : ctx.slug // 매칭 불가 슬러그 → 모든 소스 쓰기 deny
    const track = ctx.track || "plan"
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      const target = input.file_path || input.notebook_path
      const { rel, escapes, outside } = canonicalRelPath(root, target)
      if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${target}`)
      const d = decideWriteEdit({ relPath: rel, phase, track, slug, outside, root, execCli: EXEC_CLI })
      d.deny ? denyPreTool(d.reason) : allow()
    } else if (toolName === "Bash") {
      const d = decideBash({ command: input.command, trustedClis: TRUSTED_CLIS, activeRoot: root, activeSlug: slug, activeTrack: track, hookBoundApproval })
      if (d.deny) denyPreTool(d.reason)
      else if (d.autoAllow && !ctx.failClosed) allowPreTool("harnie sanctioned 상태 CLI(capture·delta·completion·seal·seal-verify) — active repo 바인딩·경로 containment 검증됨")
      else allow()
    } else if (toolName === "Task" || toolName === "Agent") {
      const d = decideTask({ subagentType: input.subagent_type, phase })
      d.deny ? denyPreTool(d.reason) : allow()
    } else {
      const { isCodex, isReply } = classifyCodex(toolName)
      if (isCodex) {
        const d = decideCodex({
          isReply, sandbox: input.sandbox, cwd: input.cwd, root, slug, threadId: input.threadId, phase,
          readOnlyThreads: ctx.readOnlyThreads || [], builderThreads: ctx.builderThreads || [],
          buildingUnboundTasks: ctx.failClosed ? [] : ctx.buildingUnboundTaskIds || [],
          pendingRunRootBootstrap: ctx.pendingRunRootBootstrap || null,
          taskRepoWorkroots: ctx.taskRepoWorkroots || {},
        })
        if (d.deny) denyPreTool(d.reason)
        // 워치독은 advisory다. 자체 읽기·판정 오류가 권위 가드의 fail-closed 경로로 새지 않게 독립적으로 무시한다.
        try {
          let usage = null
          if (!isReply && input.sandbox === "workspace-write") {
            const taskId = ctx.pendingRunRootBootstrap || (ctx.buildingUnboundTaskIds?.length === 1 ? ctx.buildingUnboundTaskIds[0] : null)
            if (taskId) usage = taskWatchdogUsage(root, slug, { taskId })
          } else if (isReply && (ctx.builderThreads || []).includes(input.threadId)) {
            usage = taskWatchdogUsage(root, slug, { threadId: input.threadId })
          }
          if (usage) {
            const watchdog = decideWatchdog(usage)
            if (watchdog.deny) {
              const elapsed = watchdog.elapsedMs == null ? "시간 정보 없음" : `${Math.floor(watchdog.elapsedMs / 60_000)}분/${watchdog.wallClockBudgetMs / 60_000}분`
              denyPreTool(`워치독 예산 초과: task ${usage.taskId}, 경과 ${elapsed}, 빌더 codex 호출 ${watchdog.calls}/${watchdog.maxCodexCalls}. 추가 빌더 호출 중단 — 진행 상황과 블로커를 사용자에게 보고하라(정직 종료는 HARNIE_STATUS: INCOMPLETE — <blocker> footer). 사용자 동의 후 계속하려면: node ${join(SCRIPTS, "execution.mjs")} watchdog-extend --root ${root} --slug ${slug} --task ${usage.taskId} --reason "<사용자 승인 근거>"`)
            }
          }
        } catch { /* advisory 워치독 오류는 fail-open */ }
        allow()
      } else if (toolName === "AskUserQuestion" && !ctx.failClosed && track === "plan") {
        try { recordPendingApproval(root, slug, p.tool_use_id) } catch { /* best-effort */ }
        try { recordPendingRebind(root, slug, p.tool_use_id) } catch { /* best-effort */ }
        allow()
      } else allow()
    }
  }
} catch (e) {
  const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent"].includes(toolName) || classifyCodex(toolName).isCodex
  if (gated) denyPreTool(`harnie PreToolUse 훅 오류(fail-closed): ${e && e.message ? e.message : e}`)
  allow()
}
