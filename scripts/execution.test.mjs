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
  registerBuilderAuto,
  setTaskRunStatus, recordBuilderCall, taskWatchdogUsage, watchdogExtend,
  bootstrapRun, slugify, withStateLock,
  detectVacuous, loadContext, validateRepoBinding,
  rebindTask,
  setMode, setDifficulty, readMode, computeCompletion, rebindArm, recordPendingRebind, bindRebind, approveCli,
  abandonRun, listRuns, handoffRun, rebindTree, treeDrift,
} from "./execution.mjs"
import { captureTree } from "./delta.mjs"

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

test("validateManifest: difficulty는 선택 — easy|medium|hard|very-hard 외 값은 거부", () => {
  const withDiff = (difficulty) => ({ ...GOOD_MANIFEST, ...(difficulty === undefined ? {} : { difficulty }) })
  assert.deepEqual(validateManifest(withDiff(undefined)), [])
  assert.deepEqual(validateManifest(withDiff("hard")), [])
  assert.deepEqual(validateManifest(withDiff("very-hard")), [])
  assert.ok(validateManifest(withDiff("extreme")).some((e) => /difficulty/.test(e)))
  // canonicalManifest: difficulty 있을 때만 포함(기존 manifest planHash 불변)
  assert.deepEqual(Object.keys(canonicalManifest(GOOD_MANIFEST)), ["tasks", "gates"])
  assert.equal(canonicalManifest(withDiff("hard")).difficulty, "hard")
})

test("validateManifest: timeout 1000ms 미만은 단위 착오 의심으로 거부", () => {
  const withTimeout = (timeout) => ({ tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["s/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout }] }], gates: GATES })
  assert.ok(validateManifest(withTimeout(60)).some((e) => /1000ms 미만 거부/.test(e)))   // 초 단위로 적은 실수
  assert.ok(validateManifest(withTimeout(999)).some((e) => /1000ms 미만 거부/.test(e)))
  assert.deepEqual(validateManifest(withTimeout(1000)), [])
  assert.deepEqual(validateManifest(withTimeout(60000)), [])
  assert.ok(validateManifest(withTimeout(0)).some((e) => /양의 정수/.test(e)))           // 기존 검사 유지
})

test("validateManifest: task 간 scope 겹침(동일·부모/자식)은 거부, 다른 repo 간은 허용", () => {
  const mk = (scopes, repos = [null, null]) => ({
    tasks: [
      { id: "T1", deps: [], reviewUnit: "task-a", scope: scopes[0], verification: VER(), ...(repos[0] ? { repo: repos[0] } : {}) },
      { id: "T2", deps: [], reviewUnit: "task-b", scope: scopes[1], verification: VER(), ...(repos[1] ? { repo: repos[1] } : {}) },
    ],
    gates: GATES,
  })
  assert.ok(validateManifest(mk([["src/a/"], ["src/a/"]])).some((e) => /scope 겹침/.test(e)))          // 동일 경로
  assert.ok(validateManifest(mk([["src/"], ["src/a/x.mjs"]])).some((e) => /scope 겹침/.test(e)))       // 부모/자식
  assert.ok(validateManifest(mk([["src/a/x.mjs"], ["src/"]])).some((e) => /scope 겹침/.test(e)))       // 자식/부모(순서 무관)
  assert.deepEqual(validateManifest(mk([["src/a/"], ["src/b/"]])), [])                                  // disjoint
  assert.deepEqual(validateManifest(mk([["src/ab/"], ["src/a/"]])), [])                                 // 접두 문자열이지만 디렉터리 경계 밖
  assert.deepEqual(validateManifest(mk([["src/"], ["src/"]], ["repoA", "repoB"])), [])                  // 다른 repo면 겹침 아님
  assert.ok(validateManifest(mk([["src/"], ["src/"]], ["repoA", "repoA"])).some((e) => /scope 겹침/.test(e)))
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

test("bindApproval: 재승인으로 manifest 개정 — 이전 정본 아카이브, planHash 일관 갱신", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const r1 = approveFlow(root, "feat-x", "tu-1")
  assert.equal(r1.ok, true)
  const firstHash = r1.planHash
  // 같은 planHash 재승인은 멱등(아카이브 없음)
  const rSame = approveFlow(root, "feat-x", "tu-2")
  assert.equal(rSame.ok, true)
  assert.equal(existsSync(join(dir, "manifest.v1.json")), false)
  // manifest 결함 발견 → plan.md의 블록을 고치고(예: timeout 정정) 재승인
  const revised = JSON.parse(JSON.stringify(GOOD_MANIFEST))
  revised.tasks[0].verification[0].timeout = 600000
  writePlan(root, "feat-x", revised)
  const r2 = approveFlow(root, "feat-x", "tu-3")
  assert.equal(r2.ok, true)
  assert.notEqual(r2.planHash, firstHash)
  const cur = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  assert.equal(cur.planHash, r2.planHash)
  assert.equal(cur.tasks[0].verification[0].timeout, 600000)
  const v1 = JSON.parse(readFileSync(join(dir, "manifest.v1.json"), "utf8"))
  assert.equal(v1.planHash, firstHash)                    // 감사용 아카이브
  assert.equal(v1.supersededBy, r2.planHash)
  assert.equal(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).planHash, r2.planHash)
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).planHash, r2.planHash)
})

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

test("seal: 멱등 — 같은 권위 상태로 두 번 호출해도 거부 없이 같은 seal", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const first = run(["seal", "--root", root, "--slug", "feat-x"])
  const stored = JSON.parse(readFileSync(join(dir, ".seal.json"), "utf8"))
  const second = run(["seal", "--root", root, "--slug", "feat-x"])
  assert.equal(second.ok, true)
  assert.equal(second.sealHash, first.sealHash)
  assert.equal(second.unchanged, true)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".seal.json"), "utf8")), stored, "재호출로 seal 상태가 바뀌지 않는다")
  assert.equal(run(["seal-verify", "--root", root, "--slug", "feat-x"]).sealMismatch, false)
})

test("seal: 미검증 seal 위의 baseline 오염 재-seal은 fail-closed, verify 후에는 재-seal 허용", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  mkdirSync(join(dir, "review", "task-a"), { recursive: true })
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), "{}")
  const first = run(["seal", "--root", root, "--slug", "feat-x"])
  // 빌더가 권위 ledger를 변경한 뒤 재-seal 시도 → 새 baseline으로 흡수되면 안 된다
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), '{"CR-001":{"id":"CR-001"}}')
  const e = runFail(["seal", "--root", root, "--slug", "feat-x"])
  assert.ok(e, "미검증 seal + 변경된 권위 상태의 재-seal은 거부")
  assert.equal(JSON.parse(readFileSync(join(dir, ".seal.json"), "utf8")).sealHash, first.sealHash)
  // seal-verify가 mismatch를 보고하며 seal을 소비한다
  assert.ok(runFail(["seal-verify", "--root", root, "--slug", "feat-x"]).status === 3)
  // 오염 상태 그대로의 재-seal은 여전히 거부 — mismatch 라운드의 오염이 다음 baseline으로 흡수되면 안 된다
  assert.ok(runFail(["seal", "--root", root, "--slug", "feat-x"]), "mismatch 후 오염 상태 재-seal은 거부")
  assert.equal(JSON.parse(readFileSync(join(dir, ".seal.json"), "utf8")).sealHash, first.sealHash)
  // 명시 승인(--after-mismatch)으로만 새 baseline 인정
  const forced = run(["seal", "--root", root, "--slug", "feat-x", "--after-mismatch"])
  assert.notEqual(forced.sealHash, first.sealHash)
  assert.equal(run(["seal-verify", "--root", root, "--slug", "feat-x"]).sealMismatch, false)
})

test("seal: mismatch 후 권위 파일을 복구하면 명시 승인 없이 원래 baseline으로 재-seal", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  mkdirSync(join(dir, "review", "task-a"), { recursive: true })
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), "{}")
  const first = run(["seal", "--root", root, "--slug", "feat-x"])
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), '{"CR-001":{"id":"CR-001"}}')
  assert.ok(runFail(["seal-verify", "--root", root, "--slug", "feat-x"]).status === 3)
  writeFileSync(join(dir, "review", "task-a", "ledger.json"), "{}") // 복구
  const again = run(["seal", "--root", root, "--slug", "feat-x"])
  assert.equal(again.sealHash, first.sealHash)
  assert.equal(again.recoveredFromMismatch, true)
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

test("registerBuilderAuto: run-root 부트스트랩 marker만 지정 task에 귀속, cwd 불일치는 거부", () => {
  const root = gitRepo(), slug = "feat-x"
  const dir = join(root, ".harnie", "plan", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, ".harnie", "active.json"), JSON.stringify({ track: "plan", slug }))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tasks: [{ id: "1" }, { id: "2" }] }))
  const exPath = join(dir, "execution.json")
  writeFileSync(exPath, JSON.stringify({ track: "plan", slug, tasks: { "1": { runStatus: "building", builderThreadId: null }, "2": { runStatus: "building", builderThreadId: null } } }))
  // marker 없음 + building-unbound 2개 → serial 예외 불가(모호)
  assert.equal(registerBuilderAuto(root, slug, "thread-x", root).ok, false)
  const ex = JSON.parse(readFileSync(exPath, "utf8")); ex.pendingRunRootBootstrap = "1"; writeFileSync(exPath, JSON.stringify(ex))
  // run root 밖 cwd는 귀속 대상이 아니다
  assert.equal(registerBuilderAuto(root, slug, "wrong-root", gitRepo()).ok, false)
  assert.equal(JSON.parse(readFileSync(exPath, "utf8")).tasks["1"].builderThreadId, null)
  // run root cwd + marker → marker task에 귀속하고 marker를 소거
  assert.equal(registerBuilderAuto(root, slug, "thread-1", root).taskId, "1")
  const after = JSON.parse(readFileSync(exPath, "utf8"))
  assert.equal(after.tasks["1"].builderThreadId, "thread-1")
  assert.equal(after.pendingRunRootBootstrap, undefined)
})

test("registerBuilderAuto: plan execution 상태가 없으면 quick-track 호출을 no-op", () => {
  const root = gitRepo()
  assert.deepEqual(registerBuilderAuto(root, "quick-fix", "thread-1", root), {
    ok: false,
    reason: "plan 실행 상태 없음 — 자동 귀속 대상 아님",
  })
})

test("registerBuilderAuto: marker 없는 root cwd는 단일 building-unbound일 때만 귀속", () => {
  const serial = gitRepo()
  writePlan(serial, "feat-x"); run(["init", "--root", serial, "--slug", "feat-x"]); approveFlow(serial)
  setTaskRunStatus(serial, "feat-x", "T1", "building")
  assert.equal(registerBuilderAuto(serial, "feat-x", "serial-thread", serial).taskId, "T1")

  const parallel = gitRepo()
  writePlan(parallel, "feat-x"); run(["init", "--root", parallel, "--slug", "feat-x"]); approveFlow(parallel)
  setTaskRunStatus(parallel, "feat-x", "T1", "building"); setTaskRunStatus(parallel, "feat-x", "T2", "building")
  assert.equal(registerBuilderAuto(parallel, "feat-x", "ambiguous-thread", parallel).ok, false)
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
  ex.tasks.T1.watchdogExtensions = [{ at: "earlier", reason: "auto-cap" }]
  writeFileSync(execPath, JSON.stringify(ex))
  setTaskRunStatus(root, "feat-x", "T1", "building")
  ex = JSON.parse(readFileSync(execPath, "utf8"))
  assert.equal(ex.tasks.T1.startedAt, startedAt)
  assert.equal(ex.tasks.T1.codexCalls, 7)
  assert.deepEqual(ex.tasks.T1.watchdogExtensions, [{ at: "earlier", reason: "auto-cap" }])
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

test("watchdog-extend: 카운터 리셋 없이 연장 이력만 누적(0.11 — effective 예산 확대), 사유 없으면 fail-closed", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "builder-1")
  recordBuilderCall(root, "feat-x", "builder-1")
  assert.equal(watchdogExtend(root, "feat-x", "T1", "사용자 승인").extensions, 1)
  const usage = taskWatchdogUsage(root, "feat-x", { taskId: "T1" })
  assert.equal(usage.codexCalls, 1) // 리셋 없음 — 누적 유지(예산 우회 방지)
  assert.equal(usage.extensions, 1)
  assert.ok(usage.startedAt)
  assert.ok(usage.builderBoundAt) // 첫 바인딩 시각(워치독 기산점)
  assert.throws(() => watchdogExtend(root, "feat-x", "T1", ""), FailClosed)
})

test("watchdog-extend: auto-cap은 task당 1회만 허용", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  assert.equal(watchdogExtend(root, "feat-x", "T1", "auto-cap").extensions, 1)
  assert.throws(() => watchdogExtend(root, "feat-x", "T1", "auto-cap"), /1회만/)
  assert.equal(watchdogExtend(root, "feat-x", "T1", "사용자 승인").extensions, 2)
  setTaskRunStatus(root, "feat-x", "T2", "building")
  watchdogExtend(root, "feat-x", "T2", "사용자 승인")
  assert.throws(() => watchdogExtend(root, "feat-x", "T2", "auto-cap"), /총 예산 최대 2×/)
})

test("execution.json 경합: 동시 set-task가 두 task 상태를 모두 보존", async () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const child = (task) => new Promise((resolve) => execFile("node", [CLI, "set-task", "--root", root, "--slug", "feat-x", "--task", task, "--run-status", "building"], (err) => resolve(err)))
  const errors = await Promise.all([child("T1"), child("T2")])
  assert.deepEqual(errors, [null, null])
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.tasks.T1.runStatus, "building")
  assert.equal(ex.tasks.T2.runStatus, "building")
  assert.ok(ex.tasks.T1.startedAt && ex.tasks.T2.startedAt)
})

test("계획 승인 arm은 rebind arm과 상호 배타(타입 무관 원샷)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "dead-th")
  const EV = "MCP error: Session not found for thread_id dead-th"
  assert.equal(armApproval(root, "feat-x").ok, true)
  assert.throws(() => rebindArm(root, "feat-x", { taskId: "T1", oldThread: "dead-th", evidence: EV }), /상호배제/)
  recordPendingApproval(root, "feat-x", "ask-1")
  assert.throws(() => rebindArm(root, "feat-x", { taskId: "T1", oldThread: "dead-th", evidence: EV }), /상호배제/)
  assert.equal(existsSync(join(dir, ".arm-rebind.json")), false)
})

test("rebind-task: finding 라운드도 카운터·기산점을 리셋하지 않는다(0.11 DR-107 — 예산 우회 방지)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "old-thread")
  const execPath = join(root, ".harnie", "plan", "feat-x", "execution.json")
  const ex = JSON.parse(readFileSync(execPath, "utf8"))
  ex.tasks.T1.runStatus = "built"
  ex.tasks.T1.startedAt = "2000-01-01T00:00:00.000Z"
  ex.tasks.T1.builderBoundAt = "2000-01-01T00:00:00.000Z"
  ex.tasks.T1.codexCalls = 7
  ex.tasks.T1.watchdogExtensions = [{ at: "earlier", reason: "auto-cap" }]
  writeFileSync(execPath, JSON.stringify(ex))
  rebindTask(root, "feat-x", { taskId: "T1", reason: "finding:final-review:CR-001" })
  const rebound = JSON.parse(readFileSync(execPath, "utf8")).tasks.T1
  assert.equal(rebound.startedAt, "2000-01-01T00:00:00.000Z")
  assert.equal(rebound.builderBoundAt, "2000-01-01T00:00:00.000Z")
  assert.equal(rebound.codexCalls, 7)
  assert.equal(rebound.builderThreadId, null)
  assert.deepEqual(rebound.watchdogExtensions, [{ at: "earlier", reason: "auto-cap" }])
})

test("rebind-task: finding:<unit>:CR-NNN·verification:integration만 유효한 사유(errata correction 소멸)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "old-thread")
  assert.throws(() => rebindTask(root, "feat-x", { taskId: "T1", reason: "finding:CR-042" }), /형식 오류/)      // 유닛 식별자 필수
  assert.throws(() => rebindTask(root, "feat-x", { taskId: "T1", reason: "finding:final-review:DR-001" }), /형식 오류/)
  assert.throws(() => rebindTask(root, "feat-x", { taskId: "T1", reason: "correction:E-001" }), /형식 오류/)   // errata 삭제(0.13)
  assert.equal(rebindTask(root, "feat-x", { taskId: "T1", reason: "finding:final-review:CR-042" }).pendingRunRootBootstrap, "T1")
  rebindTask(root, "feat-x", { taskId: "T1", reason: `approved-artifact:${"a".repeat(40)}`, cancel: true })
  registerBuilderThread(root, "feat-x", "T1", "new-thread")
  assert.equal(rebindTask(root, "feat-x", { taskId: "T1", reason: "verification:integration" }).pendingRunRootBootstrap, "T1")
})

test("rebind-task: 중복 marker 거부·cancel 감사 기록", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "old-thread")
  assert.equal(rebindTask(root, "feat-x", { taskId: "T1", reason: "finding:final-review:CR-001" }).pendingRunRootBootstrap, "T1")
  assert.throws(() => rebindTask(root, "feat-x", { taskId: "T1", reason: "finding:final-review:CR-002" }), /이미 존재/)
  assert.equal(rebindTask(root, "feat-x", { taskId: "T1", reason: `approved-artifact:${"a".repeat(40)}`, cancel: true }).pendingRunRootBootstrap, null)
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.deepEqual(ex.threadRebindings.map((e) => e.action), ["rebind", "cancel"])
  assert.equal(ex.threadRebindings[0].oldThreadId, "old-thread")
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

// M의 예약 설계 리뷰 유닛을 APPROVED로 채운다. DR 유닛이라 아티팩트는 `dr:` 해시이고 tree에 바인딩되지 않는다.
function approveDesignUnit(root, slug) {
  const dd = join(root, ".harnie", "plan", slug, "review", "design")
  mkdirSync(dd, { recursive: true })
  // 빈 원장은 namespace 검사를 돌 대상이 없어 무조건 통과한다 — 실제 DR 엔트리를 넣어야 회귀를 잡는다.
  writeFileSync(join(dd, "ledger.json"), JSON.stringify({
    "DR-001": { id: "DR-001", blocking: true, status: "resolved", location: "design", text: "resolved design finding" },
  }))
  writeFileSync(join(dd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: "dr:" + "a".repeat(64) }))
  return dd
}

test("completion: errata는 완료 입력이 아니다(0.13 삭제) — 잔존 errata.md도 M 완료를 막지 않는다", () => {
  const root = gitRepo()
  const dir = makeCompleteRun(root, "m-complete")
  assert.equal(run(["completion", "--root", root, "--slug", "m-complete"]).complete, true)
  mkdirSync(join(dir, "design"), { recursive: true })
  writeFileSync(join(dir, "design", "errata.md"), "## E-001\n- severity: blocker\n- disposition: pending\n")
  assert.equal(run(["completion", "--root", root, "--slug", "m-complete"]).complete, true)
})

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

// 0.14 DEC-3: 완료 판정은 트리에 대해 얼어붙지 않는다. 완료를 판정한 그 자리에서 닫힘을 디스크에 못박지
// 않으면, 사용자가 트리를 한 줄 고치는 순간 과거에 닫힌 run들이 전부 소급으로 재개 목록에 되살아난다.
test("bootstrapRun: rollover(완료 run → 새 run)는 이전 run의 execution.json에 closedAt을 못박는다", () => {
  const root = gitRepo()
  makeCompleteRun(root, "feat-x")
  const oldExec = join(root, ".harnie", "plan", "feat-x", "execution.json")
  assert.equal(JSON.parse(readFileSync(oldExec, "utf8")).closedAt, undefined)
  const r = bootstrapRun(root, { base: "feat-y" })
  assert.equal(r.reused, false)
  assert.equal(readSentinel(root).slug, "feat-y")
  const closedAt = JSON.parse(readFileSync(oldExec, "utf8")).closedAt
  assert.match(String(closedAt), /^\d{4}-\d{2}-\d{2}T/)
  // 트리를 고쳐 옛 run이 소급 미완료가 돼도 닫힘 기록은 남는다 — 그것이 `runs`가 읽는 값이다.
  writeFileSync(join(root, "drift.txt"), "무관한 편집\n")
  assert.equal(computeCompletion(root, "plan", "feat-x").complete, false)
  assert.equal(JSON.parse(readFileSync(oldExec, "utf8")).closedAt, closedAt)
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

test("validateManifest: setup은 선택 — shape·timeout 하한 검증, evidencePolicy 금지", () => {
  const withSetup = (setup) => ({ tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["s/"], setup, verification: VER() }], gates: GATES })
  assert.deepEqual(validateManifest(withSetup([{ executable: "uv", args: ["run", "pytest", "--collect-only"], cwd: ".", timeout: 300000 }])), [])
  assert.ok(validateManifest(withSetup([])).some((e) => /setup은 생략 또는 비어있지 않은 배열/.test(e)))
  assert.ok(validateManifest(withSetup([{ executable: "uv", args: [], cwd: ".", timeout: 60 }])).some((e) => /setup\[0\].timeout.*1000ms 미만/.test(e)))
  assert.ok(validateManifest(withSetup([{ executable: "uv", args: [], cwd: ".", timeout: 60000, evidencePolicy: "exit-code-only" }])).some((e) => /evidencePolicy 불가/.test(e)))
})

test("verify: setup 성공 시 verification 진행, setup 실패 시 verification 미실행·receipt 실패", () => {
  const okRoot = gitRepo()
  mkdirSync(join(okRoot, "src", "a"), { recursive: true })
  writeFileSync(join(okRoot, "src", "a", "x.test.mjs"), 'import {test} from "node:test"\ntest("alpha",()=>{})\n')
  readyForVerify(okRoot, {
    tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], setup: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }], verification: [{ executable: "node", args: ["--test", "src/a/x.test.mjs"], cwd: ".", timeout: 60000 }] }],
    gates: GATES,
  })
  const ok = run(["verify", "--root", okRoot, "--slug", "feat-x", "--task", "T1"])
  assert.equal(ok.ok, true, JSON.stringify(ok.receipt))
  assert.equal(ok.receipt.setupResults.length, 1)
  assert.equal(ok.receipt.setupResults[0].exitCode, 0)

  const failRoot = gitRepo()
  mkdirSync(join(failRoot, "src", "a"), { recursive: true })
  writeFileSync(join(failRoot, "src", "a", "x.test.mjs"), 'import {test} from "node:test"\ntest("alpha",()=>{})\n')
  readyForVerify(failRoot, {
    tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], setup: [{ executable: "node", args: ["-e", "process.exit(7)"], cwd: ".", timeout: 30000 }], verification: [{ executable: "node", args: ["--test", "src/a/x.test.mjs"], cwd: ".", timeout: 60000 }] }],
    gates: GATES,
  })
  const bad = run(["verify", "--root", failRoot, "--slug", "feat-x", "--task", "T1"])
  assert.equal(bad.ok, false)
  assert.equal(bad.receipt.exitCode, 7)             // setup의 exitCode가 receipt에 실림
  assert.deepEqual(bad.receipt.results, [])          // verification 미실행
  assert.equal(bad.receipt.vacuous, false)           // 웜업 실패는 vacuous가 아니라 실패
  const c = run(["completion", "--root", failRoot, "--slug", "feat-x"])
  assert.equal(c.complete, false)
})

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

function plainRun(base) {
  const plain = gitRepo()
  writeFileSync(join(plain, "f.txt"), "x\n")
  execFileSync("git", ["-C", plain, "add", "."])
  execFileSync("git", ["-C", plain, "commit", "-q", "-m", "init"])
  bootstrapRun(plain, { base, track: "plan", sessionId: "s1" })
  return plain
}

test("validateManifest: task.repo 형식·all-or-none", () => {
  const t = (over) => ({ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/"], verification: VER(), ...over })
  const t2 = (over) => ({ id: "T2", deps: [], reviewUnit: "task-b", scope: ["src/"], verification: VER(), ...over })
  assert.deepEqual(validateManifest({ tasks: [t({ repo: "repoA" }), t2({ repo: "nested/repoB" })], gates: GATES }), [])
  assert.ok(validateManifest({ tasks: [t({ repo: "../evil" }), t2({ repo: "x" })], gates: GATES }).some((e) => /repo 형식 오류/.test(e)))
  assert.ok(validateManifest({ tasks: [t({ repo: "a/../b" }), t2({ repo: "x" })], gates: GATES }).some((e) => /repo 형식 오류/.test(e)))
  assert.ok(validateManifest({ tasks: [t({ repo: "/abs" }), t2({ repo: "x" })], gates: GATES }).some((e) => /repo 형식 오류/.test(e)))
  assert.ok(validateManifest({ tasks: [t({ repo: "repoA" }), t2({})], gates: GATES }).some((e) => /all-or-none/.test(e)))
})

test("validateRepoBinding: task.repo는 단일 repo run에서 금지(0.13 workspace 삭제)", () => {
  const plain = plainRun("t2")
  assert.match(validateRepoBinding(plain, { tasks: [{ id: "T1", repo: "repoA" }], gates: [] }) || "", /단일 repo 전용/)
  assert.equal(validateRepoBinding(plain, { tasks: [{ id: "T1" }], gates: [] }), null)
})

// ── 0.11: mode(S/M)·통합 검증·rebind-arm·CLI 권위 ──────────────────────
const IV = [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }]
const M_MANIFEST = { tasks: [{ id: "t1", deps: [], reviewUnit: "code", scope: ["src/"], verification: VER() }], gates: [], integrationVerification: IV }

test("validateManifest(mode): M=게이트 없음, integrationVerification 필수, integration 유닛 예약", () => {
  assert.deepEqual(validateManifest(M_MANIFEST, { mode: "M" }), [])
  assert.ok(validateManifest({ ...M_MANIFEST, gates: [{ name: "final-review", reviewUnit: "final-review" }] }, { mode: "M" }).some((e) => /게이트 없음/.test(e)))
  const noIv = { ...M_MANIFEST }; delete noIv.integrationVerification
  assert.ok(validateManifest(noIv, { mode: "M" }).some((e) => /integrationVerification 필수/.test(e)))
  const reserved = { ...M_MANIFEST, tasks: [{ id: "T1", deps: [], reviewUnit: "integration", scope: ["s/"], verification: VER() }] }
  assert.ok(validateManifest(reserved, { mode: "M" }).some((e) => /예약어/.test(e)))
  // mode 미지정 = 레거시 4게이트 규칙 그대로
  assert.deepEqual(validateManifest(GOOD_MANIFEST), [])
  // canonicalManifest는 integrationVerification 포함(있을 때만 — 레거시 planHash 불변)
  assert.equal(canonicalManifest(M_MANIFEST).integrationVerification, IV)
  assert.deepEqual(Object.keys(canonicalManifest(GOOD_MANIFEST)), ["tasks", "gates"])
})

test("set-mode: 상향 전이만, sentinel/execution 불일치 fail-closed, S는 암묵 t1 등록", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  assert.equal(readMode(root, "plan", "feat-x"), "sizing")
  assert.equal(setMode(root, "feat-x", "S").mode, "S")
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.tasks.t1.runStatus, "building")
  assert.throws(() => setMode(root, "feat-x", "S"), /상향 전이만/) // 동급 재설정 금지
  assert.throws(() => setMode(root, "feat-x", "L"), /--mode는 S\|M/) // 0.13: L 삭제
  assert.equal(setMode(root, "feat-x", "M").mode, "M")
  assert.throws(() => setMode(root, "feat-x", "S"), /상향 전이만/) // 하향 금지
  const sPath = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(sPath, "utf8")); s.mode = "S"; writeFileSync(sPath, JSON.stringify(s))
  assert.throws(() => setMode(root, "feat-x", "M"), /불일치/)
  assert.equal(loadContext(root).failClosed, true) // 훅 문맥도 fail-closed
})

// DR-002: set-mode 거부만으로는 부족하다 — 디스크에 mode:"L"이 남은 업그레이드 전 run이
// 레거시 4게이트 경로로 흘러들어 부당한 완료 판정을 받는 경로를 readMode에서 막는다.
test("readMode/completion/loadContext: 디스크에 남은 미지 mode는 전부 fail-closed(0.13 삭제 모드)", () => {
  const setMirrors = (root, mode) => {
    const dir = join(root, ".harnie", "plan", "feat-x")
    for (const p of [join(root, ".harnie", "active.json"), join(dir, "execution.json")]) {
      const j = JSON.parse(readFileSync(p, "utf8")); j.mode = mode; writeFileSync(p, JSON.stringify(j))
    }
  }
  // "constructor"·"toString"은 MODE_ORDER의 프로토타입 키다 — own-key로 보지 않으면 이 검사를 통과한다.
  for (const mode of ["L", "constructor", "toString"]) {
    const root = gitRepo()
    writePlan(root, "feat-x")
    run(["init", "--root", root, "--slug", "feat-x"])
    setMirrors(root, mode)
    const re = new RegExp(`알 수 없는 mode\\(${mode}\\)`)
    assert.throws(() => readMode(root, "plan", "feat-x"), re, mode)
    assert.throws(() => computeCompletion(root, "plan", "feat-x"), re, mode)
    // 훅 문맥도 같은 허용 집합을 본다 — 미지 mode run을 정상 실행 문맥으로 열지 않는다.
    const ctx = loadContext(root)
    assert.equal(ctx.failClosed, true, mode)
    assert.match(ctx.reason, re)
  }
})

test("set-difficulty: CLI 경유 — 승인된 manifest.json 바이트·planHash 불변, execution.json.difficulty만 갱신", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  const approved = approveFlow(root, "feat-x")
  const dir = join(root, ".harnie", "plan", "feat-x")
  const manifestBytesBefore = readFileSync(join(dir, "manifest.json"))
  const r = run(["set-difficulty", "--root", root, "--slug", "feat-x", "--difficulty", "very-hard"])
  assert.equal(r.ok, true)
  assert.equal(r.difficulty, "very-hard")
  const manifestBytesAfter = readFileSync(join(dir, "manifest.json"))
  assert.ok(manifestBytesBefore.equals(manifestBytesAfter))
  const manifestAfter = JSON.parse(manifestBytesAfter.toString("utf8"))
  assert.equal(manifestAfter.planHash, approved.planHash)
  const ex = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"))
  assert.equal(ex.difficulty, "very-hard")
})

test("setDifficulty: enum 밖 값·비활성 slug는 fail-closed, 유효 값은 반복 호출 가능(멱등)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  assert.throws(() => setDifficulty(root, "feat-x", "extreme"), FailClosed)
  assert.throws(() => setDifficulty(root, "other-slug", "hard"), FailClosed)
  assert.equal(setDifficulty(root, "feat-x", "very-hard").difficulty, "very-hard")
  assert.equal(setDifficulty(root, "feat-x", "very-hard").difficulty, "very-hard")
})

test("set-difficulty CLI: 비활성 run(sentinel 없음)에 호출하면 exit 2 + FailClosed 메시지(raw ENOENT/스택 트레이스 아님)", () => {
  const root = gitRepo()
  const e = runFail(["set-difficulty", "--root", root, "--slug", "no-such-run", "--difficulty", "hard"])
  assert.equal(e.status, 2)
  assert.match(e.stderr.toString(), /^harnie-exec: set-difficulty: sentinel 없음\(활성 run 아님\)/m)
  assert.doesNotMatch(e.stderr.toString(), /at readJSONStrict|ENOENT/)
})

test("taskWatchdogUsage: execution.json.difficulty 우선, 없으면 manifest.json.difficulty로 폴백", () => {
  const root = gitRepo()
  const manifestWithDifficulty = { ...M_MANIFEST, difficulty: "hard" }
  writePlan(root, "feat-x", manifestWithDifficulty)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  approveFlow(root, "feat-x")
  setTaskRunStatus(root, "feat-x", "t1", "building")
  registerBuilderThread(root, "feat-x", "t1", "builder-1")
  assert.equal(taskWatchdogUsage(root, "feat-x", { taskId: "t1" }).difficulty, "hard")
  run(["set-difficulty", "--root", root, "--slug", "feat-x", "--difficulty", "very-hard"])
  assert.equal(taskWatchdogUsage(root, "feat-x", { taskId: "t1" }).difficulty, "very-hard")
})

test("recordBuilderCall: 반환값에 difficulty 포함(execution.json 우선, manifest.json 폴백) — posttooluse의 decideWatchdog(recorded) 소비 경로용", () => {
  const root = gitRepo()
  const manifestWithDifficulty = { ...M_MANIFEST, difficulty: "hard" }
  writePlan(root, "feat-x", manifestWithDifficulty)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  approveFlow(root, "feat-x")
  setTaskRunStatus(root, "feat-x", "t1", "building")
  registerBuilderThread(root, "feat-x", "t1", "builder-1")
  assert.equal(recordBuilderCall(root, "feat-x", "builder-1").difficulty, "hard")
  run(["set-difficulty", "--root", root, "--slug", "feat-x", "--difficulty", "very-hard"])
  assert.equal(recordBuilderCall(root, "feat-x", "builder-1").difficulty, "very-hard")
  assert.equal(recordBuilderCall(root, "feat-x", "builder-1").codexCalls, 3)
})

test("computeCompletion(S): APPROVED + 현재 트리 바인딩만 complete, 트리 변경·미승인은 blocker", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "S")
  const c0 = computeCompletion(root, "plan", "feat-x")
  assert.equal(c0.complete, false)
  assert.ok(c0.blockers.some((b) => /미승인/.test(b)))
  const unitDir = join(root, ".harnie", "plan", "feat-x", "review", "code")
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(join(unitDir, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: captureTree(root) }))
  assert.equal(computeCompletion(root, "plan", "feat-x").complete, true)
  writeFileSync(join(root, "changed.txt"), "post-review change\n") // 리뷰 후 변경
  const c2 = computeCompletion(root, "plan", "feat-x")
  assert.equal(c2.complete, false)
  assert.ok(c2.blockers.some((b) => /리뷰 후 변경/.test(b)))
})

test("computeCompletion(S): state.json 없을 때 blocker가 리뷰 미실행과 유닛 이름 오기를 구분한다", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "S")
  const b0 = computeCompletion(root, "plan", "feat-x").blockers.join("\n")
  assert.match(b0, /review\/ 디렉터리 없음/) // 리뷰를 아예 안 돌림
  mkdirSync(join(root, ".harnie", "plan", "feat-x", "review", "cr"), { recursive: true })
  const b1 = computeCompletion(root, "plan", "feat-x").blockers.join("\n")
  assert.match(b1, /review\/ 하위: \[cr\]/) // 다른 유닛 이름에 기록됨
  assert.match(b1, /code여야 한다/)
})

test("registerBuilderAuto(S): run root cwd만 암묵 t1에 귀속, 타 cwd는 fail-closed", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "S")
  const elsewhere = gitRepo()
  assert.equal(registerBuilderAuto(root, "feat-x", "th-1", elsewhere).ok, false)
  assert.equal(registerBuilderAuto(root, "feat-x", "th-1", root).ok, true)
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.tasks.t1.builderThreadId, "th-1")
  assert.ok(ex.tasks.t1.builderBoundAt)
})

test("verify --integration: 유효 키(트리+planHash+계약 해시) receipt, 동일 키 pass는 skip", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  approveFlow(root, "feat-x")
  const r1 = run(["verify", "--root", root, "--slug", "feat-x", "--integration"])
  assert.equal(r1.ok, true)
  assert.ok(r1.receipt.artifact && r1.receipt.verificationHash)
  const r2 = run(["verify", "--root", root, "--slug", "feat-x", "--integration"])
  assert.equal(r2.skipped, "existing-receipt") // 무변화 중복 실행 금지
  writeFileSync(join(root, "new.txt"), "tree change\n")
  const r3 = run(["verify", "--root", root, "--slug", "feat-x", "--integration"])
  assert.equal(r3.skipped, undefined) // 트리 변경 → 재실행
  // completion: 통합 receipt가 현재 트리와 일치해야 함
  writeFileSync(join(root, "again.txt"), "another change\n")
  const c = computeCompletion(root, "plan", "feat-x")
  assert.ok(c.blockers.some((b) => /통합 검증 후 변경/.test(b)), c.blockers.join("; "))
})

test("completion: 통합 receipt의 planHash·verificationHash 위조/불일치는 blocker(유효 키 3요소)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  approveFlow(root, "feat-x")
  run(["verify", "--root", root, "--slug", "feat-x", "--integration"])
  const rPath = join(root, ".harnie", "plan", "feat-x", "review", "integration", "receipt.json")
  const good = JSON.parse(readFileSync(rPath, "utf8"))
  writeFileSync(rPath, JSON.stringify({ ...good, planHash: "forged" }))
  assert.ok(computeCompletion(root, "plan", "feat-x").blockers.some((b) => /통합 receipt planHash 불일치/.test(b)))
  writeFileSync(rPath, JSON.stringify({ ...good, verificationHash: "forged" }))
  assert.ok(computeCompletion(root, "plan", "feat-x").blockers.some((b) => /integrationVerification 계약과 불일치/.test(b)))
})

test("M e2e: 승인 → task receipt(verify) → 통합 receipt → completion complete(게이트 없음)", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.js"), "x\n")
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  approveFlow(root, "feat-x")
  const unitDir = join(root, ".harnie", "plan", "feat-x", "review", "code")
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(join(unitDir, "ledger.json"), "{}")
  writeFileSync(join(unitDir, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: captureTree(root) }))
  assert.equal(run(["verify", "--root", root, "--slug", "feat-x", "--task", "t1"]).ok, true)
  assert.equal(run(["verify", "--root", root, "--slug", "feat-x", "--integration"]).ok, true)
  // 설계 리뷰 유닛은 manifest에 등재되지 않는 예약 유닛이다(카드 5) — 없으면 M은 완료가 아니다.
  approveDesignUnit(root, "feat-x")
  const c = computeCompletion(root, "plan", "feat-x")
  assert.equal(c.complete, true, c.blockers.join("; "))
})

// DEC-3의 스키마 결함 ①: `design`은 manifest의 reviewUnit 어디에도 없어 완료 도출에 보이지 않았고, 설계
// 리뷰를 한 번도 안 돌린 M이 complete:true가 됐다.
test("completion(M): 설계 리뷰 유닛 없으면 complete:false — 승인 후 유닛을 채우면 complete:true", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.js"), "x\n")
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  approveFlow(root, "feat-x")
  const unitDir = join(root, ".harnie", "plan", "feat-x", "review", "code")
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(join(unitDir, "ledger.json"), "{}")
  writeFileSync(join(unitDir, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: captureTree(root) }))
  run(["verify", "--root", root, "--slug", "feat-x", "--task", "t1"])
  run(["verify", "--root", root, "--slug", "feat-x", "--integration"])
  const before = computeCompletion(root, "plan", "feat-x")
  assert.equal(before.complete, false)
  assert.ok(before.blockers.some((b) => /설계 리뷰\(design\)/.test(b)), before.blockers.join("; "))
  // REVISING 상태의 설계 유닛도 완료가 아니다 — 존재만으로는 통과하지 않는다.
  const dd = join(root, ".harnie", "plan", "feat-x", "review", "design")
  mkdirSync(dd, { recursive: true })
  writeFileSync(join(dd, "ledger.json"), "{}")
  writeFileSync(join(dd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "REVISING" }))
  assert.ok(computeCompletion(root, "plan", "feat-x").blockers.some((b) => /설계 리뷰\(design\): 미승인/.test(b)))
  approveDesignUnit(root, "feat-x")
  assert.equal(computeCompletion(root, "plan", "feat-x").complete, true)
})

// S에는 설계 리뷰 예약이 없다 — 승인 게이트도 manifest도 없는 모드에 M의 조건을 얹지 않는다.
test("completion(S): 설계 리뷰 유닛은 요구되지 않는다", () => {
  const root = gitRepo()
  writePlan(root, "feat-s")
  run(["init", "--root", root, "--slug", "feat-s"])
  setMode(root, "feat-s", "S")
  const cd = join(root, ".harnie", "plan", "feat-s", "review", "code")
  mkdirSync(cd, { recursive: true })
  writeFileSync(join(cd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: captureTree(root) }))
  const c = computeCompletion(root, "plan", "feat-s")
  assert.equal(c.complete, true, c.blockers.join("; "))
})

test("validateRepoBinding: integrationVerification[].repo 지정은 승인 거부(CR-005)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const block = { ...M_MANIFEST, integrationVerification: [{ ...IV[0], repo: "repoA" }] }
  assert.match(validateRepoBinding(root, block), /단일 repo 전용/)
  assert.equal(validateRepoBinding(root, M_MANIFEST), null)
})

test("CLI 공통 가드(CR-001): 변이 서브커맨드는 활성 run 불일치·mode mirror 손상에서 fail-closed", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  // 활성 run과 다른 slug — set-task/seal/watchdog-extend 모두 진입부에서 거부
  for (const args of [
    ["set-task", "--root", root, "--slug", "other", "--task", "T1", "--run-status", "building"],
    ["seal", "--root", root, "--slug", "other"],
    ["watchdog-extend", "--root", root, "--slug", "other", "--task", "T1", "--reason", "사용자 승인"],
  ]) {
    const e = runFail(args)
    assert.ok(e && /불일치/.test(String(e.stderr)), args[0])
  }
  // mode mirror 손상(sentinel만 변조) — 변이 서브커맨드 전부 fail-closed
  const sPath = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(sPath, "utf8")); s.mode = "M"; writeFileSync(sPath, JSON.stringify(s))
  const e2 = runFail(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  assert.ok(e2 && /mode 불일치/.test(String(e2.stderr)))
})

test("registerBuilderThread: 레거시(rebind 이력·builderBoundAt 부재) task는 startedAt을 anchor로 보존(CR-006)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  const execPath = join(root, ".harnie", "plan", "feat-x", "execution.json")
  const ex = JSON.parse(readFileSync(execPath, "utf8"))
  ex.tasks.T1.startedAt = "2000-01-01T00:00:00.000Z" // 레거시 anchor
  ex.threadRebindings = [{ action: "rebind", taskId: "T1", oldThreadId: "old", reason: "finding:final-review:CR-001", at: "t" }]
  writeFileSync(execPath, JSON.stringify(ex))
  registerBuilderThread(root, "feat-x", "T1", "new-th")
  const t = JSON.parse(readFileSync(execPath, "utf8")).tasks.T1
  assert.equal(t.builderBoundAt, "2000-01-01T00:00:00.000Z") // now로 리셋되지 않음(예산 우회 차단)
  // 신규 task(rebind 이력 없음)의 첫 바인딩은 현재 시각
  setTaskRunStatus(root, "feat-x", "T2", "building")
  registerBuilderThread(root, "feat-x", "T2", "th-2")
  const t2 = JSON.parse(readFileSync(execPath, "utf8")).tasks.T2
  assert.notEqual(t2.builderBoundAt, "2000-01-01T00:00:00.000Z")
})

test("rebind-arm: terminal 증거·old-thread 대조·질문 본문 대조·승인 바인딩·원샷 상호배제", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  setTaskRunStatus(root, "feat-x", "T1", "building")
  registerBuilderThread(root, "feat-x", "T1", "dead-th")
  const EV = "MCP error: Session not found for thread_id dead-th"
  assert.throws(() => rebindArm(root, "feat-x", { taskId: "T1", oldThread: "dead-th", evidence: "idle timeout 1800s" }), /terminal 마커/)
  assert.throws(() => rebindArm(root, "feat-x", { taskId: "T1", oldThread: "wrong-th", evidence: EV }), /old-thread 불일치/)
  assert.equal(rebindArm(root, "feat-x", { taskId: "T1", oldThread: "dead-th", evidence: EV }).ok, true)
  // 원샷 상호배제: rebind arm pending 중 계획 승인 arm 불가
  assert.equal(armApproval(root, "feat-x").ok, false)
  recordPendingRebind(root, "feat-x", "tu-r1")
  // 질문 본문에 증거 원문·task·old thread가 없으면 비바인딩
  const bad = bindRebind(root, "feat-x", "tu-r1", { questions: [{ question: "재바인딩할까요?" }] }, { answers: { q: "승인" } })
  assert.equal(bad.ok, false)
  // 다시 arm → 본문 제시 + 정확 승인 → 원자 전이(threadId 해제 + 마커, 카운터 불리셋)
  rebindArm(root, "feat-x", { taskId: "T1", oldThread: "dead-th", evidence: EV })
  recordPendingRebind(root, "feat-x", "tu-r2")
  const q = { questions: [{ question: `task T1의 빌더 스레드 dead-th를 해제할까요? 증거: ${EV}` }] }
  const ok = bindRebind(root, "feat-x", "tu-r2", q, { answers: { q: "승인" } })
  assert.equal(ok.ok, true)
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.tasks.T1.builderThreadId, null)
  assert.equal(ex.pendingRunRootBootstrap, "T1")
  assert.ok(ex.tasks.T1.builderBoundAt) // 기산점 불리셋(DR-107)
})

test("approve(CLI): 훅 부트스트랩 run도 그대로 승인한다(authority 라벨 폐기 — DEC-2)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"]) // 훅 부트스트랩과 같은 run(라벨 없음)
  setMode(root, "feat-x", "M")
  assert.throws(() => approveCli(root, "feat-x", "wrong-hash"), /plan-hash가 현재 plan.md와 불일치/)
  const planMd = readFileSync(join(root, ".harnie", "plan", "feat-x", "plan.md"), "utf8")
  const ph = computePlanHash(planMd, canonicalManifest(extractManifestBlock(planMd)))
  const r = approveCli(root, "feat-x", ph)
  assert.equal(r.ok, true)
  assert.equal(r.phase, "executing")
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.cliApprovals.length, 1) // 감사 기록
  // 승인 권위가 CLI 안에 없다는 것이 DEC-2의 핵심이다 — 이 CLI가 막지 않는 대신 guards.decideBash가
  // 훅 있는 세션의 Bash 호출을 먼저 deny한다(guards.test.mjs).
  assert.equal(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).authority, undefined)
})

// §7.4의 데드엔드: 승인 질문 앞에서 세션이 죽으면 원샷 arm/pending이 디스크에 남고, `otherArmPending`이
// 다음 arm을 거부해 run이 굳는다. 카드 3이 approve 성공 시 그것을 소비해 닫는다.
test("approve(CLI): 성공 시 남은 원샷 arm/pending 파일을 정리한다(§7.4)", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "M")
  assert.equal(armApproval(root, "feat-x", { approveOption: "승인" }).ok, true) // 중단된 Claude 세션의 잔재
  assert.ok(existsSync(join(dir, ".arm-approval.json")))
  const planMd = readFileSync(join(dir, "plan.md"), "utf8")
  approveCli(root, "feat-x", computePlanHash(planMd, canonicalManifest(extractManifestBlock(planMd))))
  for (const f of [".arm-approval.json", ".pending-approval.json", ".arm-rebind.json", ".pending-rebind.json"])
    assert.equal(existsSync(join(dir, f)), false, f)
  // 정리됐으므로 후속 arm이 다시 열린다(데드엔드 해소).
  assert.equal(armApproval(root, "feat-x", { approveOption: "승인" }).ok, true)
})

// ── 재개·인계 진입점(0.14 DEC-3) ─────────────────────────────────────────────
// S run 하나를 리뷰 승인까지 채우고 현재 트리에 바인딩한다(완료 상태).
function makeInactiveRun(root, slug, mode = "S") {
  const dir = writePlan(root, slug)
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ track: "plan", slug, planHash: null, phase: "planning", mode, tasks: {} }))
  return dir
}

function makeCompleteSRun(root, slug) {
  writePlan(root, slug)
  run(["init", "--root", root, "--slug", slug])
  setMode(root, slug, "S")
  const cd = join(root, ".harnie", "plan", slug, "review", "code")
  mkdirSync(cd, { recursive: true })
  writeFileSync(join(cd, "ledger.json"), "{}")
  writeFileSync(join(cd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: captureTree(root) }))
  return cd
}

test("runs: closedAt이 찍힌 run은 목록에 없고, 활성 run과 blockers를 그대로 낸다", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  makeCompleteSRun(root, "done-run")
  bootstrapRun(root, { base: "next-run" }) // rollover → done-run에 closedAt
  writePlan(root, "next-run")
  setMode(root, "next-run", "S")
  const { runs } = run(["runs", "--root", root]) // CLI 배선까지 함께 확인
  assert.deepEqual(runs, listRuns(root).runs)
  assert.deepEqual(runs.map((r) => r.slug), ["next-run"])
  assert.equal(runs[0].active, true)
  assert.equal(runs[0].mode, "S")
  assert.ok(runs[0].blockers.length > 0) // 리뷰 미승인
  // 폐기된 run은 `.harnie/abandoned/` 아래로 옮겨져 plan 스캔 대상이 아니다.
  makeInactiveRun(root, "junk")
  assert.ok(listRuns(root).runs.some((r) => r.slug === "junk"))
  run(["abandon", "--root", root, "--slug", "junk", "--confirm", "junk"])
  assert.equal(listRuns(root).runs.some((r) => r.slug === "junk"), false)
})

test("runs: 비활성 미완료 run도 열거된다 — 소급 미완료된 과거 run을 되살릴 유일한 입력", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  makeCompleteSRun(root, "old-run")
  bootstrapRun(root, { base: "cur-run" })
  writePlan(root, "cur-run")
  // old-run은 closedAt이 찍혔지만, closedAt 없는 다른 비활성 run은 남아야 한다.
  makeInactiveRun(root, "stalled-run")
  const slugs = listRuns(root).runs.map((r) => r.slug)
  assert.ok(slugs.includes("stalled-run"))
  assert.ok(slugs.includes("cur-run"))
  assert.equal(slugs.includes("old-run"), false)
  assert.equal(listRuns(root).runs.find((r) => r.slug === "stalled-run").active, false)
})

test("handoff: 비활성 run을 활성으로 되돌리고 런타임 종속 상태만 정리한다(누적 카운터 불변)", () => {
  const root = gitRepo()
  bootstrapRun(root, { base: "other" }) // 다른 run이 활성 포인터를 잡고 있다
  const dir = makeInactiveRun(root, "hand-off", "M")
  // 인계 전: 빌더 스레드 바인딩·누적 카운터·오래된 워치독 기산점·중단된 승인 arm
  const execPath = join(dir, "execution.json")
  const ex = JSON.parse(readFileSync(execPath, "utf8"))
  ex.tasks = { t1: { runStatus: "building", builderThreadId: "th-dead", codexCalls: 7, startedAt: "2020-01-01T00:00:00.000Z", builderBoundAt: "2020-01-01T00:00:00.000Z", watchdogExtensions: [{ at: "2020-01-01T00:00:00.000Z", reason: "user" }] } }
  writeFileSync(execPath, JSON.stringify(ex))
  writeFileSync(join(dir, ".arm-approval.json"), "{}")
  writeFileSync(join(dir, ".pending-rebind.json"), "{}")
  assert.equal(readSentinel(root).slug, "other")

  const r = run(["handoff", "--root", root, "--slug", "hand-off"]) // CLI 배선까지 함께 확인
  assert.equal(r.ok, true)
  assert.equal(r.previousActive, "other")
  assert.deepEqual(r.clearedArmFiles.sort(), [".arm-approval.json", ".pending-rebind.json"])
  const s = readSentinel(root)
  assert.equal(s.slug, "hand-off")
  assert.equal(s.base, "hand-off")
  assert.equal(s.mode, "M") // sentinel↔execution mode mirror 유지
  assert.deepEqual(s.readOnlyThreads, [])
  const after = JSON.parse(readFileSync(execPath, "utf8"))
  assert.equal(after.tasks.t1.builderThreadId, null)
  assert.equal(after.tasks.t1.codexCalls, 7)                       // 누적 — 인계로 리셋되면 상한 우회다
  assert.equal(after.tasks.t1.watchdogExtensions.length, 1)        // 누적
  assert.notEqual(after.tasks.t1.builderBoundAt, "2020-01-01T00:00:00.000Z") // 기산점만 재기산
  assert.equal(after.tasks.t1.builderBoundAt, r.watchdogRebasedAt)
  assert.equal(after.tasks.t1.startedAt, r.watchdogRebasedAt)
  for (const f of [".arm-approval.json", ".pending-rebind.json"]) assert.equal(existsSync(join(dir, f)), false)
  assert.doesNotThrow(() => loadContext(root)) // mode mirror 정합
})

test("handoff: 드리프트가 있으면 유닛별 변경 파일 목록을 보고한다", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  makeCompleteSRun(root, "drifted")
  assert.deepEqual(handoffRun(root, "drifted").drift, [])
  writeFileSync(join(root, "unrelated.md"), "run과 무관한 편집\n")
  const d = handoffRun(root, "drifted").drift
  assert.equal(d.length, 1)
  assert.equal(d[0].unit, "code")
  assert.deepEqual(d[0].files, ["unrelated.md"])
  assert.notEqual(d[0].reviewedPostSHA, d[0].currentTree)
})

test("handoff: 없는 run은 fail-closed", () => {
  const root = gitRepo()
  assert.throws(() => handoffRun(root, "nope"), (e) => e instanceof FailClosed && /대상 run 없음/.test(e.message))
})

// ── rebind-tree: 리뷰 범위 밖 드리프트만 수용(0.14 DEC-4) ─────────────────────
// 3번 규칙(범위 겹침 거부)이 이 장치를 `--accept-drift` 류의 권위 구멍과 가르는 지점이다.
test("rebind-tree(S): 범위 밖 편집을 수용하고 treeRebinds에 이력을 남긴다", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.js"), "v1\n")
  const cd = makeCompleteSRun(root, "s-run")
  // S의 리뷰 범위 = 리뷰가 승인한 delta의 파일 집합(loop.mjs delta의 사이드카)
  writeFileSync(join(cd, "delta.patch.json"), JSON.stringify({ changedPaths: ["src/a.js"] }))
  assert.equal(computeCompletion(root, "plan", "s-run").complete, true)
  writeFileSync(join(root, "NOTES.md"), "무관한 편집\n")
  const c1 = computeCompletion(root, "plan", "s-run")
  assert.equal(c1.complete, false)
  assert.ok(c1.blockers.some((b) => /리뷰 후 변경됨/.test(b)))

  const r = rebindTree(root, "s-run", "code", ["NOTES.md"])
  assert.equal(r.ok, true)
  assert.deepEqual(r.files, ["NOTES.md"])
  assert.notEqual(r.from, r.to)
  const c2 = computeCompletion(root, "plan", "s-run")
  assert.equal(c2.complete, true, c2.blockers.join("; "))
  assert.equal(c2.review.treeRebinds.length, 1)
  assert.equal(c2.review.treeRebinds[0].unit, "code")
  assert.deepEqual(c2.review.treeRebinds[0].files, ["NOTES.md"])
})

test("rebind-tree: 리뷰 범위와 겹치면 거부 — 출구는 재리뷰뿐", () => {
  const root = gitRepo()
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.js"), "v1\n")
  const cd = makeCompleteSRun(root, "s-run")
  writeFileSync(join(cd, "delta.patch.json"), JSON.stringify({ changedPaths: ["src/a.js"] }))
  writeFileSync(join(root, "src", "a.js"), "리뷰된 코드를 고침\n")
  assert.throws(() => rebindTree(root, "s-run", "code", ["src/a.js"]),
    (e) => e instanceof FailClosed && /리뷰 범위와 겹침/.test(e.message))
  assert.equal(computeCompletion(root, "plan", "s-run").complete, false) // 상태 불변
})

test("rebind-tree: --files가 실제 delta와 다르면 거부(판단 시점과 재바인딩 시점 사이의 변경 차단)", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  const cd = makeCompleteSRun(root, "s-run")
  writeFileSync(join(cd, "delta.patch.json"), JSON.stringify({ changedPaths: ["src.txt"] }))
  writeFileSync(join(root, "a.md"), "1\n")
  writeFileSync(join(root, "b.md"), "2\n") // 사용자가 a.md만 보고 판단한 뒤 b.md가 더 생겼다
  assert.throws(() => rebindTree(root, "s-run", "code", ["a.md"]),
    (e) => e instanceof FailClosed && /--files가 실제 delta와 불일치/.test(e.message))
  assert.deepEqual(rebindTree(root, "s-run", "code", ["b.md", "a.md"]).files, ["a.md", "b.md"]) // 순서 무관
})

test("rebind-tree: 드리프트 없음·DR 아티팩트·미상 범위는 모두 거부", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  const cd = makeCompleteSRun(root, "s-run")
  assert.throws(() => rebindTree(root, "s-run", "code", []), (e) => e instanceof FailClosed && /드리프트 없음/.test(e.message))
  writeFileSync(join(root, "x.md"), "1\n")
  // 범위를 알 수 없으면(사이드카 부재) 수용하지 않는다 — fail-closed
  assert.throws(() => rebindTree(root, "s-run", "code", ["x.md"]), (e) => e instanceof FailClosed && /리뷰 범위를 알 수 없음/.test(e.message))
  writeFileSync(join(cd, "delta.patch.json"), JSON.stringify({ changedPaths: ["src.txt"] }))
  // DR 유닛(dr: 아티팩트)은 전체 tree에 바인딩되지 않으므로 대상이 아니다
  const dd = join(root, ".harnie", "plan", "s-run", "review", "design")
  mkdirSync(dd, { recursive: true })
  writeFileSync(join(dd, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: "dr:" + "a".repeat(64) }))
  assert.throws(() => rebindTree(root, "s-run", "design", ["x.md"]), (e) => e instanceof FailClosed && /tree SHA가 아님/.test(e.message))
  assert.deepEqual(treeDrift(root, "plan", "s-run").map((d) => d.unit), ["code"]) // design은 드리프트 대상 아님
})

test("rebind-tree(CLI): guardActive를 부른다 — 활성 run이 아니면 거부", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  const cd = makeCompleteSRun(root, "s-run")
  writeFileSync(join(cd, "delta.patch.json"), JSON.stringify({ changedPaths: ["src.txt"] }))
  bootstrapRun(root, { base: "other" }) // 완료 run → rollover로 활성 포인터가 다른 run으로
  writeFileSync(join(root, "x.md"), "1\n")
  assert.ok(runFail(["rebind-tree", "--root", root, "--slug", "s-run", "--unit", "code", "--files", "x.md"]))
  handoffRun(root, "s-run")
  assert.equal(run(["rebind-tree", "--root", root, "--slug", "s-run", "--unit", "code", "--files", "x.md"]).ok, true)
})

// ── 완료 리포트의 리뷰 구성(0.14 D6) ─────────────────────────────────────────
test("completion: 라운드별 리뷰 구성과 재바인딩 이력을 신고 값임을 밝혀 함께 낸다", () => {
  const root = gitRepo()
  writeFileSync(join(root, "src.txt"), "v1\n")
  const cd = makeCompleteSRun(root, "s-run")
  const st = JSON.parse(readFileSync(join(cd, "state.json"), "utf8"))
  st.reviewers = [{ round: 1, runtime: "claude", model: "opus" }]
  writeFileSync(join(cd, "state.json"), JSON.stringify(st))
  const c = computeCompletion(root, "plan", "s-run")
  assert.deepEqual(c.review.reviewers.code, [{ round: 1, runtime: "claude", model: "opus" }])
  assert.deepEqual(c.review.treeRebinds, [])
  assert.match(c.review.note, /신고 값/)
})

// ── abandon: 잠긴 트리의 출구(0.14 DEC-1) ─────────────────────────────────
// 방어는 `--confirm` 하나뿐이고 그것이 막는 것은 오타다. 그 대신 결과를 되돌릴 수 있어야 한다 —
// plan 디렉터리는 지워지지 않고 `.harnie/abandoned/` 아래로 이동한다.
test("abandon: 활성 run을 폐기하면 active.json이 사라지고 plan 디렉터리는 abandoned/ 아래에 그대로 남는다", () => {
  const root = gitRepo()
  const dir = writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  writeFileSync(join(dir, "note.txt"), "리뷰 원장 대용")
  const r = run(["abandon", "--root", root, "--slug", "feat-x", "--confirm", "feat-x"])
  assert.equal(r.wasActive, true)
  assert.equal(existsSync(join(root, ".harnie", "active.json")), false)
  assert.equal(existsSync(dir), false)
  assert.match(r.movedTo, /\.harnie\/abandoned\/feat-x-/)
  assert.equal(readFileSync(join(r.movedTo, "note.txt"), "utf8"), "리뷰 원장 대용")
  assert.ok(existsSync(join(r.movedTo, "plan.md")))
})

test("abandon: --confirm이 slug와 다르면 거부(상태 불변)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  assert.throws(() => abandonRun(root, "feat-x", "feat-y"), (e) => e instanceof FailClosed && /--confirm/.test(e.message))
  assert.throws(() => abandonRun(root, "feat-x", undefined), FailClosed)
  assert.ok(existsSync(join(root, ".harnie", "active.json")))
  assert.ok(existsSync(join(root, ".harnie", "plan", "feat-x")))
  assert.ok(runFail(["abandon", "--root", root, "--slug", "feat-x"])) // --confirm 누락도 실패
})

// 소급 미완료된 과거 run(활성 아님)도 폐기 대상이다 — 그렇지 않으면 `runs`에 영원히 남는다(DEC-3).
test("abandon: 비활성 slug도 폐기되고 활성 run은 건드리지 않는다", () => {
  const root = gitRepo()
  writePlan(root, "old-run")
  run(["init", "--root", root, "--slug", "old-run"])
  run(["abandon", "--root", root, "--slug", "old-run", "--confirm", "old-run"])
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const dir = writePlan(root, "stale")
  const r = run(["abandon", "--root", root, "--slug", "stale", "--confirm", "stale"])
  assert.equal(r.wasActive, false)
  assert.equal(existsSync(dir), false)
  assert.equal(readSentinel(root).slug, "feat-x") // 활성 run 불변
})

test("abandon: 폐기할 것이 없으면 실패", () => {
  const root = gitRepo()
  assert.throws(() => abandonRun(root, "nothing", "nothing"), (e) => e instanceof FailClosed && /폐기할 run 없음/.test(e.message))
})
