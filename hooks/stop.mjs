#!/usr/bin/env node
// Stop re-derives completion from authority files instead of trusting narration or phase.
import { readStdin, findRoot, isOwnerSession, blockStop, allow } from "./lib.mjs"
import { loadContext, computeCompletion, parseStatusFooter, getRouteState } from "../scripts/execution.mjs"
import { decideStop } from "../scripts/guards.mjs"

const p = await readStdin()
const footer = parseStatusFooter(p.last_assistant_message)
const stopHookActive = !!p.stop_hook_active
const failClosed = (blockers) => {
  const d = decideStop({ complete: false, blockers, footer, stopHookActive })
  return d.block ? blockStop(d.reason) : allow()
}

try {
  const root = findRoot(p.cwd)
  const routeState = getRouteState(root, p.session_id)
  if (routeState === "pending") blockStop("라우팅 미완료(pending-route) — track 스킬(dev-full/dev-quick)을 호출해 라우팅을 완료한 뒤 종료하세요")
  const ctx = loadContext(root)
  if (!ctx.active) allow()
  else if (!isOwnerSession(root, ctx, p.session_id)) allow()
  else if (ctx.failClosed) failClosed([`상태 손상: ${ctx.reason}`])
  // Approved runs are checked regardless of their advisory phase.
  else if (ctx.approved) {
    const comp = computeCompletion(root, ctx.track, ctx.slug)
    const d = decideStop({ complete: comp.complete, blockers: comp.blockers, footer, stopHookActive })
    if (d.block) blockStop(d.reason)
    else allow()
  }
  else if (ctx.approvalEvidence)
    failClosed(["승인 권위 재검증 실패(승인 후 plan.md/manifest 변조 의심) — phase 무관 차단"])
  else if (ctx.rawPhase === "executing" || ctx.rawPhase === "final-wave")
    failClosed(["실행 단계 주장이지만 승인(manifest) 없음 — 승인 우회/손상"])
  else allow()
} catch (e) {
  failClosed([`harnie Stop 훅 오류: ${e && e.message ? e.message : e}`])
}
