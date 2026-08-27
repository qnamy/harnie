#!/usr/bin/env node
// Observe successful tool results to bind threads and approval without trusting main narration.
import { readStdin, resolveRoot, classifyCodex, extractThreadId, isOwnerSession, allow, allowPostTool } from "./lib.mjs"
import { loadContext, registerReadonlyThread, registerBuilderAuto, recordBuilderCall, bindApproval, bindRebind } from "../scripts/execution.mjs"
import { decideWatchdog } from "../scripts/guards.mjs"

try {
  let watchdogWarning = null
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
        else if (input.sandbox === "workspace-write") {
          registerBuilderAuto(root, ctx.slug, threadId, input.cwd) // 모호하면 no-op
          const recorded = recordBuilderCall(root, ctx.slug, threadId)
          if (recorded.ok) watchdogWarning = { ...recorded, ...decideWatchdog(recorded) }
        }
      }
    } else if (isCodex && isReply && (ctx.builderThreads || []).includes(input.threadId)) {
      const recorded = recordBuilderCall(root, ctx.slug, input.threadId)
      if (recorded.ok) watchdogWarning = { ...recorded, ...decideWatchdog(recorded) }
    } else if (toolName === "AskUserQuestion" && ctx.track === "plan") {
      bindApproval(root, ctx.slug, p.tool_use_id, response)
      bindRebind(root, ctx.slug, p.tool_use_id, input, response)
    }
    if (watchdogWarning && watchdogWarning.warn && !watchdogWarning.deny) {
      const elapsed = watchdogWarning.elapsedMs == null ? "시간 정보 없음" : `${Math.floor(watchdogWarning.elapsedMs / 60_000)}분`
      const budgetMin = watchdogWarning.wallClockBudgetMs / 60_000
      const used = Math.max(watchdogWarning.calls / watchdogWarning.maxCodexCalls, watchdogWarning.elapsedMs == null ? 0 : watchdogWarning.elapsedMs / watchdogWarning.wallClockBudgetMs)
      allowPostTool(`harnie 워치독 경고: task ${watchdogWarning.taskId} 예산 ${Math.ceil(used * 100)}% 소진(경과 ${elapsed}/${budgetMin}분, 빌더 호출 ${watchdogWarning.calls}/${watchdogWarning.maxCodexCalls}). 마무리를 계획하거나 사용자에게 상황을 보고하라.`)
    }
  }
} catch { /* 관찰-전용: 오류가 게이트를 열거나 닫지 않는다 */ }
allow()
