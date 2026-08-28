#!/usr/bin/env node
// Stop re-derives completion from authority files instead of trusting narration or phase.
import { readStdin, findRoot, blockStop, allow } from "./lib.mjs"
import { loadContext, computeCompletion, parseStatusFooter, treeDrift } from "../scripts/execution.mjs"
import { decideStop } from "../scripts/guards.mjs"

const p = await readStdin()
const footer = parseStatusFooter(p.last_assistant_message)
const stopHookActive = !!p.stop_hook_active
const failClosed = (blockers) => {
  const d = decideStop({ complete: false, blockers, footer, stopHookActive })
  return d.block ? blockStop(d.reason) : allow()
}

// 0.14 DEC-4: 드리프트로 막을 때 사람이 판단할 재료를 함께 준다 — 리뷰 후 무엇이 바뀌었는지, 그리고 그
// 판단이 오케스트레이터가 아니라 사용자의 것이라는 사실. 판단 뒤의 진행 경로는 rebind-tree 하나다.
function driftHint(root, track, slug) {
  let drift = []
  try { drift = treeDrift(root, track, slug) } catch { return "" }
  if (!drift.length) return ""
  const lines = drift.map((d) => `  - ${d.unit}: ${d.files.length ? d.files.join(", ") : "(변경 목록 산출 실패)"}`)
  return `\n리뷰 후 변경된 파일:\n${lines.join("\n")}\n이 편집이 이 run과 무관한지 **사용자에게 물어라**(스스로 판정하지 마라). ` +
    `무관하다는 답을 받으면 \`execution.mjs rebind-tree --root ${root} --slug ${slug} --unit <위 유닛> --files <위 목록, 쉼표 구분>\`으로 수용하고, ` +
    `리뷰 범위와 겹치면 그 커맨드가 거부한다 — 그때 출구는 재리뷰뿐이다.`
}
const blockWithDrift = (reason, root, track, slug) => blockStop(reason + driftHint(root, track, slug))

try {
  const root = findRoot(p.cwd)
  const ctx = loadContext(root)
  // 0.14 D4: 활성 run이 있는 트리의 모든 세션이 완료 강제 대상이다(세션 소유 개념 삭제).
  if (!ctx.active) allow()
  else if (ctx.failClosed) failClosed([`상태 손상: ${ctx.reason}`])
  // S mode(0.11): 승인 권위 없음 — canonical 리뷰 유닛 APPROVED + 현재 트리 바인딩 + 정직 footer가 완료 판정.
  // decideStop은 complete를 단락 평가하므로, S의 3항 중 footer는 여기서 별도 강제한다(CR-002 — footer 없는 false-completion 차단).
  else if (ctx.mode === "S") {
    const comp = computeCompletion(root, ctx.track, ctx.slug)
    if (comp.complete && !(footer.present && footer.status === "COMPLETE"))
      blockStop("S run 완료 판정인데 HARNIE_STATUS 푸터 부재/불일치 — 최종 응답을 `HARNIE_STATUS: COMPLETE`로 끝내라(미완료면 INCOMPLETE — <blocker>)")
    const d = decideStop({ complete: comp.complete, blockers: comp.blockers, footer, stopHookActive })
    d.block ? blockWithDrift(d.reason, root, ctx.track, ctx.slug) : allow()
  }
  // Approved runs are checked regardless of their advisory phase.
  else if (ctx.approved) {
    const comp = computeCompletion(root, ctx.track, ctx.slug)
    const d = decideStop({ complete: comp.complete, blockers: comp.blockers, footer, stopHookActive })
    if (d.block) blockWithDrift(d.reason, root, ctx.track, ctx.slug)
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
