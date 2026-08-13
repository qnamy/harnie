#!/usr/bin/env node
// Observe successful tool results to bind threads and approval without trusting main narration.
import { readStdin, resolveRoot, classifyCodex, extractThreadId, isOwnerSession, allow } from "./lib.mjs"
import { loadContext, registerReadonlyThread, registerBuilderAuto, bindApproval } from "../scripts/execution.mjs"

try {
  const p = await readStdin()
  // worktree-per-run(T2): H1과 동일한 해석 순서(①cwd 상향 findRoot ②세션 바인딩)로 이 세션의 run을 찾는다.
  const root = resolveRoot(p.cwd, p.session_id)
  const ctx = loadContext(root)
  if (ctx.active && !ctx.failClosed && isOwnerSession(root, ctx, p.session_id)) {
    const toolName = p.tool_name || ""
    const input = p.tool_input || {}
    const response = p.tool_response
    const { isCodex, isReply } = classifyCodex(toolName)
    if (isCodex && !isReply) {
      const threadId = extractThreadId(response) || input.threadId
      if (threadId) {
        if (input.sandbox === "read-only") registerReadonlyThread(root, ctx.track, ctx.slug, threadId)
        else if (input.sandbox === "workspace-write") registerBuilderAuto(root, ctx.slug, threadId) // 모호하면 no-op
      }
    } else if (toolName === "AskUserQuestion" && ctx.track === "plan") {
      bindApproval(root, ctx.slug, p.tool_use_id, response)
    }
  }
} catch { /* 관찰-전용: 오류가 게이트를 열거나 닫지 않는다 */ }
allow()
