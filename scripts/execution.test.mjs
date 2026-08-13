// execution.mjs 테스트 — 순수 권위 함수 + fail-closed IO 경로(init/approve/seal/verify/completion).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, execFile } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  stableStringify, computePlanHash, validateSlug, assertContainedRel,
  extractManifestBlock, validateManifest, canonicalManifest,
  deriveCompletion, sealHashOf, parseStatusFooter, FailClosed, authorityApproved,
  armApproval, recordPendingApproval, bindApproval, registerBuilderThread, registerReadonlyThread,
  bootstrapRun, slugify, withStateLock, writePendingRoute, clearPendingRoute, hasPendingRoute, getRouteState, markRouteFailed,
  loadContext,
} from "./execution.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, "execution.mjs")

// ── 순수 함수 ────────────────────────────────────────────────────────────
test("stableStringify: 키 순서 무관 동일", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.equal(stableStringify({ a: [3, { y: 1, x: 2 }] }), '{"a":[3,{"x":2,"y":1}]}')
})

test("computePlanHash: 안정적, 내용 변하면 달라짐", () => {
  const m = { tasks: [], gates: [] }
  assert.equal(computePlanHash("plan A", m), computePlanHash("plan A", m))
  assert.notEqual(computePlanHash("plan A", m), computePlanHash("plan B", m))
})

test("validateSlug: traversal·형식 차단", () => {
  assert.equal(validateSlug("my-slug_1.2"), "my-slug_1.2")
  assert.throws(() => validateSlug(".."), FailClosed)
  assert.throws(() => validateSlug("."), FailClosed)
  assert.throws(() => validateSlug("a/b"), FailClosed)
  assert.throws(() => validateSlug("a b"), FailClosed)
})

test("assertContainedRel: 상위 traversal·절대경로 차단", () => {
  assert.equal(assertContainedRel("src/x", "scope"), "src/x")
  assert.throws(() => assertContainedRel("../x", "scope"), FailClosed)
  assert.throws(() => assertContainedRel("a/../../b", "scope"), FailClosed)
  assert.throws(() => assertContainedRel("/etc/passwd", "scope"), FailClosed)
})

const GATES = [
  { name: "coverage", reviewUnit: "final-coverage" },
  { name: "quality", reviewUnit: "final-quality" },
  { name: "runtime", reviewUnit: "final-runtime" },
  { name: "scope", reviewUnit: "final-scope" },
]
const GOOD_MANIFEST = {
  tasks: [
    { id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }] },
    { id: "T2", deps: ["T1"], reviewUnit: "task-b", scope: ["src/b/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }] },
  ],
  gates: GATES,
}

test("extractManifestBlock: harnie-manifest 펜스 파싱", () => {
  const planMd = "# Plan\n\n어쩌고\n\n```harnie-manifest\n" + JSON.stringify(GOOD_MANIFEST) + "\n```\n\n끝"
  const b = extractManifestBlock(planMd)
  assert.equal(b.tasks.length, 2)
})

test("extractManifestBlock: 블록 없으면 fail-closed", () => {
  assert.throws(() => extractManifestBlock("# Plan\n블록없음"), FailClosed)
})

test("validateManifest: 정상 통과", () => {
  assert.deepEqual(validateManifest(GOOD_MANIFEST), [])
})

test("validateManifest: reviewUnit 중복·미지 dep·빈 scope·빈 verification 탐지", () => {
  const dupUnit = { tasks: [{ id: "T1", deps: [], reviewUnit: "u", scope: ["s/"], verification: [{ executable: "x", args: [], cwd: ".", timeout: 1 }] }], gates: [{ name: "g", reviewUnit: "u" }] }
  assert.ok(validateManifest(dupUnit).some((e) => /reviewUnit 중복/.test(e)))
  const badDep = { tasks: [{ id: "T1", deps: ["NOPE"], reviewUnit: "u", scope: ["s/"], verification: [{ executable: "x", args: [], cwd: ".", timeout: 1 }] }], gates: [] }
  assert.ok(validateManifest(badDep).some((e) => /미지 task/.test(e)))
  const emptyScope = { tasks: [{ id: "T1", deps: [], reviewUnit: "u", scope: [], verification: [{ executable: "x", args: [], cwd: ".", timeout: 1 }] }], gates: [] }
  assert.ok(validateManifest(emptyScope).some((e) => /scope 비어있지/.test(e)))
  const emptyVer = { tasks: [{ id: "T1", deps: [], reviewUnit: "u", scope: ["s/"], verification: [] }], gates: [] }
  assert.ok(validateManifest(emptyVer).some((e) => /verification 비어있지/.test(e)))
  const traversal = { tasks: [{ id: "T1", deps: [], reviewUnit: "u", scope: ["../x"], verification: [{ executable: "x", args: [], cwd: ".", timeout: 1 }] }], gates: [] }
  assert.ok(validateManifest(traversal).some((e) => /traversal/.test(e)))
})

test("validateManifest: Final Wave 4게이트 강제(누락·추가 거부)", () => {
  const oneTask = [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["s/"], verification: [{ executable: "x", args: [], cwd: ".", timeout: 1 }] }]
  assert.ok(validateManifest({ tasks: oneTask, gates: [{ name: "coverage", reviewUnit: "g1" }] }).some((e) => /게이트 누락/.test(e)))
  assert.ok(validateManifest({ tasks: oneTask, gates: [] }).some((e) => /게이트 누락/.test(e)))
  const extra = [...GATES, { name: "extra", reviewUnit: "final-extra" }]
  assert.ok(validateManifest({ tasks: oneTask, gates: extra }).some((e) => /규약 외 게이트/.test(e)))
  // 정확히 4종이면 통과
  assert.deepEqual(validateManifest({ tasks: oneTask, gates: GATES }), [])
})

// deriveCompletion snapshot 헬퍼. task: 현재 scope == receipt.scopeHash. gate: reviewedPostSHA == currentWholeTree.
const WT = "wholetree0000000000000000000000000000000"
const okTask = (over = {}) => ({ openBlocking: 0, machineState: "APPROVED", receipt: { exitCode: 0, planHash: "PH", scopeHash: "SH" }, expectedScopeHash: "SH", currentScopeHash: "SH", ...over })
const okGate = (over = {}) => ({ openBlocking: 0, machineState: "APPROVED", reviewedPostSHA: WT, ...over })
const okSnap = () => ({ planHash: "PH", currentWholeTree: WT, units: { "task-a": okTask(), "task-b": okTask(), "final-coverage": okGate(), "final-quality": okGate(), "final-runtime": okGate(), "final-scope": okGate() } })

test("deriveCompletion: 전부 승인·검증 통과·현재 tree 일치 → complete", () => {
  const r = deriveCompletion(GOOD_MANIFEST, okSnap())
  assert.equal(r.complete, true, r.blockers.join("; "))
})

test("deriveCompletion: open blocking·미승인·receipt 없음·gate 미승인 각각 blocker", () => {
  const openBlk = okSnap(); openBlk.units["task-a"].openBlocking = 1; openBlk.units["task-a"].machineState = "REVISING"
  assert.equal(deriveCompletion(GOOD_MANIFEST, openBlk).complete, false)

  const noReceipt = okSnap(); noReceipt.units["task-b"].receipt = null
  assert.ok(deriveCompletion(GOOD_MANIFEST, noReceipt).blockers.some((b) => /receipt 없음/.test(b)))

  const gateOpen = okSnap(); gateOpen.units["final-runtime"].machineState = "REVISING"
  assert.ok(deriveCompletion(GOOD_MANIFEST, gateOpen).blockers.some((b) => /gate runtime/.test(b)))

  const ledgerGone = okSnap(); ledgerGone.units["task-a"] = { openBlocking: null }
  assert.ok(deriveCompletion(GOOD_MANIFEST, ledgerGone).blockers.some((b) => /ledger 없음\/손상/.test(b)))
})

test("deriveCompletion: 리뷰 후 코드 변경 → 현재 tree 불일치로 미완료(핵심 바인딩)", () => {
  // task scope가 리뷰 tree와 달라짐
  const taskChanged = okSnap(); taskChanged.units["task-a"].currentScopeHash = "MOVED"
  assert.ok(deriveCompletion(GOOD_MANIFEST, taskChanged).blockers.some((b) => /리뷰\/검증 후 변경/.test(b)))
  // Final Wave 후 전체 tree가 달라짐
  const treeChanged = okSnap(); treeChanged.currentWholeTree = "MOVEDTREE00000000000000000000000000000000"
  const r = deriveCompletion(GOOD_MANIFEST, treeChanged)
  assert.ok(r.blockers.some((b) => /게이트 리뷰 후 코드 변경/.test(b)))
})

test("deriveCompletion: manifest 순회 — units에서 task 삭제해도 blocker(위조 무력)", () => {
  const snap = { planHash: "PH", currentWholeTree: WT, units: { "final-coverage": okGate(), "final-quality": okGate(), "final-runtime": okGate(), "final-scope": okGate() } }
  const r = deriveCompletion(GOOD_MANIFEST, snap)
  assert.equal(r.complete, false)
  assert.ok(r.blockers.some((b) => /task T1/.test(b)))
})

test("sealHashOf: 순서 무관·변경 탐지", () => {
  const a = [{ path: "x", content: "1" }, { path: "y", content: "2" }]
  const b = [{ path: "y", content: "2" }, { path: "x", content: "1" }]
  assert.equal(sealHashOf(a), sealHashOf(b))
  const c = [{ path: "x", content: "CHANGED" }, { path: "y", content: "2" }]
  assert.notEqual(sealHashOf(a), sealHashOf(c))
})

test("parseStatusFooter: COMPLETE|INCOMPLETE 파싱, 부재", () => {
  assert.deepEqual(parseStatusFooter("작업 끝.\nHARNIE_STATUS: COMPLETE"), { present: true, status: "COMPLETE", detail: "" })
  const inc = parseStatusFooter("보고.\nHARNIE_STATUS: INCOMPLETE — task T2 미검증")
  assert.equal(inc.status, "INCOMPLETE")
  assert.ok(/T2/.test(inc.detail))
  assert.equal(parseStatusFooter("footer 없음").present, false)
})

// ── CLI e2e ──────────────────────────────────────────────────────────────
function run(args, opts = {}) {
  const res = execFileSync("node", [CLI, ...args], { encoding: "utf8", ...opts })
  return JSON.parse(res)
}
function runFail(args) {
  try { execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: "pipe" }); return null }
  catch (e) { return e }
}
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "harnie-exec-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", root, "config", "user.name", "t"])
  return root
}
function writePlan(root, slug, manifest = GOOD_MANIFEST) {
  const dir = join(root, ".harnie", "plan", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "plan.md"), "# Plan\n\n```harnie-manifest\n" + JSON.stringify(manifest, null, 2) + "\n```\n")
  return dir
}
// 승인 흐름: arm(A5, 질문·옵션 고정) → pending(질문/옵션 대조) → bindApproval(그 질문의 선택값 정확 일치).
const AQ = "이 계획을 실행할까요?"
function approveFlow(root, slug = "feat-x", tuid = "tu-1") {
  armApproval(root, slug, { question: AQ, approveOption: "승인" })
  recordPendingApproval(root, slug, tuid, AQ, ["승인", "거절·수정"])
  return bindApproval(root, slug, tuid, { answers: { [AQ]: "승인" } })
}

test("init: sentinel-first 부트스트랩", () => {
  const root = gitRepo()
  const r = run(["init", "--root", root, "--track", "plan", "--slug", "feat-x"])
  assert.equal(r.phase, "planning")
  assert.ok(existsSync(join(root, ".harnie", "active.json")))
  assert.ok(existsSync(join(root, ".harnie", "plan", "feat-x", "execution.json")))
})

test("init: sentinel 있는데 execution.json 부재 → fail-closed", () => {
  const root = gitRepo()
  run(["init", "--root", root, "--slug", "feat-x"])
  rmSync(join(root, ".harnie", "plan", "feat-x", "execution.json"))
  const e = runFail(["init", "--root", root, "--slug", "feat-x"])
  assert.ok(e && /execution.json 부재/.test(e.stderr))
})

test("init: 다른 활성 slug 존재 → fail-closed", () => {
  const root = gitRepo()
  run(["init", "--root", root, "--slug", "feat-x"])
  const e = runFail(["init", "--root", root, "--slug", "feat-y"])
  assert.ok(e && /다른 활성 단위/.test(e.stderr))
})

test("init: 중복 플래그는 die(다른 repo/slug 위장 차단 — init 전 훅 보호 불가)", () => {
  const root = gitRepo()
  assert.ok(runFail(["init", "--root", root, "--slug", "feat-x", "--root", root, "--slug", "feat-x"]))
})

test("init: slug traversal 차단", () => {
  const root = gitRepo()
  assert.ok(runFail(["init", "--root", root, "--slug", ".."]))
})

test("승인 바인딩(함수): arm→pending → approve → executing + immutable manifest", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const p = armApproval(root, "feat-x", { question: AQ, approveOption: "승인" })
  recordPendingApproval(root, "feat-x", "tu-1", AQ, ["승인", "거절·수정"])
  const a = bindApproval(root, "feat-x", "tu-1", { answers: { [AQ]: "승인" } })
  assert.equal(a.phase, "executing")
  assert.equal(a.planHash, p.planHash)
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).planHash, p.planHash)
})

test("arm-approval: --question 없으면 실패(질문 바인딩 필수)", () => {
  const root = gitRepo(); writePlan(root, "feat-x"); run(["init", "--root", root, "--slug", "feat-x"])
  assert.equal(armApproval(root, "feat-x", {}).ok, false)           // 함수
  assert.ok(runFail(["arm-approval", "--root", root, "--slug", "feat-x"])) // CLI
})

test("승인 바인딩: 다른 질문의 '승인' 답은 오연결되지 않음(질문 키 조회)", () => {
  const root = gitRepo(); writePlan(root, "feat-x"); run(["init", "--root", root, "--slug", "feat-x"])
  armApproval(root, "feat-x", { question: AQ, approveOption: "승인" })
  recordPendingApproval(root, "feat-x", "tu-1", AQ, ["승인", "거절"])
  // 다중 질문: 승인 질문엔 "거절", 다른 질문에 "승인" → 평탄화하면 오판, 키 조회면 거절
  const r = bindApproval(root, "feat-x", "tu-1", { answers: { [AQ]: "거절", "배포 승인?": "승인" } })
  assert.equal(r.ok, false)
})

test("승인·등록은 CLI로 노출 안 됨(self-승인·thread 위조 차단)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  // sanctioned Bash로 self-승인 시도 → 서브커맨드 부재로 die
  assert.ok(runFail(["approve", "--root", root, "--slug", "feat-x", "--tool-use-id", "x", "--approved", "true"]))
  assert.ok(runFail(["pending-approval", "--root", root, "--slug", "feat-x", "--tool-use-id", "x"]))
  assert.ok(runFail(["register-builder", "--root", root, "--slug", "feat-x", "--task", "T1", "--thread-id", "z"]))
  assert.ok(runFail(["register-readonly", "--root", root, "--slug", "feat-x", "--thread-id", "z"]))
  assert.ok(!existsSync(join(root, ".harnie", "plan", "feat-x", "manifest.json"))) // 승인 안 됨
})

test("recordPendingApproval(함수): arm 없으면 no-op(A5 아닌 질문 오-바인딩 차단)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  assert.equal(recordPendingApproval(root, "feat-x", "tu-1").ok, false)
})

test("승인 바인딩(함수): 거절·tool_use_id 불일치·질문후 plan 변경 → executing 안 됨", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const armR = () => { armApproval(root, "feat-x", { question: AQ, approveOption: "승인" }) }
  // 거절(선택값 "거절·수정")
  armR(); recordPendingApproval(root, "feat-x", "tu-1", AQ, ["승인", "거절·수정"])
  assert.equal(bindApproval(root, "feat-x", "tu-1", { answers: { [AQ]: "거절·수정" } }).ok, false)
  // tool_use_id 불일치(pending 보존)
  armR(); recordPendingApproval(root, "feat-x", "tu-2", AQ, ["승인", "거절·수정"])
  assert.equal(bindApproval(root, "feat-x", "WRONG", { answers: { [AQ]: "승인" } }).ok, false)
  // 질문 후 plan.md 변경 → planHash 불일치
  writeFileSync(join(dir, "plan.md"), readFileSync(join(dir, "plan.md"), "utf8") + "\n변경됨\n")
  assert.equal(bindApproval(root, "feat-x", "tu-2", { answers: { [AQ]: "승인" } }).ok, false)
  assert.ok(!existsSync(join(dir, "manifest.json")))
})

test("seal / seal-verify: 권위 파일 변경 탐지", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  mkdirSync(join(dir, "review", "task-a"), { recursive: true })
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), "{}")
  run(["seal", "--root", root, "--slug", "feat-x"])
  assert.equal(run(["seal-verify", "--root", root, "--slug", "feat-x"]).sealMismatch, false)
  // 빌더가 권위 ledger를 실수로 변경
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), '{"CR-001":{"id":"CR-001"}}')
  const e = runFail(["seal-verify", "--root", root, "--slug", "feat-x"])
  assert.ok(e && e.status === 3, "seal mismatch는 exit 3")
})

test("seal: advisory(execution.json) 변경은 mismatch 아님", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  run(["seal", "--root", root, "--slug", "feat-x"])
  run(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"]) // execution.json advisory 변경
  assert.equal(run(["seal-verify", "--root", root, "--slug", "feat-x"]).sealMismatch, false)
})

test("verify: execFile로 실제 실행 + receipt(scopeHash·planHash)", () => {
  const root = gitRepo()
  // scope 파일 생성
  mkdirSync(join(root, "src", "a"), { recursive: true })
  writeFileSync(join(root, "src", "a", "x.js"), "x")
  mkdirSync(join(root, "src", "b"), { recursive: true })
  writeFileSync(join(root, "src", "b", "y.js"), "y")
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)
  // reviewedPostSHA를 state.json에 심는다(captureTree로 현재 tree)
  const treeSHA = execFileSync("node", [join(HERE, "loop.mjs"), "capture", root], { encoding: "utf8" })
  const postSHA = JSON.parse(treeSHA).baselineSHA
  mkdirSync(join(dir, "review", "task-a"), { recursive: true })
  writeFileSync(join(dir, "review", "task-a", "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  const v = run(["verify", "--root", root, "--slug", "feat-x", "--task", "T1"])
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.receipt.exitCode, 0)
  assert.equal(v.receipt.planHash.length, 64)
  assert.ok(existsSync(join(dir, "review", "task-a", "receipt.json")))
})

test("completion CLI e2e: 미완료 → blocker, 전부 채우면 complete", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true }); writeFileSync(join(root, "src", "a", "x.js"), "x")
  mkdirSync(join(root, "src", "b"), { recursive: true }); writeFileSync(join(root, "src", "b", "y.js"), "y")
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)

  // 아무 review-state 없음 → 미완료
  assert.equal(run(["completion", "--root", root, "--slug", "feat-x"]).complete, false)

  // 각 task/gate ledger·state·receipt 채우기
  const postSHA = JSON.parse(execFileSync("node", [join(HERE, "loop.mjs"), "capture", root], { encoding: "utf8" })).baselineSHA
  for (const [unit, task] of [["task-a", "T1"], ["task-b", "T2"]]) {
    const ud = join(dir, "review", unit); mkdirSync(ud, { recursive: true })
    writeFileSync(join(ud, "ledger.json"), "{}")
    writeFileSync(join(ud, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
    run(["verify", "--root", root, "--slug", "feat-x", "--task", task])
  }
  for (const g of ["final-coverage", "final-quality", "final-runtime", "final-scope"]) {
    const gd = join(dir, "review", g); mkdirSync(gd, { recursive: true })
    writeFileSync(join(gd, "ledger.json"), "{}")
    // 게이트는 전체 tree로 바인딩 → reviewedPostSHA = 현재(변경 없는) 전체 tree.
    writeFileSync(join(gd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  }

  const r = run(["completion", "--root", root, "--slug", "feat-x"])
  assert.equal(r.complete, true, r.blockers.join("; "))
})

test("completion: 검증 후 scope 파일 변경 → 미완료(현재 tree 바인딩)", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true }); writeFileSync(join(root, "src", "a", "x.js"), "x")
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)
  const postSHA = JSON.parse(execFileSync("node", [join(HERE, "loop.mjs"), "capture", root], { encoding: "utf8" })).baselineSHA
  const ud = join(dir, "review", "task-a"); mkdirSync(ud, { recursive: true })
  writeFileSync(join(ud, "ledger.json"), "{}")
  writeFileSync(join(ud, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  run(["verify", "--root", root, "--slug", "feat-x", "--task", "T1"])
  // 검증 후 scope 파일 변경 → 현재 scope ≠ 리뷰 scope
  writeFileSync(join(root, "src", "a", "x.js"), "CHANGED AFTER REVIEW")
  const r = run(["completion", "--root", root, "--slug", "feat-x"])
  assert.equal(r.complete, false)
  assert.ok(r.blockers.some((b) => /리뷰\/검증 후 변경/.test(b)), r.blockers.join("; "))
})

test("set-phase: executing 금지·closed는 완료일 때만·승인 후 역전이 금지", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true }); writeFileSync(join(root, "src", "a", "x.js"), "x")
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "executing"])) // executing 금지
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "closed"]))    // 미완료 → closed 금지
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "planning"]))  // 승인 후 역전이 금지
})

test("authorityApproved: 승인 후 plan.md 수정하면 approved=false(권위 재계산)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)
  const planHash = JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).planHash
  assert.equal(authorityApproved(dir, planHash), true)
  // 승인 후 plan.md 수정 → planHash 재계산 불일치
  writeFileSync(join(dir, "plan.md"), readFileSync(join(dir, "plan.md"), "utf8") + "\n승인 후 변경\n")
  assert.equal(authorityApproved(dir, planHash), false)
})

test("set-phase: 승인 후 plan.md 변조면 final-wave/closed 전이 die(권위 재검증)", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true }); writeFileSync(join(root, "src", "a", "x.js"), "x")
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)
  writeFileSync(join(dir, "plan.md"), readFileSync(join(dir, "plan.md"), "utf8") + "\n변조\n") // 승인 권위 깨짐
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "final-wave"]))
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "closed"]))
})

test("승인 옵션 정확 일치만 승인(질문/옵션 바인딩)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  armApproval(root, "feat-x", { question: "이 계획을 실행할까요?", approveOption: "승인" })
  // 실제 질문/옵션 대조 통과
  recordPendingApproval(root, "feat-x", "tu-1", "이 계획을 실행할까요?", ["승인", "거절·수정"])
  // 그 질문의 선택 값이 정확히 "승인" → executing
  assert.equal(bindApproval(root, "feat-x", "tu-1", { answers: { "이 계획을 실행할까요?": "승인" } }).phase, "executing")
})

test("승인 바인딩: arm 질문과 실제 질문 텍스트 불일치면 pending 미기록", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  armApproval(root, "feat-x", { question: "이 계획을 실행할까요?", approveOption: "승인" })
  // 다른 질문 텍스트 → 기록 거부
  assert.equal(recordPendingApproval(root, "feat-x", "tu-1", "배포를 승인할까요?", ["승인"]).ok, false)
})

test("register(함수): threadId 등록·재등록 금지(훅 전용, CLI 아님)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  assert.equal(registerBuilderThread(root, "feat-x", "T1", "th-b").threadId, "th-b")
  assert.throws(() => registerBuilderThread(root, "feat-x", "T1", "th-other"), FailClosed) // 다른 threadId 재등록 금지
  assert.ok(registerReadonlyThread(root, "plan", "feat-x", "th-r").readOnlyThreads.includes("th-r"))
})

// ── bootstrap (진입점 훅 소유, docs/bootstrap-adherence.md) ─────────────────
function readSentinel(root) { return JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")) }
// genuinelyComplete run 구성: init→approve→모든 task/gate ledger·state·receipt 채움(completion=true).
function makeCompleteRun(root, slug) {
  const dir = writePlan(root, slug)
  run(["init", "--root", root, "--slug", slug])
  approveFlow(root, slug)
  const postSHA = JSON.parse(execFileSync("node", [join(HERE, "loop.mjs"), "capture", root], { encoding: "utf8" })).baselineSHA
  for (const [unit, task] of [["task-a", "T1"], ["task-b", "T2"]]) {
    const ud = join(dir, "review", unit); mkdirSync(ud, { recursive: true })
    writeFileSync(join(ud, "ledger.json"), "{}")
    writeFileSync(join(ud, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
    run(["verify", "--root", root, "--slug", slug, "--task", task])
  }
  for (const g of ["final-coverage", "final-quality", "final-runtime", "final-scope"]) {
    const gd = join(dir, "review", g); mkdirSync(gd, { recursive: true })
    writeFileSync(join(gd, "ledger.json"), "{}")
    writeFileSync(join(gd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  }
  return dir
}

test("slugify: prefix-hash·결정적·한국어 지원·동일prefix 구분(P1-1)", () => {
  const s1 = slugify("Add a Subtract Function")
  assert.match(s1, /^add-a-subtract-function-[0-9a-f]{8}$/)
  assert.equal(slugify("Add a Subtract Function"), s1) // 결정적
  assert.match(slugify("a b c d e f g h"), /^a-b-c-d-e-f-[0-9a-f]{8}$/) // prefix 최대 6토큰 + hash
  // 앞 6토큰 동일·전체는 다른 작업 → hash로 구분(오인 resume 방지)
  assert.notEqual(slugify("add a new payment flow for tenant alpha"), slugify("add a new payment flow for tenant beta"))
  // 한국어(비-ASCII) → prefix 없이 hash만, 유효 slug
  const ko = slugify("로그인 버그 수정")
  assert.match(ko, /^[0-9a-f]{8}$/)
  assert.doesNotThrow(() => validateSlug(ko))
  assert.notEqual(slugify("로그인 버그 수정"), slugify("결제 버그 수정")) // 다른 한국어 작업 구분
  // 공백 정규화 → 같은 작업 = 같은 slug
  assert.equal(slugify("fix  the   bug"), slugify("fix the bug"))
  assert.equal(slugify(""), "") // 빈 작업 → 호출자 exit 2
  assert.equal(slugify("   "), "")
})

test("bootstrapRun: 신규(sentinel 없음) → run 생성·active.json base+slug·lock 정리", () => {
  const root = gitRepo()
  const r = bootstrapRun(root, { base: "feat-x" })
  assert.equal(r.slug, "feat-x")
  assert.equal(r.reused, false)
  const s = readSentinel(root)
  assert.equal(s.slug, "feat-x")
  assert.equal(s.base, "feat-x")
  assert.equal(s.track, "plan")
  assert.ok(existsSync(join(root, ".harnie", "plan", "feat-x", "execution.json")))
  assert.ok(!existsSync(join(root, ".harnie", "bootstrap.lock")))
})

test("bootstrapRun: 빈 base → fail-closed(lock 미생성)", () => {
  const root = gitRepo()
  assert.throws(() => bootstrapRun(root, { base: "" }), FailClosed)
  assert.ok(!existsSync(join(root, ".harnie", "bootstrap.lock")))
})

test("bootstrapRun: track!=plan → fail-closed(quick 이연)", () => {
  const root = gitRepo()
  assert.throws(() => bootstrapRun(root, { base: "feat-x", track: "quick" }), FailClosed)
})

test("bootstrapRun: collision-free(base dir 선점) → base-2", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie", "plan", "feat-x"), { recursive: true })
  assert.equal(bootstrapRun(root, { base: "feat-x" }).slug, "feat-x-2")
})

test("bootstrapRun: 같은 base·미완료 active → resume(reuse)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x" })
  const r = bootstrapRun(root, { base: "feat-x" })
  assert.equal(r.reused, true)
  assert.equal(r.slug, "feat-x")
})

test("bootstrapRun: 소유 세션을 sentinel에 기록(owner 스코프 권위)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" })
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-a"])
  assert.deepEqual(loadContext(root).sessionIds, ["sid-a"]) // 훅이 파일 재독 없이 쓰는 경로
})

test("bootstrapRun: resume은 소유자를 **추가**한다 — 이전 소유자를 교체하면 그 세션 보호가 풀림(리뷰 P1)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" })
  const r = bootstrapRun(root, { base: "feat-x", sessionId: "sid-b" })
  assert.equal(r.reused, true)
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-a", "sid-b"])
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" }) // 재진입은 중복 추가 안 함
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-a", "sid-b"])
})

test("bootstrapRun: 세션 식별자 없이 resume하면 소유자 집합을 비운다(전역 적용 폴백)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" })
  bootstrapRun(root, { base: "feat-x" }) // sessionId 없음 → 남기면 재개 세션이 비-owner가 됨
  assert.deepEqual(readSentinel(root).sessionIds, [])
})

test("bootstrapRun: 레거시 스칼라 sessionId 센티넬은 resume에서 배열로 이관(기존 소유자 보존)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" })
  const f = join(root, ".harnie", "active.json")
  const s = readSentinel(root); delete s.sessionIds; s.sessionId = "legacy-sid"; writeFileSync(f, JSON.stringify(s))
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-b" })
  const after = readSentinel(root)
  assert.deepEqual(after.sessionIds, ["legacy-sid", "sid-b"])
  assert.equal(after.sessionId, undefined)
})

test("bootstrapRun: rollover(완료 run → 새 run)는 소유자 집합을 새 세션만으로 시작", () => {
  const root = gitRepo()
  makeCompleteRun(root, "feat-x")
  const r = bootstrapRun(root, { base: "feat-x", sessionId: "sid-new" })
  assert.equal(r.reused, false)
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-new"])
})

test("bootstrapRun: 다른 base·미완료 active → block(fail-closed)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x" })
  assert.throws(() => bootstrapRun(root, { base: "feat-y" }), (e) => e instanceof FailClosed && /미완료 run/.test(e.message))
  assert.ok(!existsSync(join(root, ".harnie", "bootstrap.lock")))
})

test("bootstrapRun: 완료 run·같은 base → 새 run base-2(old 보존·포인터 전환)", () => {
  const root = gitRepo()
  makeCompleteRun(root, "feat-x")
  const r = bootstrapRun(root, { base: "feat-x" })
  assert.equal(r.reused, false)
  assert.equal(r.slug, "feat-x-2")
  assert.ok(existsSync(join(root, ".harnie", "plan", "feat-x", "manifest.json")))
  assert.equal(readSentinel(root).slug, "feat-x-2")
})

test("bootstrapRun: 완료 run·다른 base → 새 run(전환·old 보존)", () => {
  const root = gitRepo()
  makeCompleteRun(root, "feat-x")
  const r = bootstrapRun(root, { base: "feat-z" })
  assert.equal(r.slug, "feat-z")
  assert.ok(existsSync(join(root, ".harnie", "plan", "feat-x", "manifest.json")))
  assert.equal(readSentinel(root).slug, "feat-z")
})

test("bootstrapRun: resume 시 execution.json JSON 손상 → fail-closed(P2-5)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x" })
  writeFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "{ not json")
  assert.throws(() => bootstrapRun(root, { base: "feat-x" }), FailClosed)
})

test("bootstrapRun: resume 시 execution.json이 sentinel과 불일치 → fail-closed(P2-5)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x" })
  writeFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), JSON.stringify({ track: "plan", slug: "other", phase: "planning", tasks: {} }))
  assert.throws(() => bootstrapRun(root, { base: "feat-x" }), FailClosed)
})

test("withStateLock: fn 실행 + lock 파일 정리(P1-3)", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie"), { recursive: true })
  assert.equal(withStateLock(root, () => 42), 42)
  assert.ok(!existsSync(join(root, ".harnie", "state.lock")))
})

test("pending-route: session-scoped + state(pending/failed) + 세션 격리(P1-1/P1-3)", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie"), { recursive: true })
  assert.equal(getRouteState(root, "a"), null)
  writePendingRoute(root, "a")
  assert.equal(getRouteState(root, "a"), "pending")
  assert.equal(getRouteState(root, "b"), null) // 세션 격리
  markRouteFailed(root, "a", "미완료 run 충돌")
  assert.equal(getRouteState(root, "a"), "failed") // 실패 상태로 전환
  markRouteFailed(root, "b", "no entry") // 없는 세션 → no-op(직접 진입 실패는 latch 안 함)
  assert.equal(getRouteState(root, "b"), null)
  clearPendingRoute(root, "b") // b가 해제해도 a는 유지
  assert.equal(getRouteState(root, "a"), "failed")
  clearPendingRoute(root, "a")
  assert.equal(getRouteState(root, "a"), null)
  assert.equal(hasPendingRoute(root, "a"), false)
  assert.throws(() => writePendingRoute(root, null), FailClosed) // session_id 필수
})

test("getRouteState: 유효 JSON이지만 알 수 없는 state는 fail-closed(P1 — Stop 우회 차단)", () => {
  const root = gitRepo()
  const dir = join(root, ".harnie", "pending-route")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "corrupt.json"), JSON.stringify({ state: "unexpected", at: "x" }))
  // hasPendingRoute(pretooluse)는 막지만 Stop이 pending/failed 분기 미매치로 통과하던 fail-open → 이제 throw로 양쪽 fail-closed.
  assert.throws(() => getRouteState(root, "corrupt"), FailClosed)
  writeFileSync(join(dir, "noState.json"), JSON.stringify({ at: "x" })) // state 필드 자체 부재
  assert.throws(() => getRouteState(root, "noState"), FailClosed)
  writeFileSync(join(dir, "notObj.json"), JSON.stringify(["pending"])) // 배열(비 plain object)
  assert.throws(() => getRouteState(root, "notObj"), FailClosed)
})

test("bootstrapRun 동시성: 서로 다른 base 8개 동시 실행 → 정확히 1개만 새 run·나머지 block·active.json 일관(P1-5)", async () => {
  const root = gitRepo()
  const childPath = join(mkdtempSync(join(tmpdir(), "harnie-child-")), "child.mjs")
  writeFileSync(childPath, `const {bootstrapRun}=await import(process.argv[2]);try{const r=bootstrapRun(process.argv[3],{base:process.argv[4]});process.stdout.write("OK "+r.slug+(r.reused?" reused":" new"))}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2)}`)
  const execUrl = pathToFileURL(CLI).href
  const runChild = (base) => new Promise((res) => execFile("node", [childPath, execUrl, root, base], (err, stdout) => res({ code: err ? (err.code || 1) : 0, stdout: String(stdout || "") })))
  const results = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h"].map(runChild))
  assert.equal(results.filter((r) => r.code === 0 && / new$/.test(r.stdout)).length, 1, "정확히 1개만 새 run 생성(lock 상호배제)")
  assert.equal(results.filter((r) => r.code === 2).length, 7, "나머지 7개는 block(다른 base·미완료)")
  const s = readSentinel(root) // 손상 없이 읽히고 일관
  assert.ok(s.slug && s.track === "plan")
  assert.ok(!existsSync(join(root, ".harnie", "state.lock"))) // lock 정리됨
})

test("state lock: 남은 lock은 자동 회수 없이 fail-closed(P1-2, 수동 복구)", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie"), { recursive: true })
  writeFileSync(join(root, ".harnie", "state.lock"), "999999999-1-deadbeef") // 남아있는 lock
  assert.throws(() => withStateLock(root, () => 7), FailClosed) // 회수하지 않고 차단(회수 경합이 상호배제를 깨므로)
  assert.ok(existsSync(join(root, ".harnie", "state.lock"))) // 자동 삭제 안 함(수동 rm 대상)
})

test("markRouteFailed는 state.lock 경합과 무관(per-session 파일 → lock 없음, P1-1)", () => {
  const root = gitRepo()
  writePendingRoute(root, "s1")
  writeFileSync(join(root, ".harnie", "state.lock"), `${process.pid}-${Date.now()}-live`) // lock 점유 중
  markRouteFailed(root, "s1", "충돌") // lock 안 잡고 동작해야
  assert.equal(getRouteState(root, "s1"), "failed")
})

test("clearPendingRoute는 strict — 삭제 실패면 throw(부재 재확인, P1-3)", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie", "pending-route"), { recursive: true })
  mkdirSync(join(root, ".harnie", "pending-route", "s1.json")) // 파일 자리에 디렉터리 → rmSync(force, non-recursive)가 throw
  assert.throws(() => clearPendingRoute(root, "s1")) // 삼키지 않고 throw(성공 오보 방지)
})
