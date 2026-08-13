#!/usr/bin/env node
// PostToolUse — main-공급 신뢰 제거(설계 §4·§5.1): 성공한 codex 호출을 관찰해 threadId 등록,
// AskUserQuestion 실제 답을 관찰해 승인 바인딩. 관찰 기반이라 부작용만 있고 결정은 없다(항상 통과, 오류도 통과).
import { readStdin, findRoot, classifyCodex, extractThreadId, isOwnerSession, allow } from "./lib.mjs"
import { loadContext, registerReadonlyThread, registerBuilderAuto, bindApproval } from "../scripts/execution.mjs"

try {
  const p = await readStdin()
  const root = findRoot(p.cwd)
  const ctx = loadContext(root)
  // **owner 경계**(H1·H2와 대칭): 비-owner 세션의 codex 성공·승인 답변은 관찰하지 않는다. 관찰-전용 훅이지만
  // 부작용이 owner run의 권위 상태에 쓰이므로, 무관한 세션의 workspace-write codex가 owner run의 유일한
  // building-unbound task에 빌더로 자동 귀속되거나 승인이 오-바인딩되는 **상태 오염**을 막는다.
  if (ctx.active && !ctx.failClosed && isOwnerSession(root, ctx, p.session_id)) {
    const toolName = p.tool_name || ""
    const input = p.tool_input || {}
    const response = p.tool_response
    const { isCodex, isReply } = classifyCodex(toolName)

    // codex 성공 → threadId 등록. read-only(설계 리뷰) → readOnlyThreads; workspace-write 최초 → 빌더 스레드(유일 building-unbound task).
    if (isCodex && !isReply) {
      const threadId = extractThreadId(response) || input.threadId
      if (threadId) {
        if (input.sandbox === "read-only") registerReadonlyThread(root, ctx.track, ctx.slug, threadId)
        else if (input.sandbox === "workspace-write") registerBuilderAuto(root, ctx.slug, threadId) // 모호하면 no-op
      }
    } else if (toolName === "AskUserQuestion" && ctx.track === "plan") {
      // 원본 응답을 넘긴다 — bindApproval이 pending 질문 키의 선택값만 뽑아 approveOption과 정확 일치할 때만 승인.
      bindApproval(root, ctx.slug, p.tool_use_id, response)
    }
  }
} catch { /* 관찰-전용: 오류가 게이트를 열거나 닫지 않는다 */ }
allow()
