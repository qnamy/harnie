#!/usr/bin/env node
// H1 PreToolUse — 승인 前·control 보호 + codex/Task 게이트(설계 §5.1). 활성 아니면 통과.
// 오류·상태 손상은 fail-closed(deny) — throw로 exit 1 나면 Claude Code가 비차단 처리하므로 전체 catch.
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readStdin, findRoot, resolveRoot, classifyCodex, canonicalRelPath, harnieControlSuffix, isOwnerSession, denyPreTool, allow, allowPreTool } from "./lib.mjs"
import { loadContext, buildingUnboundTasks, recordPendingApproval, hasPendingRoute } from "../scripts/execution.mjs"
import { decideWriteEdit, decideBash, decideTask, decideCodex, isControlPath, referencesHarnie, isHarnieRead } from "../scripts/guards.mjs"

// 신뢰 상태 CLI 절대경로(이 훅과 형제인 scripts/). Bash 가드가 sanctioned 판정을 이 정확 경로에만 부여.
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts")
const TRUSTED_CLIS = new Set([join(SCRIPTS, "loop.mjs"), join(SCRIPTS, "execution.mjs")])

const p = await readStdin()
const toolName = p.tool_name || ""
const input = p.tool_input || {}

try {
  // worktree-per-run(T2): 세션 cwd는 main 작업트리에 남아 있으므로, 이 세션이 바인딩된 run이 있으면 그 worktree를
  // root로 쓴다(①세션 바인딩 파일 ②없으면 findRoot 그대로). mainRoot(plain findRoot)은 "밖" 판정 보정에 쓴다(아래).
  const root = resolveRoot(p.cwd, p.session_id)
  const mainRoot = findRoot(p.cwd)
  // baseline(active/pending 무관, P1-3): control·route·lock 파일 직접 쓰기 차단 — 다른 세션이 raw로 route/권위 파일을 바꾸지 못하게.
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
  // pending-route 게이트(§3.9, P1-2/P1-4): 이 세션의 `/harnie:dev` 라우팅이 미완료면 **active 여부와 무관하게** 작업 도구를 차단
  // (기존 run 권한으로 우회 방지). **Bash는 전면 차단**(read-only 판정에 `rg --pre` 등 실행 우회 여지) — 비-Bash read-only(Read/Grep/Glob)만 허용.
  // route 파일은 항상 mainRoot(세션 cwd)에 있다(Stop과 동일 기준) — resolveRoot로 worktree에 바인딩된 뒤에는
  // root≠mainRoot가 되어 여기서 찾아야 늘 존재하지 않는 경로를 보게 되므로 게이트가 무력해진다(non-blocking 발견, 일관성 수정).
  if (hasPendingRoute(mainRoot, p.session_id)) {
    const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent", "Bash"].includes(toolName) || classifyCodex(toolName).isCodex
    if (gated) denyPreTool("라우팅 미완료(pending-route) — 먼저 track 스킬(dev-full/dev-quick)을 호출하거나 `/harnie:dev-full`로 직접 진입하세요")
  }
  const ctx = loadContext(root)
  // owner 세션 판정: sentinel에 소유 세션이 기록돼 있고 이 세션이 아니면 **phase 기반 게이트는 적용하지 않는다**
  // (같은 cwd에 우연히 있는 무관한 세션 — 예: PR 리뷰 루틴 — 이 승인 前 게이트로 git·az까지 차단되던 과잉 차단 제거).
  // baseline(control/route 쓰기)·pending-route 게이트·`.harnie` Bash 차단은 비-owner에도 계속 적용된다.
  // sessionId 미기록(구버전 sentinel)이거나 payload에 session_id가 없으면 하위호환으로 현행 repo 전역 적용(fail-closed).
  if (!ctx.active || !isOwnerSession(root, ctx, p.session_id)) {
    // active run 없음/비-owner: `.harnie` **변형** Bash는 sanctioned CLI가 성립할 수 없으므로 차단(다른 세션의
    // route/control 파일 Bash 삭제 방지, P1-3). 이 차단의 목적은 삭제·변조 방지이므로 **좁은 읽기 형태는 통과**시킨다
    // (isHarnieRead = 아는 읽기 명령 + 짧은 플래그만, 확장·치환 fail-closed) — 상태 확인조차 막던 과잉 차단 제거.
    if (toolName === "Bash" && referencesHarnie(input.command) && !isHarnieRead(input.command))
      denyPreTool("`.harnie` 변경 — 이 세션 소유의 active run 아님(좁은 읽기만 허용, 기록·변경은 신뢰 CLI로만)")
    allow()
  } else {
    // fail-closed(sentinel-first 위반)면 가장 보수적으로: 쓰기류 차단(slug를 못 맞추게 해 전부 deny), read-only 통과.
    const phase = ctx.failClosed ? "planning" : ctx.phase
    const slug = ctx.failClosed ? " " : ctx.slug // 매칭 불가 슬러그 → 모든 소스 쓰기 deny
    const track = ctx.track || "plan"

    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      // symlink·traversal 해소한 canonical 상대경로로 판정. repo 안 경로가 밖을 가리키면(symlink 우회) deny.
      // 입력이 애초에 repo 밖 절대경로면 outside=true로 넘겨 phase 게이트 대상에서 제외(run의 소스가 아님).
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
      const d = decideBash({ command: input.command, phase, trustedClis: TRUSTED_CLIS, activeRoot: root, activeSlug: slug, activeTrack: track, trustedNode: process.execPath })
      // deny → 차단; sanctioned 4종 auto-allow → 프롬프트 skip(단 failClosed면 억제); 그 외 → 무의견(정상 권한 흐름).
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
          isReply, sandbox: input.sandbox, cwd: input.cwd, root, threadId: input.threadId, phase,
          readOnlyThreads: ctx.readOnlyThreads || [], builderThreads: ctx.builderThreads || [],
          hasBuildingUnbound: ctx.failClosed ? false : buildingUnboundTasks(root, slug).length > 0,
        })
        d.deny ? denyPreTool(d.reason) : allow()
      } else if (toolName === "AskUserQuestion" && !ctx.failClosed && track === "plan") {
        // 승인 게이트 후보: arm된 경우에만 pending 기록(비-승인 질문·질문/옵션 불일치면 no-op).
        const q0 = (input.questions && input.questions[0]) || {}
        const q = q0.question || null
        const opts = Array.isArray(q0.options) ? q0.options.map((o) => (o && typeof o === "object" ? o.label : o)) : null
        try { recordPendingApproval(root, slug, p.tool_use_id, q, opts) } catch { /* best-effort */ }
        allow()
      } else allow()
    }
  }
} catch (e) {
  // 쓰기·실행류만 deny(read-only 무관 툴은 통과시켜 세션을 브릭하지 않되, 게이트 대상 툴은 fail-closed).
  const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent"].includes(toolName) || classifyCodex(toolName).isCodex
  if (gated) denyPreTool(`harnie PreToolUse 훅 오류(fail-closed): ${e && e.message ? e.message : e}`)
  allow()
}
