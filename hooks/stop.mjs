#!/usr/bin/env node
// H2 Stop — 미완료-확정 방지(설계 §5.2). 권위 재도출로 완료 판정, 재호출은 HARNIE_STATUS footer 계약으로.
// 오류·상태 손상은 **fail-closed**: block한다(throw로 exit 1 나면 Claude Code가 비차단 처리 → fail-open이 되므로 전체 catch).
import { readStdin, findRoot, blockStop, allow } from "./lib.mjs"
import { loadContext, computeCompletion, parseStatusFooter } from "../scripts/execution.mjs"
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
  const ctx = loadContext(root)
  if (!ctx.active) allow()
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
