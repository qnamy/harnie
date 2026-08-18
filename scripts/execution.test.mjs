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
  setTaskRunStatus, recordBuilderCall, taskWatchdogUsage, watchdogExtend,
  bootstrapRun, slugify, withStateLock, writePendingRoute, clearPendingRoute, hasPendingRoute, getRouteState,
  detectVacuous, loadContext, repoAdd, validateRepoBinding, workspaceInfo,
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
// verification 항목 스키마({executable,args,cwd,timeout} + 선택 evidencePolicy).
const VER = (over = {}) => [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000, ...over }]
const GOOD_MANIFEST = {
  tasks: [
    { id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: VER() },
    { id: "T2", deps: ["T1"], reviewUnit: "task-b", scope: ["src/b/"], verification: VER() },
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

test("validateManifest: evidencePolicy는 선택이지만 값이 규약 밖이면 거부", () => {
  const withVer = (v) => ({ tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["s/"], verification: [v] }], gates: GATES })
  const base = { executable: "node", args: ["--version"], cwd: ".", timeout: 1000 }
  assert.deepEqual(validateManifest(withVer(base)), [])                                          // 미지정 = output-required
  assert.deepEqual(validateManifest(withVer({ ...base, evidencePolicy: "exit-code-only" })), []) // 명시 면제
  assert.deepEqual(validateManifest(withVer({ ...base, evidencePolicy: "output-required" })), [])
  assert.ok(validateManifest(withVer({ ...base, evidencePolicy: "whatever" })).some((e) => /evidencePolicy/.test(e)))
})

test("validateManifest: Final Wave 4게이트 강제(누락·추가 거부)", () => {
  const oneTask = [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["s/"], verification: VER() }]
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

// ── vacuous(공허한 통과) 탐지 — h2 ─────────────────────────────────────
test("detectVacuous: 무출력·node --test 0건·검색 0매치는 공허, 실제 증거는 아님", () => {
  // 출력 0바이트
  assert.ok(detectVacuous({ executable: "node", args: ["-e", ""], exitCode: 0, stdout: "", stderr: "" }).vacuous)
  // node --test: 매치 0건(실측 형태 — `# tests 0`)
  const tap0 = "TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n"
  const v0 = detectVacuous({ executable: "node", args: ["--test", "nomatch-*.test.mjs"], exitCode: 0, stdout: tap0 })
  assert.ok(v0.vacuous)
  assert.ok(v0.reasons.some((r) => /테스트 0건/.test(r)), v0.reasons.join("; "))
  // node --test: 전량 skip(이름 필터) — tests>0이지만 pass 0이라 실제로 실행된 것 없음(실측 형태)
  const tapSkip = "TAP version 13\nok 1 - alpha # SKIP\n1..1\n# tests 1\n# pass 0\n# fail 0\n# skipped 1\n"
  assert.ok(detectVacuous({ executable: "node", args: ["--test", "--test-name-pattern=ZZZ", "a.test.mjs"], exitCode: 0, stdout: tapSkip }).vacuous)
  // spec 리포터(ℹ) 형태도 인식
  assert.ok(detectVacuous({ executable: "node", args: ["--test", "x"], exitCode: 0, stdout: "ℹ tests 0\nℹ pass 0\n" }).vacuous)
  // 실제로 통과한 테스트가 있으면 공허 아님
  const tapOk = "TAP version 13\nok 1 - alpha\n1..1\n# tests 1\n# pass 1\n# fail 0\n"
  assert.equal(detectVacuous({ executable: "node", args: ["--test", "a.test.mjs"], exitCode: 0, stdout: tapOk }).vacuous, false)
  // 검색: 매치 0건 / 카운트 전부 0
  assert.ok(detectVacuous({ executable: "rg", args: ["-e", "A"], exitCode: 0, stdout: "\n  \n" }).vacuous)
  assert.ok(detectVacuous({ executable: "/usr/bin/grep", args: ["-c", "A", "a", "b"], exitCode: 0, stdout: "a:0\nb:0\n" }).vacuous)
  assert.equal(detectVacuous({ executable: "grep", args: ["-c", "A", "a", "b"], exitCode: 0, stdout: "a:3\nb:0\n" }).vacuous, false)
  assert.ok(detectVacuous({ executable: "git", args: ["grep", "A"], exitCode: 0, stdout: "" }).vacuous)
  // **count 모드가 아니면 `path:0`은 매치된 줄 내용** — 증거로 인정(오탐 회귀: `rg '0$' fixture.txt` → `fixture.txt:0`)
  assert.equal(detectVacuous({ executable: "rg", args: ["0$", "fixture.txt"], exitCode: 0, stdout: "fixture.txt:0\n" }).vacuous, false)
  assert.equal(detectVacuous({ executable: "grep", args: ["-rn", "0$", "."], exitCode: 0, stdout: "./a.txt:12:0\n" }).vacuous, false)
  // count 플래그가 있을 때만 카운트 문법 해석(짧은 묶음 -rc 포함)
  assert.ok(detectVacuous({ executable: "rg", args: ["--count", "A", "."], exitCode: 0, stdout: "a:0\n" }).vacuous)
  assert.ok(detectVacuous({ executable: "grep", args: ["-rc", "A", "."], exitCode: 0, stdout: "./a:0\n" }).vacuous)
  // evidencePolicy: exit-code-only는 **무출력 규칙만** 면제(조용한 tsc/eslint/node --check 등록 허용)
  assert.equal(detectVacuous({ executable: "tsc", args: ["--noEmit"], exitCode: 0, stdout: "", stderr: "", evidencePolicy: "exit-code-only" }).vacuous, false)
  // 도구별 규칙은 정책과 무관하게 유지 — "테스트 0건 통과"는 침묵이 아니라 적극적 증거의 부재
  assert.ok(detectVacuous({ executable: "node", args: ["--test", "x"], exitCode: 0, stdout: "# tests 0\n# pass 0\n", evidencePolicy: "exit-code-only" }).vacuous)
  // exitCode≠0은 이미 blocker → 공허 판정 대상 아님
  assert.equal(detectVacuous({ executable: "node", args: ["--test", "x"], exitCode: 1, stdout: "" }).vacuous, false)
  // 출력이 있는 정상 명령
  assert.equal(detectVacuous({ executable: "node", args: ["--version"], exitCode: 0, stdout: "v21.6.2\n" }).vacuous, false)
})

test("deriveCompletion: receipt.vacuous면 exitCode 0이어도 미검증 취급(h2)", () => {
  const snap = okSnap()
  snap.units["task-a"].receipt = { exitCode: 0, planHash: "PH", scopeHash: "SH", vacuous: true, vacuousReasons: ["테스트 0건"] }
  const r = deriveCompletion(GOOD_MANIFEST, snap)
  assert.equal(r.complete, false)
  assert.ok(r.blockers.some((b) => /공허함/.test(b)), r.blockers.join("; "))
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
// 승인 흐름: arm(A5) → 첫 AskUserQuestion pending → tool_use_id·선택값 바인딩.
const AQ = "이 계획을 실행할까요?"
function approveFlow(root, slug = "feat-x", tuid = "tu-1") {
  armApproval(root, slug, { approveOption: "승인" })
  recordPendingApproval(root, slug, tuid)
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

test("init: slug traversal 차단", () => {
  const root = gitRepo()
  assert.ok(runFail(["init", "--root", root, "--slug", ".."]))
})

test("승인 바인딩(함수): arm→pending → approve → executing + immutable manifest", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const p = armApproval(root, "feat-x", { approveOption: "승인" })
  recordPendingApproval(root, "feat-x", "tu-1")
  const a = bindApproval(root, "feat-x", "tu-1", { answers: { [AQ]: "승인" } })
  assert.equal(a.phase, "executing")
  assert.equal(a.planHash, p.planHash)
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).planHash, p.planHash)
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
  const armR = () => { armApproval(root, "feat-x", { approveOption: "승인" }) }
  // 거절(선택값 "거절·수정")
  armR(); recordPendingApproval(root, "feat-x", "tu-1")
  assert.equal(bindApproval(root, "feat-x", "tu-1", { answers: { [AQ]: "거절·수정" } }).ok, false)
  // tool_use_id 불일치(pending 보존)
  armR(); recordPendingApproval(root, "feat-x", "tu-2")
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
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: VER() }], gates: GATES })
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
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: VER() }], gates: GATES })
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
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: VER() }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  approveFlow(root)
  writeFileSync(join(dir, "plan.md"), readFileSync(join(dir, "plan.md"), "utf8") + "\n변조\n") // 승인 권위 깨짐
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "final-wave"]))
  assert.ok(runFail(["set-phase", "--root", root, "--slug", "feat-x", "--phase", "closed"]))
})

test("register(함수): threadId 등록·재등록 금지(훅 전용, CLI 아님)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  assert.equal(registerBuilderThread(root, "feat-x", "T1", "th-b").threadId, "th-b")
  assert.throws(() => registerBuilderThread(root, "feat-x", "T1", "th-other"), FailClosed) // 다른 threadId 재등록 금지
  assert.ok(registerReadonlyThread(root, "plan", "feat-x", "th-r").readOnlyThreads.includes("th-r"))
})

test("워치독 상태: building 진입은 예산을 재시작하고 built 전이는 유지", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  const execPath = join(root, ".harnie", "plan", "feat-x", "execution.json")
  let ex = JSON.parse(readFileSync(execPath, "utf8"))
  const startedAt = ex.tasks.T1.startedAt
  assert.ok(startedAt)
  assert.equal(ex.tasks.T1.codexCalls, 0)
  ex.tasks.T1.codexCalls = 7
  writeFileSync(execPath, JSON.stringify(ex))
  setTaskRunStatus(root, "feat-x", "T1", "built")
  ex = JSON.parse(readFileSync(execPath, "utf8"))
  assert.equal(ex.tasks.T1.startedAt, startedAt)
  assert.equal(ex.tasks.T1.codexCalls, 7)
})

test("워치독 상태: 빌더 호출 기록·미등록 no-op·사용량 조회", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "builder-1")
  assert.equal(recordBuilderCall(root, "feat-x", "builder-1").codexCalls, 1)
  assert.equal(recordBuilderCall(root, "feat-x", "builder-1").codexCalls, 2)
  assert.deepEqual(recordBuilderCall(root, "feat-x", "unknown"), { ok: false })
  assert.equal(taskWatchdogUsage(root, "feat-x", { threadId: "builder-1" }).codexCalls, 2)
  assert.equal(taskWatchdogUsage(root, "feat-x", { taskId: "missing" }), null)
})

test("watchdog-extend: 예산 리셋·연장 이력, 사유 없으면 fail-closed", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "builder-1")
  recordBuilderCall(root, "feat-x", "builder-1")
  assert.equal(watchdogExtend(root, "feat-x", "T1", "사용자 승인").extensions, 1)
  const usage = taskWatchdogUsage(root, "feat-x", { taskId: "T1" })
  assert.equal(usage.codexCalls, 0)
  assert.ok(usage.startedAt)
  assert.throws(() => watchdogExtend(root, "feat-x", "T1", ""), FailClosed)
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

test("bootstrapRun: 세션 식별자 없는 resume은 집합을 보존한다 — 비우면 다음 resume이 다시 좁힌다(리뷰 P1)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" })
  bootstrapRun(root, { base: "feat-x" }) // 식별자 없음 → 이 세션은 isOwnerSession에서 이미 owner라 지울 이유가 없다
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-a"])
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-b" }) // 비웠다면 여기서 ["sid-b"]가 되어 sid-a가 빠졌다
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-a", "sid-b"])
})

test("bootstrapRun: 소유자 집합은 monotonic — 어떤 resume 순서에서도 참여 세션이 빠지지 않는다", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sid-a" })
  for (const sessionId of [undefined, "sid-b", undefined, "sid-a", "sid-c", undefined])
    bootstrapRun(root, { base: "feat-x", sessionId })
  assert.deepEqual(readSentinel(root).sessionIds, ["sid-a", "sid-b", "sid-c"])
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

test("pending-route: session-scoped pending + clear + 세션 격리", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie"), { recursive: true })
  assert.equal(getRouteState(root, "a"), null)
  writePendingRoute(root, "a")
  assert.equal(getRouteState(root, "a"), "pending")
  assert.equal(getRouteState(root, "b"), null) // 세션 격리
  clearPendingRoute(root, "b") // b가 해제해도 a는 유지
  assert.equal(getRouteState(root, "a"), "pending")
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

test("state lock: 일시 경합은 bounded retry 후 획득", async () => {
  const root = gitRepo()
  const lock = join(root, ".harnie", "state.lock")
  mkdirSync(dirname(lock), { recursive: true })
  writeFileSync(lock, "busy")
  const removed = new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", "setTimeout(() => require('node:fs').unlinkSync(process.argv[1]), 100)", lock], (err) => err ? reject(err) : resolve())
  })
  assert.equal(withStateLock(root, () => 7), 7)
  await removed
  assert.ok(!existsSync(lock))
})

test("clearPendingRoute는 strict — 삭제 실패면 throw(부재 재확인, P1-3)", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie", "pending-route"), { recursive: true })
  mkdirSync(join(root, ".harnie", "pending-route", "s1.json")) // 파일 자리에 디렉터리 → rmSync(force, non-recursive)가 throw
  assert.throws(() => clearPendingRoute(root, "s1")) // 삼키지 않고 throw(성공 오보 방지)
})

function readyForVerify(root, manifest, slug = "feat-x", unit = "task-a") {
  const dir = writePlan(root, slug, manifest)
  run(["init", "--root", root, "--slug", slug])
  approveFlow(root, slug)
  const postSHA = JSON.parse(execFileSync("node", [join(HERE, "loop.mjs"), "capture", root], { encoding: "utf8" })).baselineSHA
  const ud = join(dir, "review", unit); mkdirSync(ud, { recursive: true })
  writeFileSync(join(ud, "ledger.json"), "{}")
  writeFileSync(join(ud, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  return dir
}
const oneTaskManifest = (verification) => ({ tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification }], gates: GATES })

test("verify: 실제로 테스트가 통과하는 명령은 vacuous 아님(등록·검증 모두 통과)", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true })
  writeFileSync(join(root, "src", "a", "x.test.mjs"), 'import {test} from "node:test"\ntest("alpha",()=>{})\n')
  readyForVerify(root, oneTaskManifest([{ executable: "node", args: ["--test", "src/a/x.test.mjs"], cwd: ".", timeout: 60000 }]))
  const v = run(["verify", "--root", root, "--slug", "feat-x", "--task", "T1"])
  assert.equal(v.ok, true, JSON.stringify(v.receipt))
  assert.equal(v.receipt.vacuous, false)
  assert.deepEqual(v.receipt.vacuousReasons, [])
})

test("verify: 등록 후 테스트가 사라지면 런타임에 vacuous → 완료 재도출에서 미검증", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true })
  writeFileSync(join(root, "src", "a", "x.js"), "x") // scope 경로 유지용(테스트 파일 삭제 후에도 tree에 존재)
  writeFileSync(join(root, "src", "a", "x.test.mjs"), 'import {test} from "node:test"\ntest("alpha",()=>{})\n')
  // 등록 시점엔 glob이 매치돼 pass 1 → 게이트 통과. 이후 테스트가 사라지면 glob 미매치로 tests 0인데 exit 0(실측 사고 형태).
  const dir = readyForVerify(root, oneTaskManifest([{ executable: "node", args: ["--test", "src/a/*.test.mjs"], cwd: ".", timeout: 60000 }]))
  rmSync(join(root, "src", "a", "x.test.mjs"))
  const v = run(["verify", "--root", root, "--slug", "feat-x", "--task", "T1"])
  assert.equal(v.receipt.results[0].exitCode, 0, "테스트 0건인데도 0으로 통과")
  assert.ok(v.receipt.results[0].stdoutBytes > 0, "TAP 출력은 있음 — 무출력 규칙이 아니라 pass 0 규칙이 잡아야 함")
  assert.equal(v.ok, false)
  assert.equal(v.receipt.vacuous, true)
  assert.ok(v.receipt.vacuousReasons.some((r) => /테스트 0건/.test(r)), v.receipt.vacuousReasons.join("; "))
  assert.equal(JSON.parse(readFileSync(join(dir, "review", "task-a", "receipt.json"), "utf8")).vacuous, true)
  const c = run(["completion", "--root", root, "--slug", "feat-x"])
  assert.equal(c.complete, false)
  assert.ok(c.blockers.some((b) => /공허함/.test(b)), c.blockers.join("; "))
})

// ── 워크스페이스 run(멀티레포) ────────────────────────────────────────────
function childRepo(w, name) {
  const repo = join(w, name)
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", repo, "config", "user.name", "t"])
  mkdirSync(join(repo, "src"), { recursive: true })
  writeFileSync(join(repo, "src", "a.txt"), "a\n")
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"])
  return repo
}
function workspaceRun(base = "ws-task") {
  const w = mkdtempSync(join(tmpdir(), "harnie-ws-exec-"))
  const repo = childRepo(w, "repoA")
  const runRoot = join(w, ".harnie-wt", `harnie-${base}`)
  mkdirSync(runRoot, { recursive: true })
  const { slug } = bootstrapRun(runRoot, { base, track: "plan", sessionId: "s1", workspaceRoot: w })
  return { w, repo, runRoot, slug }
}
function plainRun(base) {
  const plain = gitRepo()
  writeFileSync(join(plain, "f.txt"), "x\n")
  execFileSync("git", ["-C", plain, "add", "."])
  execFileSync("git", ["-C", plain, "commit", "-q", "-m", "init"])
  bootstrapRun(plain, { base, track: "plan", sessionId: "s1" })
  return plain
}

test("repoAdd: 검증(워크스페이스 하위·toplevel) 후 worktree 생성 + sentinel 등록(멱등)", () => {
  const { w, repo, runRoot, slug } = workspaceRun()
  const r1 = repoAdd(runRoot, repo)
  assert.equal(r1.ok, true)
  assert.equal(r1.key, "repoA")
  assert.equal(r1.workroot, join(r1.repo, ".harnie-wt", `harnie-${slug}`))
  assert.ok(existsSync(join(r1.workroot, ".git"))) // git worktree
  const ws = workspaceInfo(runRoot)
  assert.equal(ws.workspaceRoot, w)
  assert.deepEqual(Object.keys(ws.repos), ["repoA"])
  const r2 = repoAdd(runRoot, repo) // 재호출 = 멱등(attach)
  assert.equal(r2.created, false)
  assert.equal(r2.workroot, r1.workroot)
})

test("repoAdd: 비-workspace run·워크스페이스 밖·비-toplevel은 fail-closed", () => {
  const plain = plainRun("t1")
  assert.throws(() => repoAdd(plain, plain), /workspace run 전용/)

  const { repo, runRoot } = workspaceRun("ws-neg")
  const outside = gitRepo()
  assert.throws(() => repoAdd(runRoot, outside), /하위가 아님/)
  assert.throws(() => repoAdd(runRoot, join(repo, "src")), /toplevel이 아님/)
})

test("validateManifest: task.repo 형식·all-or-none", () => {
  const t = (over) => ({ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/"], verification: VER(), ...over })
  const t2 = (over) => ({ id: "T2", deps: [], reviewUnit: "task-b", scope: ["src/"], verification: VER(), ...over })
  assert.deepEqual(validateManifest({ tasks: [t({ repo: "repoA" }), t2({ repo: "nested/repoB" })], gates: GATES }), [])
  assert.ok(validateManifest({ tasks: [t({ repo: "../evil" }), t2({ repo: "x" })], gates: GATES }).some((e) => /repo 형식 오류/.test(e)))
  assert.ok(validateManifest({ tasks: [t({ repo: "a/../b" }), t2({ repo: "x" })], gates: GATES }).some((e) => /repo 형식 오류/.test(e)))
  assert.ok(validateManifest({ tasks: [t({ repo: "/abs" }), t2({ repo: "x" })], gates: GATES }).some((e) => /repo 형식 오류/.test(e)))
  assert.ok(validateManifest({ tasks: [t({ repo: "repoA" }), t2({})], gates: GATES }).some((e) => /all-or-none/.test(e)))
})

test("validateRepoBinding: workspace run은 등록 repo와 정합해야, 비-workspace run은 repo 금지", () => {
  const { repo, runRoot } = workspaceRun("ws-bind")
  repoAdd(runRoot, repo)
  const block = (repoKey) => ({ tasks: [{ id: "T1", repo: repoKey }], gates: [] })
  assert.equal(validateRepoBinding(runRoot, block("repoA")), null)
  assert.match(validateRepoBinding(runRoot, block("repoB")) || "", /미등록/)
  assert.match(validateRepoBinding(runRoot, { tasks: [{ id: "T1" }], gates: [] }) || "", /repo 키 필수/)
  const plain = plainRun("t2")
  assert.match(validateRepoBinding(plain, block("repoA")) || "", /workspace run에서만/)
})

test("completion: workspace run — 멤버 repo 바인딩으로 스냅샷 산출, 미등록 repo는 바인딩 실패 blocker", () => {
  const { repo, runRoot, slug } = workspaceRun("ws-comp")
  repoAdd(runRoot, repo)
  const manifest = {
    tasks: [
      { id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a.txt"], verification: VER(), repo: "repoA" },
      { id: "T2", deps: [], reviewUnit: "task-b", scope: ["src/a.txt"], verification: VER(), repo: "ghost" },
    ],
    gates: GATES,
    planHash: "PH",
  }
  const dir = join(runRoot, ".harnie", "plan", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  const c = run(["completion", "--root", runRoot, "--slug", slug])
  assert.equal(c.complete, false)
  assert.ok(c.blockers.some((b) => /task T1: ledger 없음/.test(b)), c.blockers.join("; "))
  assert.ok(c.blockers.some((b) => /task T2: repo 바인딩 실패/.test(b)), c.blockers.join("; "))
})
