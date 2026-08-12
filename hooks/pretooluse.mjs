#!/usr/bin/env node
// H1 PreToolUse — 승인 前·control 보호 + codex/Task 게이트(설계 §5.1). 활성 아니면 통과.
// 오류·상태 손상은 fail-closed(deny) — throw로 exit 1 나면 Claude Code가 비차단 처리하므로 전체 catch.
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readStdin, findRoot, classifyCodex, canonicalRelPath, denyPreTool, allow, allowPreTool } from "./lib.mjs"
import { loadContext, buildingUnboundTasks, recordPendingApproval, hasPendingRoute } from "../scripts/execution.mjs"
import { decideWriteEdit, decideBash, decideTask, decideCodex, isControlPath, referencesHarnie } from "../scripts/guards.mjs"

// 신뢰 상태 CLI 절대경로(이 훅과 형제인 scripts/). Bash 가드가 sanctioned 판정을 이 정확 경로에만 부여.
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts")
const TRUSTED_CLIS = new Set([join(SCRIPTS, "loop.mjs"), join(SCRIPTS, "execution.mjs")])

const p = await readStdin()
const toolName = p.tool_name || ""
const input = p.tool_input || {}

try {
  const root = findRoot(p.cwd)
  // baseline(active/pending 무관, P1-3): control·route·lock 파일 직접 쓰기 차단 — 다른 세션이 raw로 route/권위 파일을 바꾸지 못하게.
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const { rel, escapes } = canonicalRelPath(root, input.file_path || input.notebook_path)
    if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${input.file_path || input.notebook_path}`)
    if (isControlPath(rel)) denyPreTool(`control/route 파일 직접 쓰기 금지(${rel}) — 훅/CLI만`)
  }
  // pending-route 게이트(§3.9, P1-2/P1-4): 이 세션의 `/harnie:dev` 라우팅이 미완료면 **active 여부와 무관하게** 작업 도구를 차단
  // (기존 run 권한으로 우회 방지). **Bash는 전면 차단**(read-only 판정에 `rg --pre` 등 실행 우회 여지) — 비-Bash read-only(Read/Grep/Glob)만 허용.
  if (hasPendingRoute(root, p.session_id)) {
    const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent", "Bash"].includes(toolName) || classifyCodex(toolName).isCodex
    if (gated) denyPreTool("라우팅 미완료(pending-route) — 먼저 track 스킬(dev-full/dev-quick)을 호출하거나 `/harnie:dev-full`로 직접 진입하세요")
  }
  const ctx = loadContext(root)
  if (!ctx.active) {
    // active run 없음: `.harnie` 접근 Bash는 sanctioned CLI가 성립할 수 없으므로 차단(다른 세션의 route/control 파일 Bash 삭제 방지, P1-3).
    if (toolName === "Bash" && referencesHarnie(input.command)) denyPreTool("`.harnie` 접근 — active run 없음(비-sanctioned Bash 차단)")
    allow()
  } else {
    // fail-closed(sentinel-first 위반)면 가장 보수적으로: 쓰기류 차단(slug를 못 맞추게 해 전부 deny), read-only 통과.
    const phase = ctx.failClosed ? "planning" : ctx.phase
    const slug = ctx.failClosed ? " " : ctx.slug // 매칭 불가 슬러그 → 모든 소스 쓰기 deny
    const track = ctx.track || "plan"

    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      // symlink·traversal 해소한 canonical 상대경로로 판정. repo 밖으로 벗어나면(symlink 우회) deny.
      const { rel, escapes } = canonicalRelPath(root, input.file_path || input.notebook_path)
      if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${input.file_path || input.notebook_path}`)
      const d = decideWriteEdit({ relPath: rel, phase, track, slug })
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
