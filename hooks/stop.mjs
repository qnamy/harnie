#!/usr/bin/env node
// H2 Stop — 미완료-확정 방지(설계 §5.2). 권위 재도출로 완료 판정, 재호출은 HARNIE_STATUS footer 계약으로.
// 오류·상태 손상은 **fail-closed**: block한다(throw로 exit 1 나면 Claude Code가 비차단 처리 → fail-open이 되므로 전체 catch).
import { readStdin, findRoot, isOwnerSession, blockStop, allow } from "./lib.mjs"
import { loadContext, computeCompletion, parseStatusFooter, getRouteState, clearPendingRoute } from "../scripts/execution.mjs"
import { decideStop } from "../scripts/guards.mjs"

const p = await readStdin()
const footer = parseStatusFooter(p.last_assistant_message)
const stopHookActive = !!p.stop_hook_active
// fail-closed 판정(정직 INCOMPLETE 보고면 통과, 아니면 block). 예외·손상·미완료 모두 이 경로로.
const failClosed = (blockers) => {
  const d = decideStop({ complete: false, blockers, footer, stopHookActive })
  return d.block ? blockStop(d.reason) : allow()
}

try {
  const root = findRoot(p.cwd)
  // pending-route(P1-1): 라우팅 상태에 따라 — `pending`(Skill 미호출)이면 종료 차단(강제 우회 방지),
  // `failed`(라우팅 시도했으나 bootstrap 실패)이면 **정리 후 통과**(정직한 실패 보고 허용; 활성 run이 있으면 아래 완료 판정이 다시 막는다).
  const routeState = getRouteState(root, p.session_id)
  if (routeState === "pending") blockStop("라우팅 미완료(pending-route) — track 스킬(dev-full/dev-quick)을 호출해 라우팅을 완료한 뒤 종료하세요")
  if (routeState === "failed") {
    // **정직한 실패 보고 확인(P1-4)**: footer가 거짓 COMPLETE거나 없으면 계속 차단, 정직 INCOMPLETE 보고면 정리 후 통과.
    const d = decideStop({ complete: false, blockers: ["라우팅 실패(bootstrap 미완) — 정직한 `HARNIE_STATUS: INCOMPLETE — <이유>` 보고 필요"], footer, stopHookActive })
    if (d.block) blockStop(d.reason)
    // INCOMPLETE에 **실제 blocker 이유가 있어야** 정리(빈 `INCOMPLETE`만으로 latch 우회 방지, P2). 구분자만 있고 내용 없으면 차단.
    const blocker = String((footer && footer.detail) || "").replace(/^[—\-:\s]+/, "").trim()
    if (!blocker) blockStop("`HARNIE_STATUS: INCOMPLETE — <라우팅 실패 이유>` 형태로 남은 이유를 명시하세요")
    clearPendingRoute(root, p.session_id)
  }
  const ctx = loadContext(root)
  if (!ctx.active) allow()
  // **owner 경계**: 이 run을 돌리는 세션이 아니면 완료 게이트를 적용하지 않는다 — 같은 repo에 우연히 있는 무관한
  // 세션(예: PR 리뷰 루틴)이 owner run의 미완료를 이유로 종료까지 차단되던 과잉 차단 제거. H1(PreToolUse)과 대칭.
  // **자기 pending-route 처리는 위에서 이미 끝났다** — 비-owner라도 자기 라우팅 미완료는 계속 차단된다.
  else if (!isOwnerSession(root, ctx, p.session_id)) allow()
  else if (ctx.failClosed) failClosed([`상태 손상: ${ctx.reason}`])
  // **승인된 active run이면 phase와 무관하게 항상 권위 재도출**(closed·역전이로 Stop 게이트를 우회하지 못하게).
  else if (ctx.approved) {
    const comp = computeCompletion(root, ctx.track, ctx.slug)
    const d = decideStop({ complete: comp.complete, blockers: comp.blockers, footer, stopHookActive })
    if (d.block) blockStop(d.reason)
    else allow()
  }
  // **승인 흔적(manifest/planHash)이 있는데 approved=false → 승인 후 plan.md/manifest 변조 → phase 무관 block**
  // (closed로 전이해도 여기서 잡힌다 — 이전엔 rawPhase가 executing/final-wave가 아니면 통과했던 우회 경로).
  else if (ctx.approvalEvidence)
    failClosed(["승인 권위 재검증 실패(승인 후 plan.md/manifest 변조 의심) — phase 무관 차단"])
  // 미승인인데 실행/최종 단계를 주장 → 승인 우회/손상 → fail-closed.
  else if (ctx.rawPhase === "executing" || ctx.rawPhase === "final-wave")
    failClosed(["실행 단계 주장이지만 승인(manifest) 없음 — 승인 우회/손상"])
  // 그 외(planning/awaiting, 미승인) → 완료 개념 없음, 통과.
  else allow()
} catch (e) {
  failClosed([`harnie Stop 훅 오류: ${e && e.message ? e.message : e}`])
}
