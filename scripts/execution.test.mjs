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
  detectVacuous, loadContext, repoAdd, validateRepoBinding, workspaceInfo,
  rebindTask,
  setMode, setDifficulty, readMode, computeCompletion, rebindArm, recordPendingRebind, bindRebind, approveCli,
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

test("registerBuilderAuto: workspace member task cwd 매핑·run-root repo 정합 검증", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "harnie-register-ws-"))
  const memberA = gitRepo(), memberB = gitRepo(), slug = "ws"
  const dir = join(runRoot, ".harnie", "plan", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(runRoot, ".harnie", "active.json"), JSON.stringify({ track: "plan", slug, workspaceRoot: dirname(runRoot), repos: { a: { workroot: memberA }, b: { workroot: memberB } } }))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tasks: [{ id: "1", repo: "a" }, { id: "2", repo: "b" }] }))
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ track: "plan", slug, tasks: { "1": { runStatus: "building", builderThreadId: null }, "2": { runStatus: "building", builderThreadId: null } } }))
  const wt2 = join(memberB, ".harnie-wt", "harnie-ws-t2"); mkdirSync(wt2, { recursive: true })
  assert.equal(registerBuilderAuto(runRoot, slug, "thread-2", wt2).taskId, "2")
  const exPath = join(dir, "execution.json")
  const ex = JSON.parse(readFileSync(exPath, "utf8")); ex.pendingRunRootBootstrap = "1"; writeFileSync(exPath, JSON.stringify(ex))
  assert.equal(registerBuilderAuto(runRoot, slug, "wrong-root", memberB).ok, false)
  assert.equal(JSON.parse(readFileSync(exPath, "utf8")).tasks["1"].builderThreadId, null)
})

test("registerBuilderAuto: plan execution 상태가 없으면 quick-track 호출을 no-op", () => {
  const root = gitRepo()
  assert.deepEqual(registerBuilderAuto(root, "quick-fix", "thread-1", root), {
    ok: false,
    reason: "plan 실행 상태 없음 — 자동 귀속 대상 아님",
  })
})

test("registerBuilderAuto: marker 없는 root cwd는 단일 serial·task worktree 부재일 때만 귀속", () => {
  const serial = gitRepo()
  writePlan(serial, "feat-x"); run(["init", "--root", serial, "--slug", "feat-x"]); approveFlow(serial)
  setTaskRunStatus(serial, "feat-x", "T1", "building")
  assert.equal(registerBuilderAuto(serial, "feat-x", "serial-thread", serial).taskId, "T1")

  const runner = gitRepo()
  writePlan(runner, "feat-x"); run(["init", "--root", runner, "--slug", "feat-x"]); approveFlow(runner)
  setTaskRunStatus(runner, "feat-x", "T1", "building")
  mkdirSync(join(runner, ".harnie-wt", "harnie-feat-x-tT1"), { recursive: true })
  assert.equal(registerBuilderAuto(runner, "feat-x", "root-thread", runner).ok, false)

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

// ── 0.11: mode(S/M/L)·통합 검증·rebind-arm·CLI 권위 ──────────────────────
const IV = [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }]
const L_MANIFEST = { ...GOOD_MANIFEST, gates: [{ name: "final-review", reviewUnit: "final-review" }], integrationVerification: IV }
const M_MANIFEST = { tasks: [{ id: "t1", deps: [], reviewUnit: "code", scope: ["src/"], verification: VER() }], gates: [], integrationVerification: IV }

test("validateManifest(mode): L=final-review 1개·M=게이트 없음, integrationVerification 필수, integration 유닛 예약", () => {
  assert.deepEqual(validateManifest(L_MANIFEST, { mode: "L" }), [])
  assert.deepEqual(validateManifest(M_MANIFEST, { mode: "M" }), [])
  assert.ok(validateManifest({ ...L_MANIFEST, gates: GATES }, { mode: "L" }).some((e) => /final-review/.test(e)))
  assert.ok(validateManifest({ ...M_MANIFEST, gates: [{ name: "final-review", reviewUnit: "final-review" }] }, { mode: "M" }).some((e) => /게이트 없음/.test(e)))
  const noIv = { ...L_MANIFEST }; delete noIv.integrationVerification
  assert.ok(validateManifest(noIv, { mode: "L" }).some((e) => /integrationVerification 필수/.test(e)))
  assert.ok(validateManifest(noIv, { mode: "M" }).some((e) => /integrationVerification 필수/.test(e)))
  const reserved = { ...L_MANIFEST, tasks: [{ id: "T1", deps: [], reviewUnit: "integration", scope: ["s/"], verification: VER() }] }
  assert.ok(validateManifest(reserved, { mode: "L" }).some((e) => /예약어/.test(e)))
  // mode 미지정 = 레거시 4게이트 규칙 그대로
  assert.deepEqual(validateManifest(GOOD_MANIFEST), [])
  // canonicalManifest는 integrationVerification 포함(있을 때만 — 레거시 planHash 불변)
  assert.equal(canonicalManifest(L_MANIFEST).integrationVerification, IV)
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
  assert.equal(setMode(root, "feat-x", "L").mode, "L")
  assert.throws(() => setMode(root, "feat-x", "M"), /상향 전이만/) // 하향 금지
  const sPath = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(sPath, "utf8")); s.mode = "S"; writeFileSync(sPath, JSON.stringify(s))
  assert.throws(() => setMode(root, "feat-x", "L"), /불일치/)
  assert.equal(loadContext(root).failClosed, true) // 훅 문맥도 fail-closed
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
  const c = computeCompletion(root, "plan", "feat-x")
  assert.equal(c.complete, true, c.blockers.join("; "))
})

test("validateRepoBinding: 비-workspace run에서 integrationVerification[].repo 지정은 승인 거부(CR-005)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x")
  run(["init", "--root", root, "--slug", "feat-x"])
  const block = { ...M_MANIFEST, integrationVerification: [{ ...IV[0], repo: "repoA" }] }
  assert.match(validateRepoBinding(root, block), /workspace run에서만 유효/)
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
  const s = JSON.parse(readFileSync(sPath, "utf8")); s.mode = "L"; writeFileSync(sPath, JSON.stringify(s))
  const e2 = runFail(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  assert.ok(e2 && /mode 불일치/.test(String(e2.stderr)))
})

test("L arm 거부: mode L에서 레거시 4게이트·integrationVerification 부재 manifest는 승인 arm 불가(CR-009)", () => {
  const root = gitRepo()
  writePlan(root, "feat-x") // GOOD_MANIFEST: 4게이트, iv 없음 — mode 미지정(레거시)에선 유효
  run(["init", "--root", root, "--slug", "feat-x"])
  setMode(root, "feat-x", "L")
  const r = armApproval(root, "feat-x")
  assert.equal(r.ok, false)
  assert.match(r.reason, /final-review/)
  assert.match(r.reason, /integrationVerification 필수/)
  const cli = runFail(["arm-approval", "--root", root, "--slug", "feat-x", "--approve-option", "승인"])
  assert.ok(cli) // 공개 CLI 진입점에서도 거부
})

test("workspace L e2e: iv repo 누락은 arm 거부, 등록 repo로 승인 → verify --integration이 member workroot에서 실행·ws: receipt(CR-009)", () => {
  const { repo, runRoot, slug } = workspaceRun("ws-int")
  const { key } = repoAdd(runRoot, repo)
  // 통합 명령은 member workroot에만 존재하는 파일(src/a.txt)을 상대경로로 확인 — run root(비-git 상태 디렉터리)에서
  // 실행되면 반드시 실패하므로, exec root 해석이 실제로 member workroot임을 검증한다(false-positive 방지).
  const IV_WS = { executable: "node", args: ["-e", "require('fs').accessSync('src/a.txt');console.log('member-workroot-ok')"], cwd: ".", timeout: 30000 }
  const L_WS = {
    tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a.txt"], verification: VER(), repo: key }],
    gates: [{ name: "final-review", reviewUnit: "final-review" }],
    integrationVerification: [IV_WS], // repo 누락
  }
  const dir = join(runRoot, ".harnie", "plan", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "plan.md"), "# Plan\n\n```harnie-manifest\n" + JSON.stringify(L_WS, null, 2) + "\n```\n")
  setMode(runRoot, slug, "L")
  const rejected = armApproval(runRoot, slug)
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason, /integrationVerification\[0\]: workspace run은 repo 키 필수/)
  // repo 키를 채워 승인 → 통합 검증이 member workroot에서 돌고 ws: 합성 아티팩트에 바인딩된다
  const fixed = { ...L_WS, integrationVerification: [{ ...IV_WS, repo: key }] }
  writeFileSync(join(dir, "plan.md"), "# Plan\n\n```harnie-manifest\n" + JSON.stringify(fixed, null, 2) + "\n```\n")
  armApproval(runRoot, slug, { approveOption: "승인" })
  recordPendingApproval(runRoot, slug, "tu-ws")
  assert.equal(bindApproval(runRoot, slug, "tu-ws", { answers: { q: "승인" } }).ok, true)
  const r = run(["verify", "--root", runRoot, "--slug", slug, "--integration"])
  assert.equal(r.ok, true)
  assert.match(r.receipt.artifact, /^ws:[0-9a-f]{64}$/)
  assert.equal(r.receipt.results[0].exitCode, 0)
  assert.equal(run(["verify", "--root", runRoot, "--slug", slug, "--integration"]).skipped, "existing-receipt")
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

test("approve(CLI): authority=cli run 전용 — hook run에서는 fail-closed", () => {
  const root = gitRepo()
  writePlan(root, "feat-x", M_MANIFEST)
  run(["init", "--root", root, "--slug", "feat-x"]) // hook-authority run(기본)
  setMode(root, "feat-x", "M")
  assert.throws(() => approveCli(root, "feat-x", "whatever"), /authority=cli run 전용/)
  // cli-authority run: sentinel에 authority 기록 후 planHash 일치 시 승인 — manifest·phase·sentinel 갱신
  const sPath = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(sPath, "utf8")); s.authority = "cli"; writeFileSync(sPath, JSON.stringify(s))
  assert.throws(() => approveCli(root, "feat-x", "wrong-hash"), /plan-hash가 현재 plan.md와 불일치/)
  const planMd = readFileSync(join(root, ".harnie", "plan", "feat-x", "plan.md"), "utf8")
  const ph = computePlanHash(planMd, canonicalManifest(extractManifestBlock(planMd)))
  const r = approveCli(root, "feat-x", ph)
  assert.equal(r.ok, true)
  assert.equal(r.phase, "executing")
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.cliApprovals.length, 1) // 감사 기록
})
