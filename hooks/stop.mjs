#!/usr/bin/env node
// Stop re-derives completion from authority files instead of trusting narration or phase.
import { readStdin, resolveRoot, isOwnerSession, blockStop, allow } from "./lib.mjs"
import { loadContext, computeCompletion, parseStatusFooter } from "../scripts/execution.mjs"
import { decideStop } from "../scripts/guards.mjs"

const p = await readStdin()
const footer = parseStatusFooter(p.last_assistant_message)
const stopHookActive = !!p.stop_hook_active
const failClosed = (blockers) => {
  const d = decideStop({ complete: false, blockers, footer, stopHookActive })
  return d.block ? blockStop(d.reason) : allow()
}

try {
  const root = resolveRoot(p.cwd, p.session_id)
  const ctx = loadContext(root)
  if (!ctx.active) allow()
  else if (!isOwnerSession(root, ctx, p.session_id)) allow()
  else if (ctx.failClosed) failClosed([`상태 손상: ${ctx.reason}`])
  // S mode(0.11): 승인 권위 없음 — canonical 리뷰 유닛 APPROVED + 현재 트리 바인딩 + 정직 footer가 완료 판정.
  // decideStop은 complete를 단락 평가하므로, S의 3항 중 footer는 여기서 별도 강제한다(CR-002 — footer 없는 false-completion 차단).
  else if (ctx.mode === "S") {
    const comp = computeCompletion(root, ctx.track, ctx.slug)
    if (comp.complete && !(footer.present && footer.status === "COMPLETE"))
      blockStop("S run 완료 판정인데 HARNIE_STATUS 푸터 부재/불일치 — 최종 응답을 `HARNIE_STATUS: COMPLETE`로 끝내라(미완료면 INCOMPLETE — <blocker>)")
    const d = decideStop({ complete: comp.complete, blockers: comp.blockers, footer, stopHookActive })
    d.block ? blockStop(d.reason) : allow()
  }
  // Approved runs are checked regardless of their advisory phase.
  else if (ctx.approved) {
    const comp = computeCompletion(root, ctx.track, ctx.slug)
    const d = decideStop({ complete: comp.complete, blockers: comp.blockers, footer, stopHookActive })
    if (d.block) blockStop(d.reason)
    // 한 세션 = 한 run(v1): 완료 후에도 바인딩을 세션 수명 동안 유지한다. 그래야 후속 수정이 생겨도
    // resolveRoot가 같은 workroot를 찾아 H1/H2가 다시 권위를 재검증한다.
    allow()
  }
  else if (ctx.approvalEvidence)
    failClosed(["승인 권위 재검증 실패(승인 후 plan.md/manifest 변조 의심) — phase 무관 차단"])
  else if (ctx.rawPhase === "executing" || ctx.rawPhase === "final-wave")
    failClosed(["실행 단계 주장이지만 승인(manifest) 없음 — 승인 우회/손상"])
  else allow()
} catch (e) {
  failClosed([`harnie Stop 훅 오류: ${e && e.message ? e.message : e}`])
}
