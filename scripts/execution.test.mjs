// execution.mjs 테스트 — 순수 권위 함수 + fail-closed IO 경로(init/approve/seal/verify/completion).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, execFile, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  stableStringify, computePlanHash, validateSlug, assertContainedRel,
  extractManifestBlock, validateManifest, canonicalManifest,
  deriveCompletion, sealHashOf, parseStatusFooter, FailClosed, authorityApproved,
  armApproval, recordPendingApproval, bindApproval, registerBuilderThread, registerReadonlyThread,
  bootstrapRun, slugify, withStateLock, writePendingRoute, clearPendingRoute, hasPendingRoute, getRouteState, markRouteFailed,
  detectVacuous, parkRun, resumeParkedRun, abandonRoute, loadContext,
  trialKey, runTrials, trialGate, isRouteAbandonCli, makeConfinement, assertConfinement, sandboxProfile,
} from "./execution.mjs"

// 자식 종료코드만 필요한 통합 검사용(출력은 무시).
function execFileSyncStatus(exe, args, cwd, env) {
  const r = spawnSync(exe, args, { cwd, env, encoding: "utf8" })
  return typeof r.status === "number" ? r.status : 1
}

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
// verification 항목 스키마는 그대로({executable,args,cwd,timeout} + 선택 evidencePolicy). h1(안 돌려본 명령 차단)은
// manifest 필드가 아니라 **trial receipt 등록 게이트**로 강제된다 → 승인 흐름은 `trial`을 먼저 실행해야 한다.
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
// 승인 흐름: **trial(등록 영수증)** → arm(A5, 질문·옵션 고정) → pending(질문/옵션 대조) → bindApproval(선택값 정확 일치).
const AQ = "이 계획을 실행할까요?"
function approveFlow(root, slug = "feat-x", tuid = "tu-1") {
  run(["trial", "--root", root, "--slug", slug]) // h1: 실제 실행 영수증 없으면 arm 자체가 거부된다
  armApproval(root, slug, { question: AQ, approveOption: "승인" })
  recordPendingApproval(root, slug, tuid, AQ, ["승인", "거절·수정"])
  return bindApproval(root, slug, tuid, { answers: { [AQ]: "승인" } })
}
// arm을 직접 호출하는 테스트용: 등록 게이트를 통과시키는 trial 선행 실행.
const trial = (root, slug = "feat-x") => run(["trial", "--root", root, "--slug", slug])

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
  trial(root)
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
  const root = gitRepo(); writePlan(root, "feat-x"); run(["init", "--root", root, "--slug", "feat-x"]); trial(root)
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
  trial(root)
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

test("승인 옵션 정확 일치만 승인(질문/옵션 바인딩)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  trial(root)
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
  trial(root)
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

// ── park / resume — 승인 前 run의 지원되는 종료 경로 ─────────────────────
const parkedPtr = (root, slug, track = "plan") => join(root, ".harnie", "parked", track, slug, "active.json")
// bootstrapRun은 collision-free slug라 **run 생성이 먼저**여야 slug가 base와 같다(writePlan이 dir을 선점하면 base-2가 됨).
function bootstrapWithPlan(root, base = "feat-x", opts = {}) {
  const r = bootstrapRun(root, { base, ...opts })
  return { ...r, dir: writePlan(root, r.slug) }
}

test("park: 승인 前 run은 포인터만 치우고 작업물 보존(plan.md·run dir 유지)", () => {
  const root = gitRepo()
  const { dir } = bootstrapWithPlan(root, "feat-x")
  writeFileSync(join(dir, "notepad.md"), "재사용 지식\n")
  const r = parkRun(root, { track: "plan", slug: "feat-x" })
  assert.equal(r.ok, true)
  assert.deepEqual(r.parked, { track: "plan", slug: "feat-x" })
  assert.ok(!existsSync(join(root, ".harnie", "active.json")), "sentinel 포인터는 치워짐")
  assert.ok(existsSync(parkedPtr(root, "feat-x")), "park 기록 생성")
  // 작업물은 그대로
  assert.ok(existsSync(join(dir, "plan.md")))
  assert.ok(existsSync(join(dir, "notepad.md")))
  assert.ok(existsSync(join(dir, "execution.json")))
  assert.ok(!existsSync(join(root, ".harnie", "state.lock"))) // lock 정리
})

test("park: 승인 後 run은 거부(abort 없음 결정 유지)", () => {
  const root = gitRepo()
  bootstrapWithPlan(root, "feat-x")
  approveFlow(root, "feat-x")
  assert.throws(() => parkRun(root, { track: "plan", slug: "feat-x" }), (e) => e instanceof FailClosed && /승인된 run/.test(e.message))
  assert.ok(existsSync(join(root, ".harnie", "active.json")), "거부 시 포인터 불변")
  assert.ok(!existsSync(parkedPtr(root, "feat-x")))
})

test("park: 활성 run 없음·대상 불일치는 fail-closed", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie"), { recursive: true })
  assert.throws(() => parkRun(root, { slug: "feat-x" }), (e) => e instanceof FailClosed && /활성 run 없음/.test(e.message))
  bootstrapRun(root, { base: "feat-x" })
  assert.throws(() => parkRun(root, { slug: "feat-y" }), (e) => e instanceof FailClosed && /대상 불일치/.test(e.message))
  assert.throws(() => parkRun(root, { track: "quick", slug: "feat-x" }), (e) => e instanceof FailClosed && /대상 불일치/.test(e.message))
  assert.ok(existsSync(join(root, ".harnie", "active.json")))
})

test("park 후 새 run 생성 가능(다른 작업으로 이동) → resume으로 원복", () => {
  const root = gitRepo()
  bootstrapWithPlan(root, "feat-x", { sessionId: "sess-A" })
  parkRun(root, { slug: "feat-x" })
  // 다른 작업 착수 — 미완료 run 충돌 없이 새 run
  const nu = bootstrapRun(root, { base: "feat-y", sessionId: "sess-B" })
  assert.equal(nu.slug, "feat-y")
  assert.equal(readSentinel(root).slug, "feat-y")
  // 활성 run이 있으면 resume 거부
  assert.throws(() => resumeParkedRun(root, { slug: "feat-x" }), (e) => e instanceof FailClosed && /이미 활성 run/.test(e.message))
  // feat-y를 park한 뒤 feat-x resume → 원복(소유 세션 갱신)
  parkRun(root, { slug: "feat-y" })
  const back = resumeParkedRun(root, { slug: "feat-x", sessionId: "sess-C" })
  assert.equal(back.resumed, true)
  assert.equal(back.phase, "planning")
  const s = readSentinel(root)
  assert.equal(s.slug, "feat-x")
  assert.equal(s.base, "feat-x")
  assert.equal(s.sessionId, "sess-C", "resume하는 세션이 소유권을 갖는다")
  assert.equal(s.parkedAt, undefined)
  assert.ok(!existsSync(parkedPtr(root, "feat-x")), "park 기록은 정리됨")
  // 원복된 run은 그대로 이어서 사용 가능(bootstrap resume)
  assert.equal(bootstrapRun(root, { base: "feat-x" }).reused, true)
})

test("resume: park 기록 없음·손상 execution.json은 fail-closed / --session 없으면 소유자 미지", () => {
  const root = gitRepo()
  mkdirSync(join(root, ".harnie"), { recursive: true })
  assert.throws(() => resumeParkedRun(root, { slug: "nope" }), (e) => e instanceof FailClosed && /park된 run 없음/.test(e.message))
  assert.throws(() => resumeParkedRun(root, {}), (e) => e instanceof FailClosed && /--slug 필요/.test(e.message))
  bootstrapWithPlan(root, "feat-x", { sessionId: "sess-A" })
  parkRun(root, { slug: "feat-x" })
  // execution.json 손상 → resume 거부(포인터 복원 안 함)
  writeFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "{ not json")
  assert.throws(() => resumeParkedRun(root, { slug: "feat-x" }), FailClosed)
  assert.ok(!existsSync(join(root, ".harnie", "active.json")))
  // 정상 복구 후, --session 미지정이면 sessionId 제거(구버전 sentinel과 동일 = 게이트 없음)
  writeFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), JSON.stringify({ track: "plan", slug: "feat-x", planHash: null, phase: "planning", tasks: {} }))
  resumeParkedRun(root, { slug: "feat-x" })
  assert.equal(readSentinel(root).sessionId, undefined)
})

test("park: 일회성 승인 스캐폴딩(arm/pending)은 정리(나중 세션의 stale 바인딩 차단)", () => {
  const root = gitRepo()
  const { dir } = bootstrapWithPlan(root, "feat-x")
  trial(root)
  armApproval(root, "feat-x", { question: AQ, approveOption: "승인" })
  recordPendingApproval(root, "feat-x", "tu-1", AQ, ["승인", "거절·수정"])
  assert.ok(existsSync(join(dir, ".pending-approval.json")))
  parkRun(root, { slug: "feat-x" })
  assert.ok(!existsSync(join(dir, ".arm-approval.json")))
  assert.ok(!existsSync(join(dir, ".pending-approval.json")))
})

test("park/resume CLI: 서브커맨드로 동작(승인 後 die)", () => {
  const root = gitRepo()
  bootstrapWithPlan(root, "feat-x", { sessionId: "sess-A" })
  assert.equal(run(["park", "--root", root, "--track", "plan", "--slug", "feat-x"]).ok, true)
  assert.ok(!existsSync(join(root, ".harnie", "active.json")))
  assert.equal(run(["resume", "--root", root, "--track", "plan", "--slug", "feat-x", "--session", "sess-B"]).resumed, true)
  assert.equal(readSentinel(root).sessionId, "sess-B")
  approveFlow(root, "feat-x")
  const e = runFail(["park", "--root", root, "--track", "plan", "--slug", "feat-x"])
  assert.ok(e && /승인된 run/.test(e.stderr), e && e.stderr)
})

// ── route-abandon — pending-route의 이탈 경로 ────────────────────────────
test("route-abandon: state=failed 전환(Stop이 정직 보고 후 허용·정리), 항목 없으면 no-op", () => {
  const root = gitRepo()
  writePendingRoute(root, "s1")
  const r = abandonRoute(root, "s1", "조사 결과 지금 착수 부적절")
  assert.equal(r.ok, true)
  assert.equal(r.state, "failed")
  assert.match(r.reason, /사용자 결정/)
  assert.match(r.reason, /조사 결과/)
  assert.equal(getRouteState(root, "s1"), "failed")
  // 기존 항목 없는 세션 → no-op(직접 진입 실패는 latch 안 함)
  const r2 = abandonRoute(root, "s2")
  assert.equal(r2.ok, true)
  assert.equal(r2.state, null)
  assert.equal(getRouteState(root, "s2"), null)
  // 세션 격리 유지
  assert.equal(getRouteState(root, "s1"), "failed")
  assert.throws(() => abandonRoute(root, null), FailClosed)
})

test("route-abandon CLI: --session 필수 + failed 전환", () => {
  const root = gitRepo()
  writePendingRoute(root, "s1")
  assert.ok(runFail(["route-abandon", "--root", root]))
  const r = run(["route-abandon", "--root", root, "--session", "s1", "--reason", "선행 마이그레이션 필요"])
  assert.equal(r.state, "failed")
  assert.match(JSON.parse(readFileSync(join(root, ".harnie", "pending-route", "s1.json"), "utf8")).reason, /사용자 결정/)
})

// ── sentinel owner 세션(세션 2의 owner-only 게이트 계약) ─────────────────
test("createRun: sentinel에 sessionId 기록 / 구버전(필드 부재)은 손상 아님", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sess-A" })
  assert.equal(readSentinel(root).sessionId, "sess-A")
  assert.equal(loadContext(root).sessionId, "sess-A")
  // sessionId 미지정 → null(게이트 없음)
  const root2 = gitRepo()
  bootstrapRun(root2, { base: "feat-x" })
  assert.equal(readSentinel(root2).sessionId, null)
  assert.equal(loadContext(root2).sessionId, null)
  // 구버전 sentinel(필드 자체 부재) → 손상 아님, 정상 동작(resume 포함)
  const root3 = gitRepo()
  run(["init", "--root", root3, "--slug", "feat-x"]) // 레거시 CLI 경로: 필드 없음
  const legacy = readSentinel(root3)
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "sessionId"), false)
  const ctx = loadContext(root3)
  assert.equal(ctx.failClosed, undefined)
  assert.equal(ctx.sessionId, null)
  assert.equal(bootstrapRun(root3, { base: "feat-x", sessionId: "sess-Z" }).reused, true) // 구버전 sentinel resume
})

// ── h1: trial 등록 게이트(실제 실행 영수증만 인정) ────────────────────────
test("trialKey: argv·cwd·timeout·정책이 같으면 같은 키, 하나라도 다르면 다른 키", () => {
  const v = { executable: "node", args: ["--test", "a.mjs"], cwd: ".", timeout: 1000 }
  assert.equal(trialKey(v), trialKey({ ...v }))
  assert.notEqual(trialKey(v), trialKey({ ...v, args: ["--test", "b.mjs"] }))
  assert.notEqual(trialKey(v), trialKey({ ...v, cwd: "sub" }))
  assert.notEqual(trialKey(v), trialKey({ ...v, timeout: 2000 }))
  assert.notEqual(trialKey(v), trialKey({ ...v, evidencePolicy: "exit-code-only" }))
})

test("trial → 등록 게이트: 영수증 없으면 arm 거부, trial 후 승인 가능(자기진술 불가)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  // ① trial 전 → arm 거부(등록 불가)
  const before = armApproval(root, "feat-x", { question: AQ, approveOption: "승인" })
  assert.equal(before.ok, false)
  assert.match(before.reason, /실행 영수증 없음/)
  assert.ok(runFail(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ]))
  // ② trial 실행 → control-protected 경로(basename=receipt.json)에 영수증 기록
  const t = run(["trial", "--root", root, "--slug", "feat-x"])
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.equal(t.trials.length, 2)
  const key = t.trials[0].key
  assert.ok(existsSync(join(dir, "trials", key, "receipt.json")))
  // ③ 이제 승인 가능
  assert.equal(approveFlow(root, "feat-x", "tu-9").phase, "executing")
})

// CR-007 회귀: trial은 승인 前 live repo가 아니라 **격리 sandbox**에서 실행돼야 한다.
test("trial 격리(CR-007): 상대경로 쓰기 verification이 승인 前 live repo를 오염시키지 않음", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "existing.js"), "keep")
  // 리뷰 재현 argv 그대로: 'checked'를 출력하며 src/preapproval.js를 쓴다(비-공허 + 부작용).
  const writer = { executable: "node", args: ["-e", "require('node:fs').writeFileSync('src/preapproval.js','written'); console.log('checked')"], cwd: ".", timeout: 30000 }
  writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/"], verification: [writer] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  const t = run(["trial", "--root", root, "--slug", "feat-x"])
  assert.equal(t.ok, true, "sandbox 안에서는 정상 실행(출력 있음 → 비-공허)")
  assert.equal(t.isolated, true)
  // 핵심: 승인 前 live repo에 소스가 생기지 않았다.
  assert.ok(!existsSync(join(root, "src", "preapproval.js")), "승인 前 소스 쓰기 금지 불변식 유지")
  assert.equal(readFileSync(join(root, "src", "existing.js"), "utf8"), "keep")
  // 영수증은 격리 실행 기록으로 남고 등록도 가능(실행 증거는 실재)
  const rec = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "trials", t.trials[0].key, "receipt.json"), "utf8"))
  assert.equal(rec.isolated, true)
  assert.equal(rec.exitCode, 0)
})

test("trial 격리: sandbox에는 working tree 내용(untracked 포함)이 있어 정상 검증은 통과", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src", "a"), { recursive: true })
  // 커밋하지 않은 untracked 테스트 파일 — captureTree가 포함하므로 sandbox에서도 실행돼야 한다.
  writeFileSync(join(root, "src", "a", "x.test.mjs"), 'import {test} from "node:test"\ntest("alpha",()=>{})\n')
  writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--test", "src/a/*.test.mjs"], cwd: ".", timeout: 60000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  const t = run(["trial", "--root", root, "--slug", "feat-x"])
  assert.equal(t.trials[0].exitCode, 0)
  assert.equal(t.trials[0].vacuous, false, "sandbox에서 테스트가 실제로 실행·통과")
})

// CR-007 재검토 회귀: 쓰기를 **예방**해야 한다(사후 탐지로는 이미 발생한 쓰기를 되돌릴 수 없다).
// escape 4종(절대경로 소스 / PWD 기반 / gitignore된 경로 / .harnie authority) 모두 live 상태 불변이어야 한다.
test("trial 격리(CR-007): 절대경로·PWD·ignored·.harnie escape 모두 예방됨(live 상태 불변)", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "keep.js"), "keep")
  writeFileSync(join(root, ".gitignore"), "ignored/\n")
  mkdirSync(join(root, "ignored"), { recursive: true })
  writeFileSync(join(root, "ignored", "keep.txt"), "keep") // gitignore된 경로(captureTree 밖 = 기존 blind spot)
  const w = (target) => `try{require('node:fs').writeFileSync(${target},'written')}catch(e){console.log('blocked '+e.code)}`
  const abs = JSON.stringify(join(root, "src", "abs-escape.js"))
  const ign = JSON.stringify(join(root, "ignored", "ign-escape.txt"))
  const sentinel = JSON.stringify(join(root, ".harnie", "active.json"))
  const dir = writePlan(root, "feat-x", {
    tasks: [{
      id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/"],
      verification: [
        { executable: "node", args: ["-e", w(abs)], cwd: ".", timeout: 30000 },
        // 상속 PWD 기반 쓰기: 격리는 PWD도 sandbox로 재작성해야 한다.
        { executable: "node", args: ["-e", w("process.env.PWD + '/src/env-escape.js'")], cwd: ".", timeout: 30000 },
        { executable: "node", args: ["-e", w(ign)], cwd: ".", timeout: 30000 },
        // authority 훼손 시도: slug를 evil로 바꿔 쓰려 한다(captureTree가 .harnie를 제외해 과거엔 탐지조차 못 했다).
        { executable: "node", args: ["-e", w(sentinel)], cwd: ".", timeout: 30000 },
      ],
    }],
    gates: GATES,
  })
  run(["init", "--root", root, "--slug", "feat-x"])
  const sentinelBefore = readFileSync(join(root, ".harnie", "active.json"), "utf8")
  const t = run(["trial", "--root", root, "--slug", "feat-x"])
  // live 경로 쓰기는 커널이 EPERM으로 거부(실측), PWD 기반 쓰기는 sandbox 안으로 재작성돼 성공한다 — 어느 쪽도 live에 닿지 않는다.
  assert.equal(t.isolated, true)
  assert.equal(t.trials.length, 4)
  // ① live 소스 불변 ② PWD escape 없음 ③ ignored 경로 불변 ④ authority(sentinel) 불변
  assert.ok(!existsSync(join(root, "src", "abs-escape.js")), "절대경로 소스 쓰기 예방")
  assert.ok(!existsSync(join(root, "src", "env-escape.js")), "PWD 기반 쓰기 예방")
  assert.ok(!existsSync(join(root, "ignored", "ign-escape.txt")), "gitignore된 경로 쓰기 예방")
  assert.equal(readFileSync(join(root, "src", "keep.js"), "utf8"), "keep")
  assert.equal(readFileSync(join(root, "ignored", "keep.txt"), "utf8"), "keep")
  assert.equal(readFileSync(join(root, ".harnie", "active.json"), "utf8"), sentinelBefore, "authority state 불변")
  assert.equal(JSON.parse(sentinelBefore).slug, "feat-x")
  assert.ok(existsSync(join(dir, "trials")))
})

test("assertConfinement: 가두지 못하는 래퍼면 실행 前 fail-closed(플랫폼 구현을 신뢰하지 않는다)", () => {
  const work = mkdtempSync(join(tmpdir(), "harnie-noconfine-"))
  // pass-through 래퍼 = confinement 없음 → 카나리아가 (전용 임시 경로) 밖 쓰기에 성공하므로 반드시 throw.
  assert.throws(() => assertConfinement({ work, wrap: (exe, args) => [exe, args], env: process.env }),
    (e) => e instanceof FailClosed && /카나리아 실패/.test(e.message))
  // 실제 플랫폼 confinement는 통과해야 한다(과잉 차단도 실패로 잡는다).
  const base = mkdtempSync(join(tmpdir(), "harnie-confine-"))
  const c = makeConfinement(base)
  if (c) {
    const w2 = join(base, "work"); mkdirSync(w2, { recursive: true }); mkdirSync(join(base, "tmp"), { recursive: true })
    assert.doesNotThrow(() => assertConfinement({ work: w2, wrap: c.wrap, env: { ...process.env, TMPDIR: join(base, "tmp"), PWD: w2 } }))
  }
})

// CR-009 회귀: 카나리아는 사용자 데이터가 있는 경로(live repo·$HOME)에 **쓰지도, 지우지도** 않는다.
test("assertConfinement(CR-009): live repo·$HOME에 쓰지 않고, 같은 이름의 기존 파일도 건드리지 않음", () => {
  const work = mkdtempSync(join(tmpdir(), "harnie-cr009-work-"))
  const liveRepo = mkdtempSync(join(tmpdir(), "harnie-cr009-live-"))
  const home = mkdtempSync(join(tmpdir(), "harnie-cr009-home-"))
  // 과거 구현이 쓰고/지웠던 예측 가능한 이름의 사용자 파일을 미리 심어 둔다.
  const victimNames = [`.harnie-confinement-canary-${process.pid}`, ".harnie-canary", "canary.txt"]
  for (const d of [liveRepo, home]) for (const n of victimNames) writeFileSync(join(d, n), "USER DATA")
  const beforeLive = readdirSync(liveRepo).sort()
  const beforeHome = readdirSync(home).sort()
  const prevHome = process.env.HOME
  process.env.HOME = home
  try {
    // ⓐ pass-through(격리 없음) = 카나리아가 실제로 쓸 수 있는 최악 조건.
    assert.throws(() => assertConfinement({ work, wrap: (exe, args) => [exe, args], env: { ...process.env, HOME: home } }), FailClosed)
    // ⓑ 리뷰 재현 조건: 요청된 쓰기를 **전혀 수행하지 않고 항상 exit 1**인 래퍼(과거엔 이 상태에서도 기존 파일이 삭제됐다).
    const neverWrites = (exe) => [exe, ["-e", "process.exit(1)"]]
    assert.throws(() => assertConfinement({ work, wrap: neverWrites, env: { ...process.env, HOME: home } }), FailClosed)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
  // ① 새 파일이 생기지 않았고 ② 기존 파일이 삭제·truncate되지 않았다.
  assert.deepEqual(readdirSync(liveRepo).sort(), beforeLive, "live repo에 쓰기·삭제 없음")
  assert.deepEqual(readdirSync(home).sort(), beforeHome, "$HOME에 쓰기·삭제 없음")
  for (const d of [liveRepo, home]) for (const n of victimNames) assert.equal(readFileSync(join(d, n), "utf8"), "USER DATA")
})

// CR-008 부류 방지는 이제 "경로 열거"가 아니라 **허용 규칙 최소화**로 보장한다 → 프로파일 자체를 정적으로 검사.
test("sandboxProfile: 쓰기 허용은 sandbox base + /dev/null 리터럴뿐(과대 허용 금지)", { skip: process.platform !== "darwin" }, () => {
  const base = mkdtempSync(join(tmpdir(), "harnie-profile-"))
  const p = sandboxProfile(base)
  const allowWrites = p.split("\n").filter((l) => l.includes("allow file-write*"))
  assert.equal(allowWrites.length, 1, "쓰기 허용 규칙은 정확히 한 줄")
  assert.ok(p.includes("(deny file-write*)"), "기본은 전체 쓰기 deny")
  assert.ok(allowWrites[0].includes(`(subpath ${JSON.stringify(realpathSync(base))})`), "sandbox base만 subpath 허용")
  assert.equal((allowWrites[0].match(/\(subpath /g) || []).length, 1, "subpath 허용은 base 하나뿐(예: /dev·/dev/shm 금지)")
  assert.ok(!/\(subpath "\/dev"\)/.test(p), "(subpath \"/dev\") 과대 허용 없음")
  assert.equal((allowWrites[0].match(/\(literal /g) || []).length, 1)
  assert.ok(allowWrites[0].includes('(literal "/dev/null")'), "유일한 리터럴 예외는 bit bucket /dev/null")
})

test("실제 프로파일 통합: sandbox 밖(throwaway) 쓰기 거부·안쪽 쓰기 허용·자식 spawn 정상", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") }, () => {
  const base = mkdtempSync(join(tmpdir(), "harnie-integ-"))
  const work = join(base, "work"); mkdirSync(work, { recursive: true }); mkdirSync(join(base, "tmp"), { recursive: true })
  const outsideDir = mkdtempSync(join(tmpdir(), "harnie-integ-out-")) // throwaway
  const c = makeConfinement(base)
  const env = { ...process.env, TMPDIR: join(base, "tmp"), PWD: work }
  const runIn = (code) => {
    const [e, a] = c.wrap(process.execPath, ["-e", code], work)
    return execFileSyncStatus(e, a, work, env)
  }
  const outTarget = join(outsideDir, "escape.txt")
  assert.notEqual(runIn(`require('node:fs').writeFileSync(${JSON.stringify(outTarget)},'x')`), 0, "밖 쓰기는 실패")
  assert.ok(!existsSync(outTarget), "밖 파일 미생성")
  assert.equal(runIn("require('node:fs').writeFileSync('inside.txt','x')"), 0, "안쪽 쓰기는 성공")
  assert.ok(existsSync(join(work, "inside.txt")))
  // /dev/null 리터럴 허용이 필요한 실제 이유: 자식을 stdio:'ignore'로 띄우는 흔한 패턴.
  assert.equal(runIn("const r=require('node:child_process').spawnSync(process.execPath,['-e','0'],{stdio:'ignore'});if(r.status!==0||r.error)throw new Error('child failed')"), 0)
})

test("makeConfinement: 검증된 플랫폼만 지원(그 외 null → trial은 실행 前 fail-closed)", () => {
  const base = mkdtempSync(join(tmpdir(), "harnie-kind-"))
  const c = makeConfinement(base)
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    assert.equal(c.kind, "sandbox-exec")
  } else {
    // Linux(bwrap)는 격리 프로파일 수정 + 실기 검증 전까지 의도적 미지원(CR-008) → null이어야 한다.
    assert.equal(c, null)
  }
})

test("등록 게이트: 영수증을 손으로 위조해도 키 불일치면 거부(자기진술 차단)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  // 임의 키 디렉터리에 "성공했다"는 영수증을 심어도 항목 키와 일치하지 않아 인정되지 않는다.
  mkdirSync(join(dir, "trials", "f".repeat(64)), { recursive: true })
  writeFileSync(join(dir, "trials", "f".repeat(64), "receipt.json"), JSON.stringify({ key: "f".repeat(64), exitCode: 0, vacuous: false }))
  const r = armApproval(root, "feat-x", { question: AQ, approveOption: "승인" })
  assert.equal(r.ok, false)
  assert.match(r.reason, /격리 실행 영수증 없음/)
  // trialGate 직접 호출로도 동일
  const block = extractManifestBlock(readFileSync(join(dir, "plan.md"), "utf8"))
  assert.equal(trialGate(dir, block).length, 2)
})

test("등록 게이트: 시행이 공허하면 등록 거부(`node --test <매치 0건 glob>` — 실제 사고 형태)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--test", "nomatch-*.test.mjs"], cwd: ".", timeout: 60000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  const t = run(["trial", "--root", root, "--slug", "feat-x"])
  assert.equal(t.ok, false)
  assert.equal(t.trials[0].exitCode, 0, "매치 0건인데도 0으로 통과")
  assert.ok(t.trials[0].vacuous)
  const r = armApproval(root, "feat-x", { question: AQ, approveOption: "승인" })
  assert.equal(r.ok, false)
  assert.match(r.reason, /공허함/)
  assert.ok(!existsSync(join(dir, "manifest.json")))
})

test("등록 게이트: 조용한 검증기는 evidencePolicy 명시로 등록 가능(무출력 면제)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["-e", ""], cwd: ".", timeout: 30000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  // 정책 미지정 → 무출력은 공허 → 등록 거부
  assert.equal(run(["trial", "--root", root, "--slug", "feat-x"]).ok, false)
  assert.match(armApproval(root, "feat-x", { question: AQ, approveOption: "승인" }).reason, /공허함/)
  // exit-code-only 명시 → 등록 가능
  const root2 = gitRepo()
  writePlan(root2, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["-e", ""], cwd: ".", timeout: 30000, evidencePolicy: "exit-code-only" }] }], gates: GATES })
  run(["init", "--root", root2, "--slug", "feat-x"])
  assert.equal(run(["trial", "--root", root2, "--slug", "feat-x"]).ok, true)
  assert.equal(armApproval(root2, "feat-x", { question: AQ, approveOption: "승인" }).ok, true)
})

test("등록 게이트: 실패한 시행(exitCode≠0)은 정상 — 구현 前 실패는 등록을 막지 않는다", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", { tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--test", "src/a/not-created-yet.test.mjs"], cwd: ".", timeout: 60000 }] }], gates: GATES })
  run(["init", "--root", root, "--slug", "feat-x"])
  const t = run(["trial", "--root", root, "--slug", "feat-x"])
  assert.notEqual(t.trials[0].exitCode, 0)      // 아직 없는 테스트 파일 → 실패
  assert.equal(t.trials[0].vacuous, false)      // 실패는 공허가 아님
  assert.equal(armApproval(root, "feat-x", { question: AQ, approveOption: "승인" }).ok, true)
})

// ── #2 pending-route 이탈 경로의 훅 예외 판정 ────────────────────────────
test("isRouteAbandonCli: 이 세션의 route-abandon만 통과(그 외 전부 거부)", () => {
  const root = "/repo"
  const cli = "/plugin/scripts/execution.mjs"
  const trustedClis = new Set([cli, "/plugin/scripts/loop.mjs"])
  const ctx = { trustedClis, root, sessionId: "sess-1" }
  const ok = (c) => isRouteAbandonCli(c, ctx)
  // 통과: 정확한 argv(상대 root 표기·--reason 포함 허용)
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session sess-1`), true)
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session sess-1 --reason 선행마이그레이션필요`), true)
  assert.equal(ok(`node ${cli} route-abandon --root ${root}/. --session sess-1`), true)
  // 거부: 다른 세션 / root 불일치 / 다른 서브커맨드 / 신뢰 밖 스크립트 / 위장 인터프리터
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session other`), false)
  assert.equal(ok(`node ${cli} route-abandon --root /other --session sess-1`), false)
  assert.equal(ok(`node ${cli} route-abandon --session sess-1`), false)
  assert.equal(ok(`node ${cli} completion --root ${root} --slug s`), false)
  assert.equal(ok(`node /tmp/scripts/execution.mjs route-abandon --root ${root} --session sess-1`), false)
  assert.equal(ok(`/tmp/node ${cli} route-abandon --root ${root} --session sess-1`), false)
  // 거부: 셸 메타·중복 플래그·규약 밖 플래그
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session sess-1; rm -rf /`), false)
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session sess-1 > /tmp/x`), false)
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session sess-1 --root /other`), false)
  assert.equal(ok(`node ${cli} route-abandon --root ${root} --session sess-1 --slug s`), false)
  // 컨텍스트 부재(active root·session 미지정)면 예외 없음(fail-closed)
  assert.equal(isRouteAbandonCli(`node ${cli} route-abandon --root ${root} --session sess-1`, { trustedClis, root, sessionId: null }), false)
  assert.equal(isRouteAbandonCli(`node ${cli} route-abandon --root ${root} --session sess-1`, { trustedClis, root: null, sessionId: "sess-1" }), false)
})

// ── #3 passive resume 소유권 이전 ────────────────────────────────────────
test("bootstrapRun resume: 소유권을 재개 세션으로 이전(죽은 세션이 owner로 남지 않음)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "feat-x", sessionId: "sess-old" })
  assert.equal(readSentinel(root).sessionId, "sess-old")
  const r = bootstrapRun(root, { base: "feat-x", sessionId: "sess-new" }) // 같은 작업 passive resume
  assert.equal(r.reused, true)
  assert.equal(readSentinel(root).sessionId, "sess-new", "resume 세션이 owner")
  assert.equal(loadContext(root).sessionId, "sess-new")
  // sessionId 없이 resume → stale owner를 남기지 않고 소유자 미지(게이트 없음)
  bootstrapRun(root, { base: "feat-x" })
  assert.equal(readSentinel(root).sessionId, undefined)
  // resume이 run 내용을 훼손하지 않음(track·slug·base 유지)
  const s = readSentinel(root)
  assert.equal(s.slug, "feat-x"); assert.equal(s.base, "feat-x"); assert.equal(s.track, "plan")
})

// ── #4 손상 run은 park로 숨길 수 없다 ────────────────────────────────────
test("park 거부: execution.json 부재·손상·불일치·미승인 executing 주장(손상 세탁 차단)", () => {
  const root = gitRepo()
  bootstrapWithPlan(root, "feat-x")
  const execPath = join(root, ".harnie", "plan", "feat-x", "execution.json")
  // ① 부재
  rmSync(execPath)
  assert.throws(() => parkRun(root, { slug: "feat-x" }), (e) => e instanceof FailClosed && /execution.json 부재/.test(e.message))
  assert.ok(existsSync(join(root, ".harnie", "active.json")), "거부 시 포인터 불변(여전히 fail-closed 상태)")
  // ② JSON 손상
  writeFileSync(execPath, "{ not json")
  assert.throws(() => parkRun(root, { slug: "feat-x" }), FailClosed)
  // ③ sentinel 불일치
  writeFileSync(execPath, JSON.stringify({ track: "plan", slug: "other", phase: "planning", tasks: {} }))
  assert.throws(() => parkRun(root, { slug: "feat-x" }), (e) => e instanceof FailClosed && /불일치/.test(e.message))
  // ④ 미승인인데 executing 주장(승인 우회 흔적)
  writeFileSync(execPath, JSON.stringify({ track: "plan", slug: "feat-x", phase: "executing", tasks: {} }))
  assert.throws(() => parkRun(root, { slug: "feat-x" }), (e) => e instanceof FailClosed && /승인 우회/.test(e.message))
  assert.ok(existsSync(join(root, ".harnie", "active.json")))
  assert.ok(!existsSync(parkedPtr(root, "feat-x")))
  // 정상 상태로 되돌리면 park 성공
  writeFileSync(execPath, JSON.stringify({ track: "plan", slug: "feat-x", planHash: null, phase: "planning", tasks: {} }))
  assert.equal(parkRun(root, { slug: "feat-x" }).ok, true)
})

test("bootstrapRun: 새 run 생성 시 같은 base의 parked 후보와 resume 명령 안내(자동 재개 없음)", () => {
  const root = gitRepo()
  bootstrapWithPlan(root, "feat-x")
  parkRun(root, { slug: "feat-x" })
  const r = bootstrapRun(root, { base: "feat-x", sessionId: "s2" })
  assert.equal(r.reused, false)
  assert.equal(r.slug, "feat-x-2", "자동 재개하지 않고 새 run")
  assert.deepEqual(r.parkedCandidates, ["feat-x"])
  assert.match(r.hint, /resume --root/)
})

// ── verify e2e: 공허한 통과 탐지 ─────────────────────────────────────────
// reviewedPostSHA + ledger·state를 채워 verify를 실행할 수 있게 만드는 헬퍼(단일 task manifest).
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
