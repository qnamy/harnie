// loop.mjs 테스트 — 신규 로직인 상태 전이(computeTransition) + apply CLI end-to-end 배선.
// delta/ledger 자체는 각 파일 테스트가 커버 → 여기선 조합·상태머신·CLI 계약만.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { computeTransition } from "./loop.mjs"
import { captureTree } from "./delta.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, "loop.mjs")

// merged 결과를 흉내내는 최소 헬퍼(mergeLedger 계약 필드만).
const merged = (over) => ({ committed: true, gateProgress: false, prevOpenBlocking: 1, newOpenBlocking: 1, protocolViolations: [], ledger: {}, ...over })

test("computeTransition: APPROVE → APPROVED (round 무관)", () => {
  const s = computeTransition({ round: 3, stagnation: 2 }, merged({ newOpenBlocking: 0 }), "APPROVE")
  assert.equal(s.machineState, "APPROVED")
})

test("computeTransition: 첫 리뷰 REJECT → REVISING, stagnation 0 유지(카운트 시작 전)", () => {
  const s = computeTransition({ round: 0, stagnation: 0 }, merged(), "REJECT")
  assert.equal(s.machineState, "REVISING")
  assert.equal(s.stagnation, 0)
  assert.equal(s.round, 1)
})

test("computeTransition: gate progress(count 감소) → REVISING, stagnation reset", () => {
  const s = computeTransition({ round: 2, stagnation: 2 }, merged({ gateProgress: true, prevOpenBlocking: 2, newOpenBlocking: 1 }), "REJECT")
  assert.equal(s.machineState, "REVISING")
  assert.equal(s.stagnation, 0)
})

test("computeTransition: no progress → stagnation 증가, limit 미만이면 REVISING", () => {
  const s = computeTransition({ round: 1, stagnation: 0 }, merged(), "REJECT", { limit: 3 })
  assert.equal(s.machineState, "REVISING")
  assert.equal(s.stagnation, 1)
})

test("computeTransition: no progress로 stagnation이 limit 도달 → STALLED", () => {
  const s = computeTransition({ round: 3, stagnation: 2 }, merged(), "REJECT", { limit: 3 })
  assert.equal(s.machineState, "STALLED")
  assert.equal(s.stagnation, 3)
})

test("computeTransition: 정성 progress(--progress yes)면 count 불변이어도 stagnation reset", () => {
  const s = computeTransition({ round: 2, stagnation: 2 }, merged(), "REJECT", { progressFlag: "yes" })
  assert.equal(s.machineState, "REVISING")
  assert.equal(s.stagnation, 0)
})

// ── apply CLI end-to-end ──────────────────────────────────────────────
const SHA40 = "0123456789abcdef0123456789abcdef01234567"
// apply는 review-unit 구조(ledger.json·state.json·round-N.txt 같은 dir) + active repo(--root, git) + CR artifact=현재 tree를 강제.
// base = git repo, unit dir = <base>/.harnie/review/<tag>. 표준 파일명 사용.
function tmpBase() {
  const b = mkdtempSync(join(tmpdir(), "harnie-loop-"))
  execFileSync("git", ["-C", b, "init", "-q"])
  execFileSync("git", ["-C", b, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", b, "config", "user.name", "t"])
  return b
}
function unitOf(base, tag = "u") { const d = join(base, ".harnie", "review", tag); mkdirSync(d, { recursive: true }); return d }
function tmpUnit(tag = "u") { return unitOf(tmpBase(), tag) }
function rootOf(p) { return p.split("/.harnie/")[0] }
// apply는 --root·(CR)--artifact 필수 → 테스트 편의 주입(그 인자 자체를 검증하는 케이스는 runRaw/runFailRaw).
function withDefaults(args) {
  if (args[0] !== "apply") return args
  let a = args
  const li = a.indexOf("--ledger"); const lp = li >= 0 ? a[li + 1] : null
  const root = lp && lp.includes("/.harnie/") ? rootOf(lp) : null
  if (!a.includes("--root") && root) a = [...a, "--root", root]
  if (a.includes("--ns") && a[a.indexOf("--ns") + 1] === "CR" && !a.includes("--artifact") && root) a = [...a, "--artifact", captureTree(root)]
  return a
}
function runRaw(args) { return JSON.parse(execFileSync("node", [CLI, ...args], { encoding: "utf8" })) }
function run(args) { return runRaw(withDefaults(args)) }
// 표준 review-unit 파일 경로.
const L = (d) => join(d, "ledger.json")
const S = (d) => join(d, "state.json")
const R = (d, n = 1) => join(d, `round-${n}.txt`)

test("apply CLI: 첫 REJECT 리뷰 → ledger·state 생성, REVISING", () => {
  const dir = tmpUnit()
  writeFileSync(R(dir), ["VERDICT: REJECT", "ISSUES:", "- [CR-001] (blocking) (open) [auth.ts:42] 만료 미검증 → 만료 경로 없음 → 체크 추가"].join("\n"))
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)])
  assert.equal(r.committed, true)
  assert.equal(r.machineState, "REVISING")
  assert.equal(r.openBlocking, 1)
  assert.deepEqual(r.openIds, ["CR-001"])
  assert.equal(JSON.parse(readFileSync(L(dir), "utf8"))["CR-001"].status, "open")
  assert.equal(JSON.parse(readFileSync(S(dir), "utf8")).round, 1)
})

test("apply CLI: verdict 불일치(APPROVE인데 open blocking) → needsReRequest, ledger 미생성", () => {
  const dir = tmpUnit()
  writeFileSync(R(dir), ["VERDICT: APPROVE", "ISSUES:", "- [CR-001] (blocking) (open) [x.ts:1] 문제 → 왜 → 수정"].join("\n"))
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)])
  assert.equal(r.committed, false)
  assert.equal(r.needsReRequest, true)
  assert.equal(existsSync(L(dir)), false) // 롤백
})

test("apply CLI: 2라운드 — blocker 해소 후 APPROVE로 승인", () => {
  const dir = tmpUnit()
  writeFileSync(R(dir, 1), ["VERDICT: REJECT", "ISSUES:", "- [CR-001] (blocking) (open) [a.ts:1] x → y → z"].join("\n"))
  run(["apply", "--ledger", L(dir), "--review", R(dir, 1), "--ns", "CR", "--state", S(dir)])
  writeFileSync(R(dir, 2), ["VERDICT: APPROVE", "ISSUES:", "- [CR-001] (blocking) (resolved) [a.ts:1] 반영됨"].join("\n"))
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir, 2), "--ns", "CR", "--state", S(dir)])
  assert.equal(r.machineState, "APPROVED")
  assert.equal(r.openBlocking, 0)
})

// ── 컨텍스트 예산 advisory: APPROVED 시 완료 유닛 카운트·세션 분할 권장 ──
test("apply CLI: APPROVED면 completedUnits 포함, 4의 배수째 유닛에서 sessionSplitRecommended", () => {
  const base = tmpBase()
  const APPROVE = ["VERDICT: APPROVE", "ISSUES: []"].join("\n")
  // 형제 유닛 3개를 이미 APPROVED로 배치
  for (const tag of ["u1", "u2", "u3"]) {
    const d = unitOf(base, tag)
    writeFileSync(S(d), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", lastVerdict: "APPROVE", openBlocking: 0 }))
    writeFileSync(L(d), "{}")
  }
  const dir = unitOf(base, "u4")
  writeFileSync(R(dir), APPROVE)
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)])
  assert.equal(r.machineState, "APPROVED")
  assert.equal(r.completedUnits, 4)
  assert.equal(r.sessionSplitRecommended, true)
  // 5번째 유닛은 카운트만 오르고 권장은 꺼진다
  const dir5 = unitOf(base, "u5")
  writeFileSync(R(dir5), APPROVE)
  const r5 = run(["apply", "--ledger", L(dir5), "--review", R(dir5), "--ns", "CR", "--state", S(dir5)])
  assert.equal(r5.completedUnits, 5)
  assert.equal(r5.sessionSplitRecommended, false)
})

test("apply CLI: APPROVED 아니면(REVISING) completedUnits 미포함", () => {
  const dir = tmpUnit()
  writeFileSync(R(dir), ["VERDICT: REJECT", "ISSUES:", "- [CR-001] (blocking) (open) [a.ts:1] x → y → z"].join("\n"))
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)])
  assert.equal(r.machineState, "REVISING")
  assert.equal("completedUnits" in r, false)
  assert.equal("sessionSplitRecommended" in r, false)
})

// ── export: .harnie 산출물 읽기 전용 반출 ─────────────────────────────
test("export CLI: .harnie 하위 파일을 stdout·--out으로 반출", () => {
  const base = tmpBase()
  const designDir = join(base, ".harnie", "plan", "feat-x", "design")
  mkdirSync(designDir, { recursive: true })
  writeFileSync(join(designDir, "rev-3.md"), "# 설계 rev-3\n본문")
  const stdout = execFileSync("node", [CLI, "export", base, "plan/feat-x/design/rev-3.md"], { encoding: "utf8" })
  assert.equal(stdout, "# 설계 rev-3\n본문")
  const dest = join(base, "exported-design.md")
  const r = JSON.parse(execFileSync("node", [CLI, "export", base, "plan/feat-x/design/rev-3.md", "--out", dest], { encoding: "utf8" }))
  assert.equal(r.ok, true)
  assert.equal(readFileSync(dest, "utf8"), "# 설계 rev-3\n본문")
})

test("export CLI: traversal로 .harnie 밖 읽기 거부, --out으로 .harnie 안 쓰기 거부, 부재 파일 die", () => {
  const base = tmpBase()
  const designDir = join(base, ".harnie", "plan", "feat-x", "design")
  mkdirSync(designDir, { recursive: true })
  writeFileSync(join(designDir, "rev-1.md"), "x")
  writeFileSync(join(base, "secret.txt"), "밖")
  assert.notEqual(runFailRaw(["export", base, "../secret.txt"]), 0)                                        // .harnie 밖 읽기
  assert.notEqual(runFailRaw(["export", base, "plan/feat-x/design/rev-1.md", "--out", join(base, ".harnie", "plan", "feat-x", "design", "rev-2.md")]), 0) // .harnie 안 쓰기
  assert.notEqual(runFailRaw(["export", base, "plan/feat-x/design/rev-9.md"]), 0)                          // 부재
})

// ── 입력 검증 + STALLED 래치 + 명시적 재진입 ──────────────────────────
function runFailRaw(args) {
  try { execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: "pipe" }); return 0 }
  catch (e) { return e.status }
}
function runFail(args) { return runFailRaw(withDefaults(args)) }

test("delta CLI: --out으로 harnie control 파일 덮어쓰기 거부", () => {
  const root = tmpBase()
  assert.equal(runFailRaw(["delta", root, captureTree(root), "--out", join(root, ".harnie", "active.json")]), 2)
  assert.equal(existsSync(join(root, ".harnie", "active.json")), false)
})

const REJ = ["VERDICT: REJECT", "ISSUES:", "- [CR-001] (blocking) (open) [a.ts:1] x → y → z"].join("\n")
const APPROVE = ["VERDICT: APPROVE", "ISSUES:", "- [CR-001] (blocking) (resolved) [a.ts:1] 반영됨"].join("\n")
// APPROVE(=CR-001 resolved)를 받을 수 있는 진행 중 ledger — 미지 ID를 resolved로 제출하면 rollback되므로.
const LEDGER_OPEN_CR001 = JSON.stringify({ "CR-001": { id: "CR-001", blocking: true, status: "open", location: "a.ts:1", text: "x" } })

// limit 1로 STALLED 도달. {dir} 반환(표준 파일명).
function reachStalled() {
  const dir = tmpUnit()
  writeFileSync(R(dir), REJ)
  run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--limit", "1"])
  const s = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--limit", "1"])
  assert.equal(s.machineState, "STALLED")
  return { dir }
}

test("apply CLI: --state 없으면 die (래치는 지속 상태를 요구 — 우회 경로 차단)", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR"]), 2)
})

test("apply CLI: --limit이 양의 정수가 아니면 die (STALLED 게이트 무력화 방지)", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  const base = ["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]
  assert.equal(runFail([...base, "--limit", "bad"]), 2)
  assert.equal(runFail([...base, "--limit", "0"]), 2)
  assert.equal(runFail([...base, "--limit", "-1"]), 2)
})

test("apply CLI: 잘못된 --progress / --reentry 값은 die", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  const base = ["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]
  assert.equal(runFail([...base, "--progress", "maybe"]), 2)
  assert.equal(runFail([...base, "--reentry", "because"]), 2)
})

test("apply CLI: 중복 플래그는 last value 사용", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--limit", "bad", "--limit", "1"])
  assert.equal(r.committed, true)
})

test("apply CLI: STALLED 후 --state 생략으로 우회 불가(die, 커밋 안 됨)", () => {
  const { dir } = reachStalled()
  writeFileSync(R(dir), APPROVE)
  const ledgerBefore = readFileSync(L(dir), "utf8"), stateBefore = readFileSync(S(dir), "utf8")
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR"]), 2)
  assert.equal(readFileSync(L(dir), "utf8"), ledgerBefore)
  assert.equal(readFileSync(S(dir), "utf8"), stateBefore)
})

test("apply CLI: 기존 state.json에 machineState 없으면 die(손상 — round0 위장 우회 차단)", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  writeFileSync(L(dir), "{}")
  writeFileSync(S(dir), JSON.stringify({ round: 2, stagnation: 3 }))
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]), 2)
})

test("apply CLI: state 파일 부재는 정당한 초기(round 0)로 정상 진행", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)])
  assert.equal(r.committed, true)
  assert.equal(r.machineState, "REVISING")
})

test("apply CLI: STALLED에서 --reentry 없으면 needsReentry, ledger·state 불변", () => {
  const { dir } = reachStalled()
  const ledgerBefore = readFileSync(L(dir), "utf8"), stateBefore = readFileSync(S(dir), "utf8")
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--limit", "1"])
  assert.equal(r.committed, false)
  assert.equal(r.needsReentry, true)
  assert.equal(r.machineState, "STALLED")
  assert.equal(readFileSync(L(dir), "utf8"), ledgerBefore)
  assert.equal(readFileSync(S(dir), "utf8"), stateBefore)
})

test("apply CLI: STALLED에서 progress/APPROVE여도 --reentry 없으면 자동 해제 안 됨(needsReentry)", () => {
  const { dir } = reachStalled()
  writeFileSync(R(dir), APPROVE)
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--limit", "1"])
  assert.equal(r.needsReentry, true)
  assert.notEqual(r.machineState, "APPROVED")
})

test("apply CLI: STALLED + --reentry면 해제·stagnation reset 후 적용(APPROVED)", () => {
  const { dir } = reachStalled()
  writeFileSync(R(dir), APPROVE)
  const r = run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--limit", "1", "--reentry", "new-evidence"])
  assert.equal(r.committed, true)
  assert.equal(r.machineState, "APPROVED")
  assert.equal(r.reentry, "new-evidence")
  assert.equal(JSON.parse(readFileSync(S(dir), "utf8")).reentry, "new-evidence")
})

test("apply CLI: STALLED 아닌데 --reentry면 die(오용)", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--reentry", "new-evidence"]), 2)
})

test("apply CLI: 손상된 state.json은 die (래치가 신뢰하는 machineState 보호)", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  writeFileSync(L(dir), "{}")
  writeFileSync(S(dir), JSON.stringify({ round: -1, stagnation: 0 }))
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]), 2)
  writeFileSync(S(dir), JSON.stringify({ round: 0, stagnation: 0, machineState: "BOGUS" }))
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]), 2)
})

test("apply CLI: ledger·state 존재 불일치(xor) → die(새 단위 위장 차단)", () => {
  const dir = tmpUnit(); writeFileSync(R(dir), REJ)
  run(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]) // 둘 다 생성
  const ledgerBefore = readFileSync(L(dir), "utf8")
  rmSync(S(dir)) // ledger는 있고 state만 없앰 → existsSync 불일치
  writeFileSync(R(dir, 2), APPROVE)
  assert.equal(runFail(["apply", "--ledger", L(dir), "--review", R(dir, 2), "--ns", "CR", "--state", S(dir)]), 2)
  assert.equal(readFileSync(L(dir), "utf8"), ledgerBefore) // 불변
})

test("apply CLI: ledger·state 부모 디렉터리 불일치 → die", () => {
  const base = tmpBase()
  const a = unitOf(base, "u1"), b = unitOf(base, "u2") // 같은 repo, 다른 unit
  writeFileSync(R(a), REJ)
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(a), "--review", R(a), "--ns", "CR", "--state", S(b), "--artifact", captureTree(base)]), 2)
})

// ── symlink 재지정: **차단하지 않는다**(의도적 결정) ──────────────────────
// 정직한 외부 경로는 assertUnderHarnie(canonical containment)가, 인자로 직접 준 unit 혼합(symlink 없이
// 서로 다른 dir 지정)은 lexical colocation이 잡는다.
// 남는 것은 의도적 symlink 재지정뿐 = 설계 §0.1의 비목표(적대적 main). 아래 두 테스트는
// "이 계층을 다시 쌓지 않는다"를 고정한다 — die로 바뀌면 계층이 재도입된 것이다.
test("apply CLI: ledger·state·review 셋 다 stale unit으로 symlink → 차단하지 않음(§0.1 비목표)", () => {
  const base = tmpBase()
  const active = unitOf(base, "u1"), stale = unitOf(base, "stale")
  writeFileSync(join(stale, "ledger.json"), LEDGER_OPEN_CR001)
  writeFileSync(join(stale, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "REVISING" }))
  writeFileSync(join(stale, "round-1.txt"), APPROVE)
  // active unit u1의 세 경로를 모두 stale의 동명 파일로 symlink
  symlinkSync(join(stale, "ledger.json"), L(active))
  symlinkSync(join(stale, "state.json"), S(active))
  symlinkSync(join(stale, "round-1.txt"), R(active))
  const r = runRaw(["apply", "--root", base, "--ledger", L(active), "--review", R(active), "--ns", "CR", "--state", S(active), "--artifact", captureTree(base)])
  assert.equal(r.committed, true)
  // 쓰기는 symlink를 따라 stale unit에 적용된다(차단 없음).
  assert.equal(JSON.parse(readFileSync(join(stale, "state.json"), "utf8")).machineState, "APPROVED")
})

test("apply CLI: state만 다른 unit의 state.json으로 symlink → 차단하지 않음(§0.1 비목표)", () => {
  const base = tmpBase()
  const dir = unitOf(base, "u1"), other = unitOf(base, "u2")
  // other unit에 진행 중 상태(round 1) 심기
  writeFileSync(join(other, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "REVISING" }))
  writeFileSync(join(other, "ledger.json"), "{}")
  // active unit(u1): ledger는 진행 중, state.json은 u2의 state.json으로 symlink
  writeFileSync(L(dir), LEDGER_OPEN_CR001)
  symlinkSync(join(other, "state.json"), S(dir))
  writeFileSync(R(dir), APPROVE)
  const r = runRaw(["apply", "--root", base, "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--artifact", captureTree(base)])
  assert.equal(r.committed, true)
  assert.equal(JSON.parse(readFileSync(join(other, "state.json"), "utf8")).machineState, "APPROVED")
})

test("apply CLI: review가 symlink으로 외부 APPROVE 파일을 가리키면 die(canonical containment)", () => {
  const base = tmpBase(); const dir = unitOf(base)
  const outside = mkdtempSync(join(tmpdir(), "harnie-ext-"))
  const ext = join(outside, "approve.txt"); writeFileSync(ext, APPROVE)
  symlinkSync(ext, R(dir)) // <unit>/round-1.txt → 외부 APPROVE 파일
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--artifact", captureTree(base)]), 2)
})

test("apply CLI: review basename이 round-N.txt 아니거나 다른 dir이면 die(unrelated review 차단)", () => {
  const base = tmpBase()
  const a = unitOf(base, "u1"), other = unitOf(base, "other")
  writeFileSync(join(a, "notreview.txt"), REJ)
  writeFileSync(R(other), REJ)
  const art = captureTree(base)
  // 잘못된 basename
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(a), "--review", join(a, "notreview.txt"), "--ns", "CR", "--state", S(a), "--artifact", art]), 2)
  // 다른 unit의 review
  writeFileSync(R(a), REJ)
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(a), "--review", R(other), "--ns", "CR", "--state", S(a), "--artifact", art]), 2)
})

// ── --artifact <postSHA> ────────────────────────────────────────────────
test("apply CLI: CR --artifact는 현재 tree여야 하고 reviewedPostSHA로 기록됨", () => {
  const base = tmpBase(); const dir = unitOf(base); writeFileSync(R(dir), REJ)
  const tree = captureTree(base)
  runRaw(["apply", "--root", base, "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--artifact", tree])
  assert.equal(JSON.parse(readFileSync(S(dir), "utf8")).reviewedPostSHA, tree)
})

test("apply CLI: CR artifact가 현재 tree와 불일치(stale/임의 SHA) → die (quick의 유일 게이트)", () => {
  const base = tmpBase(); const dir = unitOf(base); writeFileSync(R(dir), REJ)
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--artifact", SHA40]), 2)
})

test("apply CLI: CR은 --artifact 필수, --root 필수", () => {
  const base = tmpBase(); const dir = unitOf(base); writeFileSync(R(dir), REJ)
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir)]), 2) // artifact 누락
  assert.equal(runFailRaw(["apply", "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--artifact", captureTree(base)]), 2) // root 누락
})

test("apply CLI: --artifact는 DR에서 금지, 잘못된 형식은 die", () => {
  const base = tmpBase()
  const dr = unitOf(base, "dr"); writeFileSync(R(dr), ["VERDICT: REJECT", "ISSUES:", "- [DR-001] (blocking) (open) [x] a → b → c"].join("\n"))
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(dr), "--review", R(dr), "--ns", "DR", "--state", S(dr), "--artifact", captureTree(base)]), 2) // DR 금지
  const fmt = unitOf(base, "fmt"); writeFileSync(R(fmt), REJ)
  assert.equal(runFailRaw(["apply", "--root", base, "--ledger", L(fmt), "--review", R(fmt), "--ns", "CR", "--state", S(fmt), "--artifact", "nothex"]), 2) // 형식
})

test("apply CLI: ledger/state가 .harnie 밖(소스 경로) → die", () => {
  const outside = mkdtempSync(join(tmpdir(), "harnie-src-"))
  execFileSync("git", ["-C", outside, "init", "-q"]); execFileSync("git", ["-C", outside, "config", "user.email", "t@t"]); execFileSync("git", ["-C", outside, "config", "user.name", "t"])
  writeFileSync(join(outside, "round-1.txt"), REJ)
  assert.equal(runFailRaw(["apply", "--root", outside, "--ledger", join(outside, "ledger.json"), "--review", join(outside, "round-1.txt"), "--ns", "CR", "--state", join(outside, "state.json"), "--artifact", captureTree(outside)]), 2)
})

test("apply CLI: symlink으로 active .harnie 밖 탈출 → die (canonical containment)", () => {
  const base = mkdtempSync(join(tmpdir(), "harnie-sym-"))
  const outside = mkdtempSync(join(tmpdir(), "harnie-out-"))
  mkdirSync(join(base, ".harnie"), { recursive: true })
  symlinkSync(outside, join(base, ".harnie", "link")) // .harnie/link → 외부
  writeFileSync(join(base, "round-1.txt"), REJ)
  assert.equal(runFailRaw([
    "apply", "--root", base, "--ledger", join(base, ".harnie", "link", "ledger.json"), "--review", join(base, "round-1.txt"),
    "--ns", "CR", "--state", join(base, ".harnie", "link", "state.json"), "--artifact", SHA40,
  ]), 2)
})

test("apply CLI: --ledger traversal(.harnie/../src) → die", () => {
  const base = mkdtempSync(join(tmpdir(), "harnie-trav-"))
  writeFileSync(join(base, "round-1.txt"), REJ)
  assert.equal(runFailRaw([
    "apply", "--root", base, "--ledger", join(base, ".harnie", "..", "src", "ledger.json"), "--review", join(base, "round-1.txt"),
    "--ns", "CR", "--state", join(base, ".harnie", "..", "src", "state.json"), "--artifact", SHA40,
  ]), 2)
})

// ── 워크스페이스 run root(비-git, active.json에 workspaceRoot·repos) ──
function workspaceRunRoot() {
  const w = mkdtempSync(join(tmpdir(), "harnie-loop-ws-"))
  const repo = join(w, "repoA")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", repo, "config", "user.name", "t"])
  writeFileSync(join(repo, "a.txt"), "a\n")
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"])
  const runRoot = join(w, ".harnie-wt", "harnie-ws")
  mkdirSync(join(runRoot, ".harnie"), { recursive: true })
  writeFileSync(join(runRoot, ".harnie", "active.json"), JSON.stringify({
    track: "plan", slug: "ws", planHash: null, readOnlyThreads: [],
    workspaceRoot: w, repos: { repoA: { repo, workroot: repo } },
  }) + "\n")
  return { w, repo, runRoot }
}

test("capture: workspace run root → ws:<sha256> 합성 아티팩트, 멤버 변경에 반응", () => {
  const { repo, runRoot } = workspaceRunRoot()
  const r1 = runRaw(["capture", runRoot])
  assert.match(r1.baselineSHA, /^ws:[0-9a-f]{64}$/)
  writeFileSync(join(repo, "a.txt"), "a\nCHANGED\n")
  const r2 = runRaw(["capture", runRoot])
  assert.notEqual(r2.baselineSHA, r1.baselineSHA)
})

test("capture: 비-git·비-workspace 디렉터리 → die / delta: workspace run root → die", () => {
  const plain = mkdtempSync(join(tmpdir(), "harnie-loop-plain-"))
  assert.equal(runFailRaw(["capture", plain]), 2)
  const { runRoot } = workspaceRunRoot()
  assert.equal(runFailRaw(["delta", runRoot, SHA40]), 2)
})

test("apply CLI: workspace run root — 합성(ws:)·멤버 repo 40-hex 아티팩트 둘 다 허용, 임의 SHA는 die", () => {
  const { repo, runRoot } = workspaceRunRoot()
  const mk = (tag, artifact) => {
    const dir = join(runRoot, ".harnie", "review", tag)
    mkdirSync(dir, { recursive: true })
    writeFileSync(R(dir), REJ)
    return ["apply", "--root", runRoot, "--ledger", L(dir), "--review", R(dir), "--ns", "CR", "--state", S(dir), "--artifact", artifact]
  }
  const wsArt = runRaw(["capture", runRoot]).baselineSHA           // 합성
  assert.equal(runRaw(mk("g", wsArt)).committed, true)             // 게이트형(합성) OK
  const memberArt = runRaw(["capture", repo]).baselineSHA          // 멤버 40-hex
  assert.equal(runRaw(mk("t", memberArt)).committed, true)         // task형(멤버) OK
  assert.equal(runFailRaw(mk("x", SHA40)), 2)                      // 임의 SHA die
})

test("capture: 등록 repo가 빈 workspace run root → die(repo-add 안내)", () => {
  const { runRoot } = workspaceRunRoot()
  writeFileSync(join(runRoot, ".harnie", "active.json"), JSON.stringify({
    track: "plan", slug: "ws", workspaceRoot: dirname(dirname(runRoot)), repos: {},
  }) + "\n")
  assert.equal(runFailRaw(["capture", runRoot]), 2)
})

// 실측 기록(관측 ⑥): 동결 manifest의 파일 수 추정 대비 실제 changedPaths를 사이드카로 남긴다.
test("delta CLI: --out 기록 시 <out>.json 사이드카에 실측 changedCount 기록", () => {
  const base = tmpBase()
  writeFileSync(join(base, "a.js"), "1")
  const baseline = captureTree(base)
  writeFileSync(join(base, "a.js"), "2")
  writeFileSync(join(base, "b.js"), "3")
  const outp = join(base, ".harnie", "review", "u", "delta.patch")
  const r = runRaw(["delta", base, baseline, "--out", outp])
  assert.equal(r.changedPaths.length, 2)
  const side = JSON.parse(readFileSync(outp + ".json", "utf8"))
  assert.equal(side.changedCount, 2)
  assert.deepEqual([...side.changedPaths].sort(), ["a.js", "b.js"])
  assert.equal(side.postSHA, r.postSHA)
  assert.deepEqual(side.outOfScope, [])
})
