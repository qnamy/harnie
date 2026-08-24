#!/usr/bin/env node
// Fail closed for state-changing tools while leaving unrelated read-only tools usable.
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readStdin, findRoot, resolveRoot, classifyCodex, canonicalRelPath, harnieControlSuffix, isOwnerSession, denyPreTool, allow, allowPreTool } from "./lib.mjs"
import { loadContext, recordPendingApproval, recordPendingErrata, hasPendingRoute, taskWatchdogUsage } from "../scripts/execution.mjs"
import { decideWriteEdit, decideBash, decideTask, decideCodex, decideWatchdog, isControlPath, taskIdFromActiveTaskWorktree } from "../scripts/guards.mjs"

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts")
const TRUSTED_CLIS = new Set([join(SCRIPTS, "loop.mjs"), join(SCRIPTS, "execution.mjs"), join(SCRIPTS, "worktree.mjs")])
const p = await readStdin()
const toolName = p.tool_name || ""
const input = p.tool_input || {}

try {
  // worktree-per-run(T2): 세션 cwd는 main 작업트리에 남아 있으므로, 이 세션이 바인딩된 run이 있으면 그 worktree를
  // root로 쓴다(①세션 바인딩 파일 ②없으면 findRoot 그대로). mainRoot(plain findRoot)은 route 게이트와 "밖" 판정
  // 보정(아래)에 쓴다 — pending-route·세션 바인딩 파일은 항상 main 작업트리에 있다.
  const root = resolveRoot(p.cwd, p.session_id)
  const mainRoot = findRoot(p.cwd)
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const { rel, abs, escapes } = canonicalRelPath(root, input.file_path || input.notebook_path)
    if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${input.file_path || input.notebook_path}`)
    if (isControlPath(rel)) denyPreTool(`control/route 파일 직접 쓰기 금지(${rel}) — 훅/CLI만`)
    // **다른 harnie run의 control 파일**이면 outside 여부와 무관하게 차단(권위 보호는 repo 경계와 무관) — 별개 repo로
    // 밖을 가리키는 절대경로뿐 아니라, worktree-per-run(T2)에서 root(main) 트리 **안쪽**에 nested된 다른 run의
    // worktree(`<root>/.harnie-wt/<slug>/.harnie/…`)도 여기 걸린다(그 경로는 rel이 `.harnie/`로 시작하지 않아
    // 위 isControlPath(rel)만으론 못 잡는다).
    const foreign = harnieControlSuffix(abs)
    if (foreign && isControlPath(foreign)) denyPreTool(`다른 harnie run의 control 파일 직접 쓰기 금지(${abs}) — 훅/CLI만`)
  }
  // route 파일은 항상 mainRoot(세션 cwd)에 있다 — resolveRoot로 worktree에 바인딩된 뒤에는 root≠mainRoot가 되어
  // 여기서 찾아야 늘 존재하지 않는 경로를 보게 되므로 게이트가 무력해진다.
  if (hasPendingRoute(mainRoot, p.session_id)) {
    const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent", "Bash"].includes(toolName) || classifyCodex(toolName).isCodex
    if (gated) denyPreTool("라우팅 미완료(pending-route) — 먼저 track 스킬(dev-full/dev-quick)을 호출하거나 `/harnie:dev-full`로 직접 진입하세요")
  }
  const ctx = loadContext(root)
  if (!ctx.active || !isOwnerSession(root, ctx, p.session_id)) {
    if (toolName === "Bash") {
      // 비-owner 세션(세션 id 교체·재개 등)도 run의 slug·멤버 workroot는 넘긴다 — 권위 부여가 아니라 신뢰
      // CLI **분류 입력**이다. 이게 빠지면 workspace run의 `loop.mjs delta <멤버 repo>`·`apply --root <멤버>`가
      // 미등록으로 보여 세션 중반부터 일제히 차단되는 실측 회귀가 있었다(autoAllow는 track 미전달로 계속 꺼짐).
      const d = decideBash({ command: input.command, trustedClis: TRUSTED_CLIS, activeRoot: root, activeSlug: ctx.slug ?? null, memberRoots: ctx.memberWorkroots || [] })
      if (d.deny) denyPreTool(d.reason)
    }
    allow()
  } else {
    const phase = ctx.failClosed ? "planning" : ctx.phase
    const slug = ctx.failClosed ? " " : ctx.slug // 매칭 불가 슬러그 → 모든 소스 쓰기 deny
    const track = ctx.track || "plan"
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      const target = input.file_path || input.notebook_path
      const { rel, escapes, outside: outsideRun } = canonicalRelPath(root, target)
      if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${target}`)
      // worktree-per-run(T2): root(=이 run의 worktree)가 main repo 자체가 아닐 때, "밖"은 원래 "이 repo·이 run과
      // 무관"을 뜻했다. main 트리 안(이 run의 worktree 밖)은 여전히 같은 repo 안이므로 outside로 보지 않는다 —
      // 그래야 승인 前 게이트가 "main root에 잘못 쓴" 실수를 계속 막는다(진짜 repo 밖 절대경로는 그대로 outside 유지).
      let outside = outsideRun
      if (outside && root !== mainRoot && !canonicalRelPath(mainRoot, target).outside) outside = false
      const d = decideWriteEdit({ relPath: rel, phase, track, slug, outside })
      d.deny ? denyPreTool(d.reason) : allow()
    } else if (toolName === "Bash") {
      const d = decideBash({ command: input.command, trustedClis: TRUSTED_CLIS, activeRoot: root, activeSlug: slug, activeTrack: track, memberRoots: ctx.memberWorkroots || [] })
      if (d.deny) denyPreTool(d.reason)
      else if (d.autoAllow && !ctx.failClosed) allowPreTool("harnie sanctioned 상태 CLI(capture·delta·completion·seal-verify) — active repo 바인딩·경로 containment 검증됨")
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
          taskWorktreeExists: ctx.taskWorktreeExists || {},
          memberRoots: ctx.memberWorkroots || [],
        })
        if (d.deny) denyPreTool(d.reason)
        // 워치독은 advisory다. 자체 읽기·판정 오류가 권위 가드의 fail-closed 경로로 새지 않게 독립적으로 무시한다.
        try {
          let usage = null
          if (!isReply && input.sandbox === "workspace-write") {
            const roots = [root, ...(ctx.memberWorkroots || [])]
            const mapped = roots.map((r) => taskIdFromActiveTaskWorktree(r, slug, input.cwd)).find((id) => id != null)
            const taskId = mapped || ctx.pendingRunRootBootstrap || (input.cwd == null && ctx.buildingUnboundTaskIds?.length === 1 ? ctx.buildingUnboundTaskIds[0] : null)
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
        try { recordPendingErrata(root, slug, p.tool_use_id) } catch { /* best-effort */ }
        allow()
      } else allow()
    }
  }
} catch (e) {
  const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent"].includes(toolName) || classifyCodex(toolName).isCodex
  if (gated) denyPreTool(`harnie PreToolUse 훅 오류(fail-closed): ${e && e.message ? e.message : e}`)
  allow()
}
