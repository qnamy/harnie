import assert from "node:assert"
import { parseReview, mergeLedger, openBlockingCount, validateLedger } from "./ledger.mjs"

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log("✓ " + name) } catch (e) { fail++; console.log("✗ " + name + " — " + e.message) } }
const NS = { namespace: "CR" }
const pr = (text) => parseReview(text, NS)
const merge = (prev, text) => mergeLedger(prev, pr(text), NS)
const entry = (id, blocking, status) => ({ id, blocking, status, location: "x", text: "a" })

// ── 긍정 ──────────────────────────────────────────────
t("ISSUES:[] + APPROVE 커밋·open blocking 0", () => {
  const m = merge({}, "VERDICT: APPROVE\nISSUES: []")
  assert.equal(m.committed, true); assert.equal(m.newOpenBlocking, 0)
})

let ledger1
t("round1: 커밋, open blocking=1", () => {
  const m = merge({}, `VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (open) [auth.ts:42] 만료 미검증
- [CR-002] (non-blocking) (open) [auth.ts:60] 메트릭 혼동`)
  ledger1 = m.ledger
  assert.equal(m.committed, true); assert.equal(openBlockingCount(ledger1), 1)
})

t("round2: non-blocking 누락 open 유지 + 커밋 + whack-a-mole(1→1) no progress", () => {
  const m = merge(ledger1, `VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (resolved) [auth.ts:42] 반영됨
- [CR-003] (blocking) (open) [auth.ts:45] refresh 미적용`)
  assert.equal(m.committed, true)
  assert.equal(m.ledger["CR-002"].status, "open")
  assert.deepEqual(m.protocolViolations, ["CR-002"]); assert.deepEqual(m.omittedBlocking, [])
  assert.equal(m.gateProgress, false); assert.equal(m.needsReRequest, false)
})

t("open blocking 2→1 = gate progress", () => {
  const prev = { "CR-001": entry("CR-001", true, "open"), "CR-002": entry("CR-002", true, "open") }
  const m = merge(prev, `VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (resolved) [x] done
- [CR-002] (blocking) (open) [y] still`)
  assert.equal(m.prevOpenBlocking, 2); assert.equal(m.newOpenBlocking, 1); assert.equal(m.gateProgress, true)
})

t("reopen: resolved가 open 보고되면 되돌아감", () => {
  const m = merge({ "CR-001": entry("CR-001", true, "resolved") }, "VERDICT: REJECT\nISSUES:\n- [CR-001] (blocking) (open) [x] regressed")
  assert.equal(m.ledger["CR-001"].status, "open"); assert.equal(m.newOpenBlocking, 1)
})

// ── 부정(false approval 방지) ─────────────────────────
t("N: ISSUES:[] 뒤 blocking 행 → 커밋 안 됨", () => {
  const m = merge({}, "VERDICT: APPROVE\nISSUES: []\n- [CR-001] (blocking) (open) [x:1] hidden")
  assert.equal(m.committed, false); assert.equal(m.needsReRequest, true)
})
t("N: malformed 비-'[' 행이 무시되지 않음(숨은 blocker)", () => {
  const p = pr(`VERDICT: APPROVE
ISSUES:
- [CR-001] (non-blocking) (open) [x:1] visible
- CR-002 (blocking) open [x:2] malformed hidden blocker`)
  assert.equal(p.ok, false)
})
t("N: ISSUES 블록의 prose 행 → error", () => {
  assert.equal(pr("VERDICT: REJECT\nISSUES:\n- [CR-001] (blocking) (open) [x] a\n그냥 산문").ok, false)
})
t("N: VERDICT 중복 → error", () => { assert.equal(pr("VERDICT: APPROVE\nVERDICT: REJECT\nISSUES: []").ok, false) })
t("N: ISSUES 섹션 누락 → error", () => { assert.equal(pr("VERDICT: APPROVE").ok, false) })
t("N: 본문 누락 malformed → error", () => { assert.equal(pr("VERDICT: APPROVE\nISSUES:\n- [CR-001] (blocking) (open) [x:1]").ok, false) })
t("N: location 누락 → error", () => { assert.equal(pr("VERDICT: REJECT\nISSUES:\n- [CR-001] (blocking) (open) 본문만").ok, false) })
t("N: duplicate ID → error", () => {
  assert.equal(pr("VERDICT: APPROVE\nISSUES:\n- [CR-001] (blocking) (open) [x] a\n- [CR-001] (non-blocking) (resolved) [x] b").ok, false)
})
t("N: wrong namespace(DR in CR) → error", () => { assert.equal(pr("VERDICT: REJECT\nISSUES:\n- [DR-001] (blocking) (open) [x] a").ok, false) })
t("N: namespace 인자 필수(생략 시 throw)", () => { assert.throws(() => parseReview("VERDICT: APPROVE\nISSUES: []")) })
t("N: 미지 ID resolved 제출 → rollback", () => {
  const m = merge({}, "VERDICT: APPROVE\nISSUES:\n- [CR-009] (blocking) (resolved) [x] a")
  assert.equal(m.committed, false)
})
t("N: 기존 ID blocking 분류 변경 → rollback", () => {
  const m = merge({ "CR-001": entry("CR-001", true, "open") }, "VERDICT: REJECT\nISSUES:\n- [CR-001] (non-blocking) (open) [x] a")
  assert.equal(m.committed, false); assert.ok(m.reasons.some((r) => r.includes("분류")))
})
t("N: blocking omission 인자 생략 우회 불가", () => {
  const m = merge({ "CR-001": entry("CR-001", true, "open") }, "VERDICT: REJECT\nISSUES: []")
  assert.deepEqual(m.omittedBlocking, ["CR-001"]); assert.equal(m.committed, false)
})
t("N: 무효(APPROVE+open blocking)은 ledger·progress 불변", () => {
  const prev = { "CR-001": entry("CR-001", true, "open") }
  const m = merge(prev, "VERDICT: APPROVE\nISSUES:\n- [CR-001] (blocking) (open) [x] still")
  assert.equal(m.committed, false); assert.equal(m.gateProgress, null); assert.strictEqual(m.ledger, prev)
})
t("N: 손상 persisted ledger(status 'OPEN') → fail-closed", () => {
  const corrupt = { "CR-001": { blocking: true, status: "OPEN" } }
  const m = mergeLedger(corrupt, pr("VERDICT: APPROVE\nISSUES: []"), NS)
  assert.equal(m.committed, false); assert.ok(m.reasons.some((r) => r.includes("손상된")))
})

t("N: 빈 ISSUES(without []) → error", () => { assert.equal(pr("VERDICT: APPROVE\nISSUES:").ok, false) })
t("N: 내부 fence(비-outer) blocker → error, commit false", () => {
  const p = pr("VERDICT: APPROVE\nISSUES:\n```\n- [CR-001] (blocking) (open) [x:1] hidden\n```")
  assert.equal(p.ok, false); assert.equal(mergeLedger({}, p, NS).committed, false)
})
t("N: ISSUES:[] + 내부 fence → error", () => {
  assert.equal(pr("VERDICT: APPROVE\nISSUES: []\n```\n- [CR-001] (blocking) (open) [x] h\n```").ok, false)
})
t("N: VERDICT-ISSUES 사이 prose → error, commit false", () => {
  const p = pr("VERDICT: APPROVE\nBlocking issue: auth bypass is unaddressed\nISSUES: []")
  assert.equal(p.ok, false); assert.equal(mergeLedger({}, p, NS).committed, false)
})
t("N: outer fence 미닫힘 → error", () => {
  assert.equal(pr("```\nVERDICT: APPROVE\nISSUES: []").ok, false)
})
t("P: 전체 outer fence로 감싼 응답 정상 parse", () => {
  assert.equal(pr("```text\nVERDICT: APPROVE\nISSUES: []\n```").ok, true)
  const p = pr("```\nVERDICT: REJECT\nISSUES:\n- [CR-001] (blocking) (open) [auth.ts:42] 문제\n```")
  assert.equal(p.ok, true); assert.equal(p.issues.length, 1)
})
t("N: null/array persisted ledger → fail-closed", () => {
  assert.ok(validateLedger([], NS).length > 0)
  assert.ok(validateLedger(null, NS).length > 0)
  assert.equal(mergeLedger(null, pr("VERDICT: APPROVE\nISSUES: []"), NS).committed, false)
})
t("N: whitespace-only location/text → 검증 오류", () => {
  const bad = { "CR-001": { id: "CR-001", blocking: true, status: "open", location: "   ", text: "   " } }
  assert.ok(validateLedger(bad, NS).length > 0)
})

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
