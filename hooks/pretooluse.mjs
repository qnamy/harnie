#!/usr/bin/env node
// Fail closed for state-changing tools while leaving unrelated read-only tools usable.
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readStdin, findRoot, classifyCodex, canonicalRelPath, harnieControlSuffix, isOwnerSession, denyPreTool, allow, allowPreTool } from "./lib.mjs"
import { loadContext, buildingUnboundTasks, recordPendingApproval, hasPendingRoute } from "../scripts/execution.mjs"
import { decideWriteEdit, decideBash, decideTask, decideCodex, isControlPath } from "../scripts/guards.mjs"

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts")
const TRUSTED_CLIS = new Set([join(SCRIPTS, "loop.mjs"), join(SCRIPTS, "execution.mjs")])
const p = await readStdin()
const toolName = p.tool_name || ""
const input = p.tool_input || {}

try {
  const root = findRoot(p.cwd)
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const { rel, abs, escapes, outside } = canonicalRelPath(root, input.file_path || input.notebook_path)
    if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${input.file_path || input.notebook_path}`)
    if (isControlPath(rel)) denyPreTool(`control/route 파일 직접 쓰기 금지(${rel}) — 훅/CLI만`)
    if (outside) {
      const foreign = harnieControlSuffix(abs)
      if (foreign && isControlPath(foreign)) denyPreTool(`다른 harnie run의 control 파일 직접 쓰기 금지(${abs}) — 훅/CLI만`)
    }
  }
  // A routed session cannot work around the required track entrypoint.
  if (hasPendingRoute(root, p.session_id)) {
    const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent", "Bash"].includes(toolName) || classifyCodex(toolName).isCodex
    if (gated) denyPreTool("라우팅 미완료(pending-route) — 먼저 track 스킬(dev-full/dev-quick)을 호출하거나 `/harnie:dev-full`로 직접 진입하세요")
  }
  const ctx = loadContext(root)
  if (!ctx.active || !isOwnerSession(root, ctx, p.session_id)) {
    if (toolName === "Bash") {
      const d = decideBash({ command: input.command, trustedClis: TRUSTED_CLIS, activeRoot: root })
      if (d.deny) denyPreTool(d.reason)
    }
    allow()
  } else {
    const phase = ctx.failClosed ? "planning" : ctx.phase
    const slug = ctx.failClosed ? " " : ctx.slug // 매칭 불가 슬러그 → 모든 소스 쓰기 deny
    const track = ctx.track || "plan"
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      const { rel, escapes, outside } = canonicalRelPath(root, input.file_path || input.notebook_path)
      if (escapes) denyPreTool(`쓰기 대상이 repo 밖(symlink/traversal): ${input.file_path || input.notebook_path}`)
      const d = decideWriteEdit({ relPath: rel, phase, track, slug, outside })
      d.deny ? denyPreTool(d.reason) : allow()
    } else if (toolName === "Bash") {
      const d = decideBash({ command: input.command, trustedClis: TRUSTED_CLIS, activeRoot: root, activeSlug: slug, activeTrack: track })
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
        try { recordPendingApproval(root, slug, p.tool_use_id) } catch { /* best-effort */ }
        allow()
      } else allow()
    }
  }
} catch (e) {
  const gated = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent"].includes(toolName) || classifyCodex(toolName).isCodex
  if (gated) denyPreTool(`harnie PreToolUse 훅 오류(fail-closed): ${e && e.message ? e.message : e}`)
  allow()
}
