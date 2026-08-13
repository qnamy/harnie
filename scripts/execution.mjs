#!/usr/bin/env node
// harnie execution 상태 엔진 — plan 트랙의 durable 실행 상태 + 권위 재도출 + 강제 훅의 결정적 코어.
// 설계: docs/EXECUTION-STATE-DESIGN.md (rev.10). 위협모델 §0.1 — fallible·over-eager 오케스트레이터/빌더의
// **실수**를 막는다(적대적 완전봉쇄는 비목표). 권위 = planHash 고정 immutable manifest + review-state ledger
// + verification receipt. execution.json은 advisory navigation cache(신뢰하지 않음 — Stop 가드는 재도출).
//
// 순수 함수(IO 없음)는 export해 단위 테스트하고, IO는 CLI 핸들러에 둔다. loop.mjs와 동일한 얇은-래퍼 스타일.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, readdirSync, rmSync, openSync, closeSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, isAbsolute, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { captureTree } from "./delta.mjs"
import { validateLedger, openBlockingCount } from "./ledger.mjs"

// ── 오류 ──────────────────────────────────────────────────────────────
export class FailClosed extends Error {}
function die(msg) {
  process.stderr.write(`harnie-exec: ${msg}\n`)
  process.exit(2)
}

// ── 순수: 해시·canonical ────────────────────────────────────────────────
export function sha256(str) {
  return createHash("sha256").update(str).digest("hex")
}

// 결정적 JSON 직렬화(키 정렬). planHash·seal 입력의 안정성 근거.
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]"
  const keys = Object.keys(v).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}"
}

// planHash = sha256(plan.md ∥ canonical(manifest without planHash)). manifest가 plan.md에서 파생되므로
// plan.md를 포함해 **prose+블록 전체**를 고정하고, canonical manifest로 파싱 결과까지 바인딩한다.
export function computePlanHash(planMd, manifestNoHash) {
  return sha256(planMd + "\u0000" + stableStringify(manifestNoHash))
}

// ── 순수: slug·경로 무결성 (§9) ─────────────────────────────────────────
const NAME_RE = /^[A-Za-z0-9._-]+$/
export function validateSlug(slug) {
  if (typeof slug !== "string" || !NAME_RE.test(slug) || slug === "." || slug === "..")
    throw new FailClosed(`slug 형식 오류(^[A-Za-z0-9._-]+$, . 및 .. 금지): ${JSON.stringify(slug)}`)
  return slug
}
// 작업 인자 → 결정적 base slug = `읽기용-prefix-<hash8>`. hash는 **전체 작업 문자열**(공백 정규화)의 sha256 앞 8자.
// 이유: ASCII prefix만으론 (a) 한국어 등 비-ASCII 작업이 ""가 되어 거부되고, (b) 앞 6토큰이 같은 서로 다른 작업이 같은 slug로 충돌해
// 미완료 run을 오인 resume한다. hash가 두 문제를 모두 해소(한국어 → prefix 없이 hash만; 동일 prefix → hash로 구분).
// 빈 작업(정규화 후 "")은 ""를 반환해 호출자(bootstrap)가 exit 2.
export function slugify(args) {
  const norm = String(args == null ? "" : args).trim().replace(/\s+/g, " ")
  if (norm === "") return ""
  const prefix = norm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 6).join("-")
  const hash = sha256(norm).slice(0, 8)
  return prefix ? `${prefix}-${hash}` : hash
}
// 상대 경로가 부모 밖으로 나가지 않는지(traversal 차단). scope·cwd 검증용.
export function assertContainedRel(rel, what) {
  if (typeof rel !== "string" || rel === "") throw new FailClosed(`${what}: 경로 문자열 필요`)
  if (isAbsolute(rel)) throw new FailClosed(`${what}: 절대경로 금지(${rel})`)
  const norm = normalize(rel)
  if (norm === ".." || norm.startsWith(".." + sep) || norm.split(sep).includes(".."))
    throw new FailClosed(`${what}: 상위 traversal 금지(${rel})`)
  return rel
}

// ── 순수: manifest 파싱·검증 (§4) ───────────────────────────────────────
// plan.md의 기계-파싱 블록: ```harnie-manifest\n<JSON>\n``` — A5에서 승인된 plan.md가 이를 포함한다.
export function extractManifestBlock(planMd) {
  const m = planMd.match(/```harnie-manifest[ \t]*\r?\n([\s\S]*?)\r?\n```/)
  if (!m) throw new FailClosed("plan.md에 ```harnie-manifest``` 블록 없음")
  let obj
  try {
    obj = JSON.parse(m[1])
  } catch (e) {
    throw new FailClosed(`harnie-manifest 블록 JSON 파싱 실패: ${e.message}`)
  }
  return obj
}

// manifest 스키마 엄격 검증 → errors[]. 기계 검사 가능(§4 DR-011).
export function validateManifest(obj) {
  const errors = []
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return ["manifest 최상위가 plain object 아님"]
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) errors.push("tasks는 비어있지 않은 배열")
  if (!Array.isArray(obj.gates)) errors.push("gates는 배열")
  const taskIds = new Set()
  const reviewUnits = new Set()
  const claimUnit = (u, where) => {
    if (typeof u !== "string" || !NAME_RE.test(u)) { errors.push(`${where}: reviewUnit 형식 오류(${JSON.stringify(u)})`); return }
    if (reviewUnits.has(u)) errors.push(`${where}: reviewUnit 중복(${u}) — 리뷰 디렉터리 충돌`)
    reviewUnits.add(u)
  }
  for (const [i, t] of (Array.isArray(obj.tasks) ? obj.tasks : []).entries()) {
    if (!t || typeof t !== "object") { errors.push(`tasks[${i}]: 객체 아님`); continue }
    if (typeof t.id !== "string" || !NAME_RE.test(t.id)) errors.push(`tasks[${i}].id 형식 오류(${JSON.stringify(t.id)})`)
    else if (taskIds.has(t.id)) errors.push(`tasks[${i}].id 중복(${t.id})`)
    else taskIds.add(t.id)
    if (!Array.isArray(t.deps)) errors.push(`tasks[${i}].deps 배열 아님`)
    claimUnit(t.reviewUnit, `tasks[${i}]`)
    if (!Array.isArray(t.scope) || t.scope.length === 0) errors.push(`tasks[${i}].scope 비어있지 않은 배열 필요`)
    else for (const s of t.scope) { try { assertContainedRel(s, `tasks[${i}].scope`) } catch (e) { errors.push(e.message) } }
    if (!Array.isArray(t.verification) || t.verification.length === 0) errors.push(`tasks[${i}].verification 비어있지 않은 배열 필요(런타임 증거 강제)`)
    else for (const [j, v] of t.verification.entries()) {
      if (!v || typeof v !== "object") { errors.push(`tasks[${i}].verification[${j}] 객체 아님`); continue }
      if (typeof v.executable !== "string" || !v.executable) errors.push(`tasks[${i}].verification[${j}].executable 필요`)
      if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === "string")) errors.push(`tasks[${i}].verification[${j}].args 문자열 배열`)
      const cwd = v.cwd == null ? "." : v.cwd
      try { if (cwd !== ".") assertContainedRel(cwd, `tasks[${i}].verification[${j}].cwd`) } catch (e) { errors.push(e.message) }
      if (!Number.isInteger(v.timeout) || v.timeout <= 0) errors.push(`tasks[${i}].verification[${j}].timeout 양의 정수(ms) 필요`)
      // evidencePolicy(선택, 기본 "output-required"): 조용히 성공하는 검증기(tsc --noEmit·eslint·node --check)를
      // 등록하려면 "exit-code-only"를 **명시**해야 한다. 무출력 규칙만 면제되고 도구별 규칙(node --test pass=0 등)은 그대로 적용된다.
      if (v.evidencePolicy != null && v.evidencePolicy !== "output-required" && v.evidencePolicy !== "exit-code-only")
        errors.push(`tasks[${i}].verification[${j}].evidencePolicy는 "output-required"|"exit-code-only" (기본 output-required)`)
    }
    // **실행 영수증은 manifest 필드가 아니라 우리 CLI가 기록한 trial receipt로 강제**한다(h1) — 등록 게이트는 trialGate().
    // 자기진술 필드(`{exitCode:0, output:"ok"}`)는 위조가 자유로워 "안 돌려본 명령 차단"을 기계적으로 보장하지 못하므로 채택하지 않았다.
  }
  // deps 참조 무결성
  for (const [i, t] of (Array.isArray(obj.tasks) ? obj.tasks : []).entries())
    if (Array.isArray(t?.deps)) for (const d of t.deps) if (!taskIds.has(d)) errors.push(`tasks[${i}].deps: 미지 task ${JSON.stringify(d)}`)
  const gateNames = []
  for (const [i, g] of (Array.isArray(obj.gates) ? obj.gates : []).entries()) {
    if (!g || typeof g !== "object") { errors.push(`gates[${i}]: 객체 아님`); continue }
    if (typeof g.name !== "string" || !g.name) errors.push(`gates[${i}].name 필요`)
    else gateNames.push(g.name)
    claimUnit(g.reviewUnit, `gates[${i}]`)
  }
  // Final Wave는 정확히 4종(Coverage·Quality·Runtime·Scope) 강제 — 게이트 생략은 under-verification.
  const REQUIRED_GATES = ["coverage", "quality", "runtime", "scope"]
  const gs = new Set(gateNames)
  const missing = REQUIRED_GATES.filter((n) => !gs.has(n))
  const extra = gateNames.filter((n) => !REQUIRED_GATES.includes(n))
  if (missing.length) errors.push(`Final Wave 게이트 누락: ${missing.join(", ")}(정확히 coverage·quality·runtime·scope 필요)`)
  if (extra.length) errors.push(`Final Wave에 규약 외 게이트: ${extra.join(", ")}`)
  if (gateNames.length !== new Set(gateNames).size) errors.push(`Final Wave 게이트 이름 중복`)
  return errors
}

// canonical manifest(planHash 제외) — plan.md에서 파생된 검증된 tasks/gates만.
export function canonicalManifest(obj) {
  return { tasks: obj.tasks, gates: obj.gates }
}

// ── 순수: 공허한(vacuous) 검증 탐지 (h2) ────────────────────────────────
// verify가 argv를 실행해 **exitCode만** 영수증에 남겼기 때문에, 아무것도 검증하지 않는 명령이 0으로 통과했다
// (실측 사고 형태: `node --test <매치 0건 glob>` → `# tests 0` exit 0 / `--test-name-pattern`으로 전량 skip →
// `# pass 0` exit 0 / 매치 0건 검색 / 무출력 명령). exitCode 0인데 **실행 증거가 없으면** vacuous=true를 receipt에
// 남기고, 완료 재도출이 이를 **미검증**으로 취급한다. exitCode≠0은 이미 blocker라 판정 대상이 아니다
// (vacuous = "증거 없는 통과"). 여기서 못 잡는 것: 의미 오류(예: `rg -e A -e B`가 AND 의도인데 OR) —
// 매치가 있으면 실행 증거는 실재하므로, 그건 h1(등록 전 실제 실행)과 리뷰가 담당한다.
const SEARCH_BASENAMES = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"])
// count 모드 플래그(짧은 묶음 `-rc` 포함). **count 모드일 때만** `path:0`을 카운트로 해석한다 —
// 일반 검색에서 `fixture.txt:0`은 매치된 **줄 내용**이 "0"일 수 있어(예: `rg '0$' fixture.txt`) 증거로 인정해야 한다.
const COUNT_FLAG = /^(?:--count|--count-matches|-[A-Za-z]*c[A-Za-z]*)$/
// TAP(`# tests 3`) / spec 리포터(`ℹ tests 3`) 양쪽의 마지막 카운터 값. 없으면 null.
function tapCounter(stdout, name) {
  const re = new RegExp("^[ \\t]*(?:#|\\u2139)[ \\t]*" + name + "[ \\t]+(\\d+)[ \\t]*$", "gm")
  let last = null, m
  while ((m = re.exec(stdout)) !== null) last = Number(m[1])
  return last
}
export function detectVacuous({ executable = "", args = [], exitCode = 0, stdout = "", stderr = "", evidencePolicy = "output-required" } = {}) {
  const reasons = []
  if (exitCode !== 0) return { vacuous: false, reasons } // 실패는 이미 미완료 — 공허 판정 불필요
  const base = String(executable).split(/[\\/]/).pop()
  const argv = Array.isArray(args) ? args.map(String) : []
  const so = String(stdout == null ? "" : stdout)
  const se = String(stderr == null ? "" : stderr)
  // 무출력 규칙은 **정책 의존**: 침묵은 "500개 검사"와 "0개 검사"를 구분하지 못하므로 기본은 공허로 본다.
  // 조용히 성공하는 검증기는 manifest에 evidencePolicy:"exit-code-only"를 명시해 면제한다(A4 설계 리뷰에서 보이는 선택).
  if (evidencePolicy !== "exit-code-only" && so.trim() === "" && se.trim() === "")
    reasons.push("출력 0바이트(stdout·stderr 모두 공백) — 무엇을 검증했는지 증거 없음(의도된 침묵이면 evidencePolicy:\"exit-code-only\" 명시)")
  if (base === "node" && argv.includes("--test")) {
    const pass = tapCounter(so, "pass")
    const tests = tapCounter(so, "tests")
    // pass=0이면 실제로 통과한 테스트가 없다 — tests=0(경로/glob 미매치)과 전량 skip(--test-only·이름필터) 모두 포함.
    if (pass === 0) reasons.push(`node --test가 통과시킨 테스트 0건(tests=${tests == null ? "?" : tests}, pass=0) — 경로·glob·이름필터가 아무 테스트도 실행하지 않음`)
  }
  if (SEARCH_BASENAMES.has(base) || (base === "git" && argv[0] === "grep")) {
    const lines = so.split("\n").map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) reasons.push("검색 명령인데 매치 0건 — 확인한 것이 없음")
    // count 문법은 count 모드에서만 해석(일반 검색의 비어있지 않은 출력은 매치 증거로 인정 — `rg '0$' f.txt` 오탐 방지).
    else if (argv.some((a) => COUNT_FLAG.test(a)) && lines.every((l) => /(?:^|:)0$/.test(l)))
      reasons.push("검색 카운트가 전부 0 — 매치 0건")
  }
  return { vacuous: reasons.length > 0, reasons }
}

// ── 순수: 완료 재도출 (§4 — Stop 가드의 심장) ───────────────────────────
// snap.currentWholeTree = 현재 working tree SHA. snap.units[reviewUnit] = {
//   openBlocking:int|null(손상=null), machineState, receipt:{exitCode,planHash,scopeHash,vacuous,vacuousReasons}|null,
//   expectedScopeHash:str|null(=reviewedPostSHA 기준 scope hash), currentScopeHash:str|null(=현재 tree scope hash),
//   reviewedPostSHA:str|null(gate용) }
// 각 task: ledger APPROVE ∧ machineState APPROVED ∧ receipt pass ∧ **현재 scope == 리뷰/검증 scope**(리뷰 후 수정이면 미완료).
// 각 gate: ledger approved ∧ **현재 전체 tree == 리뷰된 전체 tree**(게이트 후 수정이면 미완료). manifest 순회 → 위조 무력.
export function deriveCompletion(manifest, snap) {
  const blockers = []
  const unit = (u) => (snap.units && snap.units[u]) || {}
  for (const t of manifest.tasks) {
    const u = unit(t.reviewUnit)
    if (u.openBlocking == null) { blockers.push(`task ${t.id}: ledger 없음/손상(${t.reviewUnit})`); continue }
    if (u.openBlocking > 0) blockers.push(`task ${t.id}: open blocking ${u.openBlocking}`)
    if (u.machineState !== "APPROVED") blockers.push(`task ${t.id}: review 미승인(machineState=${u.machineState})`)
    if (!u.receipt) blockers.push(`task ${t.id}: verification receipt 없음`)
    else {
      if (u.receipt.exitCode !== 0) blockers.push(`task ${t.id}: verification 실패(exitCode=${u.receipt.exitCode})`)
      // 공허한 통과(h2)는 **미검증**으로 취급 — exitCode 0이어도 실행 증거가 없으면 검증된 것이 아니다.
      if (u.receipt.vacuous) blockers.push(`task ${t.id}: verification이 공허함(${(u.receipt.vacuousReasons || []).join("; ") || "실행 증거 없음"}) — 실제로 검증하는 명령으로 교체 후 재검증`)
      if (u.receipt.planHash !== snap.planHash) blockers.push(`task ${t.id}: receipt planHash 불일치`)
      if (u.expectedScopeHash == null) blockers.push(`task ${t.id}: 리뷰된 artifact(reviewedPostSHA) 없음 — scope 바인딩 불가`)
      else {
        if (u.receipt.scopeHash !== u.expectedScopeHash) blockers.push(`task ${t.id}: receipt scopeHash ≠ 리뷰 tree scope(검증이 리뷰 tree 밖에서 돎)`)
        // 핵심: 현재 working tree의 scope가 리뷰/검증된 scope와 같아야 함. 리뷰 후 코드를 고치면 여기서 미완료.
        if (u.currentScopeHash == null) blockers.push(`task ${t.id}: 현재 scope 해시 계산 실패`)
        else if (u.currentScopeHash !== u.receipt.scopeHash) blockers.push(`task ${t.id}: 코드가 리뷰/검증 후 변경됨(현재 scope ≠ 리뷰 scope) — 재리뷰·재검증 필요`)
      }
    }
  }
  for (const g of manifest.gates) {
    const u = unit(g.reviewUnit)
    if (u.openBlocking == null) { blockers.push(`gate ${g.name}: ledger 없음/손상(${g.reviewUnit})`); continue }
    if (u.openBlocking > 0) blockers.push(`gate ${g.name}: open blocking ${u.openBlocking}`)
    if (u.machineState !== "APPROVED") blockers.push(`gate ${g.name}: 미승인(machineState=${u.machineState})`)
    // Final Wave는 전체 통합을 보므로 전체 tree로 바인딩: 리뷰된 tree == 현재 tree.
    if (!u.reviewedPostSHA) blockers.push(`gate ${g.name}: reviewedPostSHA 없음 — 전체 tree 바인딩 불가`)
    else if (snap.currentWholeTree != null && u.reviewedPostSHA !== snap.currentWholeTree)
      blockers.push(`gate ${g.name}: 게이트 리뷰 후 코드 변경됨(현재 tree ≠ 리뷰 tree) — Final Wave 재실행 필요`)
  }
  return { complete: blockers.length === 0, blockers }
}

// ── 순수: authority seal 입력 (§2 DR-003) ──────────────────────────────
// files = [{ path(정렬키), content }]. 순서 무관 안정 해시.
export function sealHashOf(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256(stableStringify(sorted.map((f) => [f.path, sha256(f.content)])))
}

// ── 순수: HARNIE_STATUS footer 파싱 (§5.2 H2) ──────────────────────────
// 오케스트레이터 최종 응답 말미의 machine-readable footer. COMPLETE | INCOMPLETE — <blocker>.
export function parseStatusFooter(lastMessage) {
  if (typeof lastMessage !== "string") return { present: false, status: null }
  const m = lastMessage.match(/HARNIE_STATUS:\s*(COMPLETE|INCOMPLETE)\b(.*)$/im)
  if (!m) return { present: false, status: null }
  return { present: true, status: m[1].toUpperCase(), detail: (m[2] || "").trim() }
}

// ── 순수: AskUserQuestion 응답에서 **바인딩된 질문/헤더 키의 선택값만** 추출 (§4 승인 바인딩) ──
// 답 값을 평탄화하거나 단일 키로 fallback하지 않는다 — 반드시 `answers` plain object의 question(또는 명시 header)
// **정확 키 일치**만 승인 후보(다른 질문의 "승인" 답·비-answers 객체 오연결 차단, fail-closed).
export function answerForQuestion(response, question, header) {
  let obj = response
  if (typeof obj === "string") { try { obj = JSON.parse(obj) } catch { return [] } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return []
  const answers = obj.answers
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [] // answers plain object 필수
  const norm = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" ? [v] : [])
  for (const k of [question, header]) if (k != null && Object.prototype.hasOwnProperty.call(answers, k)) return norm(answers[k])
  return [] // 정확 키 불일치 → fail-closed(승인 안 됨)
}

// ── IO 헬퍼 ─────────────────────────────────────────────────────────────
function readJSONStrict(path) {
  const raw = readFileSync(path, "utf8")
  let obj
  try { obj = JSON.parse(raw) } catch (e) { throw new FailClosed(`${path} JSON 손상: ${e.message}`) }
  return obj
}
function readJSONOrNull(path) {
  return existsSync(path) ? readJSONStrict(path) : null
}
// atomic write: tmp → rename(같은 dir). 부분기록 fail-closed(§9).
function writeJSONAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + ".tmp"
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n")
  renameSync(tmp, path)
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
}

// repo root: --root 명시. .harnie 하위 경로.
function planDir(root, track, slug) {
  validateSlug(slug)
  if (track !== "plan" && track !== "quick") throw new FailClosed(`track는 plan|quick (${track})`)
  return join(root, ".harnie", track, slug)
}
function sentinelPath(root) { return join(root, ".harnie", "active.json") }

// git subtree 해시(scope 경로들의 tree SHA에서). 검증 tree ≠ 리뷰 tree 탐지의 기준.
function computeScopeHash(root, treeSHA, scopePaths) {
  const lsTree = execFileSync("git", ["-C", root, "ls-tree", "-r", treeSHA, "--", ...scopePaths], { encoding: "utf8" })
  return sha256(lsTree)
}

// 리뷰 단위 디렉터리 읽어 완료 재도출 snapshot 구성.
function buildSnapshot(root, track, slug, manifest, planHash) {
  const dir = planDir(root, track, slug)
  const reviewRoot = join(dir, "review")
  const units = {}
  const unitNames = new Set([...manifest.tasks.map((t) => t.reviewUnit), ...manifest.gates.map((g) => g.reviewUnit)])
  const taskByUnit = new Map(manifest.tasks.map((t) => [t.reviewUnit, t]))
  // 현재 working tree를 한 번 캡처 — 리뷰/검증 후 코드가 바뀌었는지 판정의 기준(현재 tree ↔ 리뷰 tree).
  const currentWholeTree = captureTree(root)
  for (const name of unitNames) {
    const uDir = join(reviewRoot, name)
    const ledger = readJSONOrNull(join(uDir, "ledger.json"))
    let openBlocking = null
    if (ledger !== null) {
      // task 코드 리뷰와 Final Wave 게이트 모두 namespace = CR(설계 리뷰 DR은 코드 前 단계라 완료 재도출 대상 아님).
      const errs = validateLedger(ledger, { namespace: "CR" })
      openBlocking = errs.length ? null : openBlockingCount(ledger)
    }
    const state = readJSONOrNull(join(uDir, "state.json"))
    const machineState = state && typeof state === "object" ? state.machineState : null
    const reviewedPostSHA = state && typeof state === "object" ? state.reviewedPostSHA : null
    const receipt = readJSONOrNull(join(uDir, "receipt.json"))
    const task = taskByUnit.get(name)
    let expectedScopeHash = null, currentScopeHash = null
    if (task && reviewedPostSHA) {
      try { expectedScopeHash = computeScopeHash(root, reviewedPostSHA, task.scope) } catch { expectedScopeHash = null }
    }
    if (task) {
      try { currentScopeHash = computeScopeHash(root, currentWholeTree, task.scope) } catch { currentScopeHash = null }
    }
    units[name] = {
      openBlocking,
      machineState,
      // vacuous는 구버전 receipt(필드 부재)에서 undefined → falsy → 하위호환(차단 안 함).
      receipt: receipt && typeof receipt === "object"
        ? { exitCode: receipt.exitCode, planHash: receipt.planHash, scopeHash: receipt.scopeHash, vacuous: receipt.vacuous === true, vacuousReasons: Array.isArray(receipt.vacuousReasons) ? receipt.vacuousReasons : [] }
        : null,
      expectedScopeHash,
      currentScopeHash,
      reviewedPostSHA, // gate 전체-tree 바인딩용
    }
  }
  return { planHash, units, currentWholeTree }
}

// authority seal 파일 목록: plan.md + manifest.json + review/*/{ledger,state,receipt}.json.
// advisory(active.json·execution.json·notepad.md)와 round-*.txt·delta.patch·.seal.json은 제외.
function collectAuthorityFiles(root, track, slug) {
  const dir = planDir(root, track, slug)
  const files = []
  const add = (p) => { if (existsSync(p)) files.push({ path: p.slice(dir.length + 1), content: readFileSync(p, "utf8") }) }
  add(join(dir, "plan.md"))
  add(join(dir, "manifest.json"))
  const reviewRoot = join(dir, "review")
  if (existsSync(reviewRoot)) {
    for (const name of readdirSync(reviewRoot)) {
      for (const f of ["ledger.json", "state.json", "receipt.json"]) add(join(reviewRoot, name, f))
    }
  }
  return files
}

// 권위 승인 재검증: manifest+plan.md에서 planHash 재계산 → sentinel·manifest와 일치 ∧ manifest 내용==현재 plan.md 블록.
// 저장된 planHash 두 값 비교로는 승인 후 plan.md 수정·manifest 직접 변조를 못 잡으므로 현재 소스에서 재도출한다.
export function authorityApproved(dir, sentinelPlanHash) {
  const manifestPath = join(dir, "manifest.json")
  const planPath = join(dir, "plan.md")
  if (!existsSync(manifestPath) || !existsSync(planPath)) return false
  let m
  try { m = readJSONStrict(manifestPath) } catch { return false }
  if (!m || !m.planHash || m.planHash !== sentinelPlanHash) return false
  const planMd = readFileSync(planPath, "utf8")
  let block
  try { block = extractManifestBlock(planMd) } catch { return false }
  if (validateManifest(block).length) return false
  if (computePlanHash(planMd, canonicalManifest(block)) !== m.planHash) return false // plan.md 수정 탐지
  if (stableStringify(canonicalManifest(m)) !== stableStringify(canonicalManifest(block))) return false // manifest 변조 탐지
  return true
}

// 활성 컨텍스트 로드(훅 부트스트랩) — sentinel-first fail-closed. 비활성이면 {active:false}.
export function loadContext(root) {
  const sentinel = sentinelPath(root)
  if (!existsSync(sentinel)) return { active: false }
  const s = readJSONStrict(sentinel)
  if (!s || typeof s !== "object" || !s.track || !s.slug) return { active: true, failClosed: true, reason: "active.json 손상" }
  const dir = planDir(root, s.track, s.slug)
  const execPath = join(dir, "execution.json")
  // sessionIds = run에 진입·재개한 소유 세션 **집합**(hooks/lib.mjs isOwnerSession이 membership으로 판정).
  // 빈 배열 = 미기록 → 훅이 repo 전역 적용으로 폴백(보수적).
  const fc = (reason) => ({ active: true, failClosed: true, reason, root, track: s.track, slug: s.slug, sessionIds: normalizeOwnerSessions(s), readOnlyThreads: s.readOnlyThreads || [], builderThreads: [] })
  if (!existsSync(execPath)) return fc("sentinel 존재하나 execution.json 부재(§3 crash/손상)")
  let ex
  try { ex = readJSONStrict(execPath) } catch (e) { return fc(e.message) }
  if (ex.slug !== s.slug || ex.track !== s.track) return fc("execution.json이 sentinel과 불일치")
  const builderThreads = Object.values(ex.tasks || {}).map((t) => t && t.builderThreadId).filter(Boolean)
  // 권위 승인 판정(§4): 저장값 비교만으론 부족 — **현재 plan.md에서 planHash를 재계산**해 sentinel·manifest와 모두
  // 일치하고, manifest 내용이 현재 plan.md 블록과 canonical 동일해야 approved(승인 후 plan.md 수정·manifest 변조 탐지).
  // advisory execution.json.phase는 신뢰하지 않는다.
  const approved = authorityApproved(dir, s.planHash)
  // 승인 흔적(manifest 존재)이 있는데 approved가 false면 = 승인 후 plan.md/manifest 변조. Stop이 phase 무관 block해야 함.
  const approvalEvidence = existsSync(join(dir, "manifest.json")) || !!s.planHash
  const rawPhase = ex.phase
  // effectivePhase: 승인 전이면 executing/final-wave 주장을 awaiting-approval로 강등(쓰기 게이트 닫음).
  const effectivePhase = approved ? rawPhase : (rawPhase === "executing" || rawPhase === "final-wave" ? "awaiting-approval" : rawPhase)
  return { active: true, root, track: s.track, slug: s.slug, sessionIds: normalizeOwnerSessions(s), phase: effectivePhase, rawPhase, approved, approvalEvidence, readOnlyThreads: s.readOnlyThreads || [], builderThreads }
}

// 완료 재도출(§4) — manifest 순회. manifest 부재(승인 前)면 완료 강제 없음(noManifest).
export function computeCompletion(root, track, slug) {
  const dir = planDir(root, track, slug)
  const manifestPath = join(dir, "manifest.json")
  if (!existsSync(manifestPath)) return { complete: true, blockers: [], noManifest: true }
  const manifest = readJSONStrict(manifestPath)
  const snap = buildSnapshot(root, track, slug, manifest, manifest.planHash)
  return deriveCompletion(manifest, snap)
}

// ── Bootstrap (진입점 훅 소유) — sentinel 결정적 생성·전환 + rollover + exclusive lock ──
// 설계: docs/bootstrap-adherence.md. 스킬 A0의 자체 init을 대체(지침 의존 갭 제거).
function lockPath(root) { return join(root, ".harnie", "state.lock") }
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* fallback: no sleep */ } }
// exclusive lock(§3.5): O_EXCL(`openSync 'wx'`) + 소유권 토큰. **자동 회수 없음**: stale/dead lock을 시간·PID·rename으로 회수하면
// 회수자 경합(TOCTOU)이 상호배제를 깨뜨릴 수 있어 제거한다. 짧은 재시도로 일시 경합만 넘기고, 지속되면 fail-closed(수동 복구).
// critical section은 동기 파일쓰기 몇 개뿐이라 crash-중-hold는 극히 드물고, 남으면 사용자가 `rm .harnie/state.lock`(안내 메시지 제공).
function acquireLock(root) {
  const lp = lockPath(root)
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`
  mkdirSync(dirname(lp), { recursive: true })
  for (let i = 0; i < 200; i++) {
    try {
      const fd = openSync(lp, "wx")
      try { writeFileSync(fd, token) } finally { closeSync(fd) }
      return { lp, token }
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      sleepMs(20)
    }
  }
  throw new FailClosed("harnie state.lock이 지속됩니다 — 활성 harnie 상태 작업이 없음을 확인한 뒤 **사용자가 외부 터미널에서** `rm .harnie/state.lock`으로 제거하세요(훅 내부 Bash로는 차단됨).")
}
// **우리 토큰일 때만** 삭제(남의 lock을 지우지 않도록).
function releaseLock(lock) {
  if (!lock) return
  try { if (readFileSync(lock.lp, "utf8") === lock.token) unlinkSync(lock.lp) } catch { /* 이미 없음/타인 소유 → 손대지 않음 */ }
}
// 모든 active.json read-modify-write는 이 lock 하에서 직렬화(bootstrap rollover ↔ 승인/thread 등록 경합 방지 — P1-3b).
export function withStateLock(root, fn) {
  const lock = acquireLock(root)
  try { return fn() } finally { releaseLock(lock) }
}

// ── pending-route 게이트(§3.9) — **per-session 파일**(`.harnie/pending-route/<sid>.json`) + **state machine**(pending|failed) ──
// per-session 파일이라 **state lock 불필요**(각 세션이 자기 파일만 씀 → markRouteFailed가 lock 경합에 막히지 않음, P1-1).
// 이 디렉터리는 **control path**(guards.isControlPath)라 다른 세션의 tool 쓰기/삭제가 차단된다(P1-3). **시간 만료 없음(P1-2)**.
// 해제는 Skill 성공(clear)·정직한 실패 보고 후 Stop(clear)·(향후 SessionEnd)에서만.
function sanitizeSession(sessionId) {
  const s = String(sessionId || "")
  if (!NAME_RE.test(s) || s === "." || s === "..") throw new FailClosed(`pending-route: 부적합 session_id ${JSON.stringify(sessionId)}`)
  return s
}
function routeFile(root, sessionId) { return join(root, ".harnie", "pending-route", sanitizeSession(sessionId) + ".json") }
export function writePendingRoute(root, sessionId) {
  if (!sessionId) throw new FailClosed("pending-route: session_id 필요")
  writeJSONAtomic(routeFile(root, sessionId), { state: "pending", at: new Date().toISOString() })
}
// 라우팅 시도했으나 bootstrap 실패(P1-1): 작업은 계속 막되 Stop은 정직한 실패 보고 후 허용·정리. **기존 항목 있을 때만** 전환(직접 진입 실패는 latch 안 함).
export function markRouteFailed(root, sessionId, reason) {
  if (!sessionId) return
  const f = routeFile(root, sessionId)
  if (!existsSync(f)) return
  writeJSONAtomic(f, { state: "failed", reason: String(reason || "").slice(0, 300), at: new Date().toISOString() })
}
// **strict 정리(P1-3)**: 게이트를 여는 정리는 best-effort면 안 된다 — 삭제 실패(권한/IO)면 rmSync가 throw(force는 ENOENT만 무시),
// 그 후에도 파일이 남아 있으면 throw. 성공을 보고했는데 route 파일이 남아 gate가 latch되는 것을 방지(호출자는 exit2/block로 fail-closed).
export function clearPendingRoute(root, sessionId) {
  if (!sessionId) return
  const f = routeFile(root, sessionId)
  rmSync(f, { force: true }) // ENOENT 무시, 권한/IO 오류는 throw
  if (existsSync(f)) throw new FailClosed(`pending-route 정리 실패(파일 잔존) — gate가 남을 수 있음: ${f}`)
}
// 상태: null | "pending" | "failed". 시간 만료 없음.
// **엄격 검증(P1)**: 파일 부재만 null. 존재하면 반드시 plain object + state ∈ {pending, failed}.
// 그 외(손상된 JSON은 readJSONStrict가, 유효 JSON이지만 알 수 없는 state는 여기서) FailClosed —
// 손상 route가 pretooluse는 막고 Stop은 분기 미매치로 통과시키는 fail-open 차단.
export function getRouteState(root, sessionId) {
  if (!sessionId) return null
  const f = routeFile(root, sessionId)
  if (!existsSync(f)) return null
  const e = readJSONStrict(f)
  if (!e || typeof e !== "object" || Array.isArray(e) || (e.state !== "pending" && e.state !== "failed")) {
    throw new FailClosed(`pending-route 손상(알 수 없는 state) — 수동 확인 필요: ${f}`)
  }
  return e.state
}
// pretooluse용: pending·failed 둘 다 작업 차단(둘 다 active run 없음).
export function hasPendingRoute(root, sessionId) { return getRouteState(root, sessionId) !== null }

// 충돌 없는 run slug: base, base-2, base-3, …(dir 미존재인 첫 후보). 완료된 과거 run을 재사용해 거짓완료 만드는 것 방지.
function collisionFreeSlug(root, track, base) {
  validateSlug(base)
  let slug = base
  for (let n = 2; existsSync(planDir(root, track, slug)); n++) slug = `${base}-${n}`
  return slug
}
// rollover 판정(§3.4): manifest 존재 && authorityApproved && computeCompletion.complete. noManifest(승인 전 planning)은 미완료.
function genuinelyComplete(root, track, slug) {
  const dir = planDir(root, track, slug)
  const sentinelPlanHash = (readJSONOrNull(sentinelPath(root)) || {}).planHash
  if (!authorityApproved(dir, sentinelPlanHash)) return false
  const comp = computeCompletion(root, track, slug)
  return comp.complete === true && comp.noManifest !== true
}
// run에 **명시적으로 진입·재개한 세션들의 집합**(hooks/lib.mjs isOwnerSession의 권위).
// 불변식: **식별 가능한 상태로 참여한 세션은 run이 끝날 때까지 계속 owner다.** 세션 종료를 확인할 증거가 없으므로
// 집합에서 빼지 않는다 — 빼는 순간 아직 작업 중인 그 세션의 H1 승인-前 쓰기·H2 Stop·PostToolUse 관찰 보호가
// 전부 풀린다(두 세션 동시 활성은 정상 시나리오다). 그래서 owner 판정은 **membership**이고 resume은 **union**만 한다.
// 식별자 없는 resume도 집합을 건드리지 않는다: isOwnerSession은 payload에 session_id가 없으면 이미 owner로
// 취급하므로 지울 이유가 없고, 지우면 그 뒤 식별 가능한 resume이 집합을 다시 좁혀(=[새 세션]) 이전 참여자가 빠진다.
function ownerSessionId(sessionId) { return typeof sessionId === "string" && sessionId !== "" ? sessionId : null }
// sentinel의 소유자 표현을 배열로 정규화(레거시 스칼라 sessionId도 1개 집합으로 취급).
export function normalizeOwnerSessions(s) {
  if (!s || typeof s !== "object") return []
  if (Array.isArray(s.sessionIds)) return s.sessionIds.filter((x) => typeof x === "string" && x !== "")
  const one = ownerSessionId(s.sessionId)
  return one ? [one] : []
}
// 새 run 생성: execution.json 먼저, active.json(포인터) 마지막 원자 전환(§3.5). old dir은 건드리지 않음(보존).
function createRun(root, track, base, sessionId) {
  const slug = collisionFreeSlug(root, track, base)
  const owner = ownerSessionId(sessionId)
  writeJSONAtomic(join(planDir(root, track, slug), "execution.json"), { track, slug, planHash: null, phase: "planning", tasks: {} })
  writeJSONAtomic(sentinelPath(root), { track, slug, base, planHash: null, readOnlyThreads: [], sessionIds: owner ? [owner] : [] })
  return { slug, reused: false }
}
// resume: execution.json **strict read + sentinel 일치 검증**(P2-5, cmdInit 수준). 존재 확인만으론 손상 통과.
// 재개 세션을 소유자 집합에 **추가**한다(monotonic union). 추가하지 않으면 재개 세션이 비-owner로 판정돼 강제가
// 통째로 꺼지고(fail-open), 교체하거나 비우면 아직 작업 중인 이전 참여 세션의 보호가 풀린다.
function resumeRun(root, s, sessionId) {
  const execPath = join(planDir(root, s.track, s.slug), "execution.json")
  if (!existsSync(execPath)) throw new FailClosed("sentinel 존재하나 execution.json 부재 — 손상, fail-closed")
  const ex = readJSONStrict(execPath) // JSON 손상이면 throw
  if (ex.track !== s.track || ex.slug !== s.slug) throw new FailClosed("execution.json이 sentinel과 불일치 — 손상, fail-closed")
  const owner = ownerSessionId(sessionId)
  const prev = normalizeOwnerSessions(s)
  // 식별자가 없으면 **그대로 보존**(비우지 않는다 — 그 세션은 isOwnerSession에서 이미 owner이고, 비우면 다음
  // 식별 가능한 resume이 집합을 [새 세션]으로 좁혀 이전 참여자가 빠진다).
  const next = owner ? (prev.includes(owner) ? prev : [...prev, owner]) : prev
  // 레거시 스칼라 표현도 이 기회에 배열로 이관. 호출자(bootstrapRun)의 state lock 하에서 RMW.
  if (stableStringify(next) !== stableStringify(prev) || s.sessionId !== undefined || !Array.isArray(s.sessionIds)) {
    s.sessionIds = next
    delete s.sessionId
    writeJSONAtomic(sentinelPath(root), s)
  }
  return { slug: s.slug, reused: true, resumed: true }
}
// 진입점 훅이 호출. base=slugify(작업인자). 결정표(§3.4)로 resume/new/block. **state lock으로 직렬화**(P1-3). 성공 시 이 세션의 pending-route 해소.
// park해둔 run 중 이 base에서 파생된 후보(base, base-2, …). **자동 재개는 하지 않는다** — 후보가 여럿이거나
// 오래된 작업일 수 있어 자동 선택이 위험하므로, 정확한 resume 명령만 안내한다(리뷰 권고).
function parkedCandidates(root, track, base) {
  const d = join(root, ".harnie", "parked", track)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((s) => s === base || s.startsWith(base + "-"))
    .filter((s) => existsSync(join(d, s, "active.json")))
    .sort()
}
export function bootstrapRun(root, { base, track = "plan", sessionId = null } = {}) {
  if (track !== "plan") throw new FailClosed(`bootstrapRun: 현재 track=plan만 (${track})`) // quick 이연(§3.8)
  if (typeof base !== "string" || base === "") throw new FailClosed("bootstrap: 빈 작업 인자 — 진행 불가")
  validateSlug(base)
  return withStateLock(root, () => {
    const s = readJSONOrNull(sentinelPath(root))
    let result
    if (!s) result = createRun(root, track, base, sessionId)
    else if (!s.track || !s.slug) throw new FailClosed("active.json 손상 — track/slug 누락, fail-closed")
    else if (genuinelyComplete(root, s.track, s.slug)) result = createRun(root, track, base, sessionId) // 완료 → 새 run(포인터 전환·old 보존)
    else if (s.track === track && (s.base || s.slug) === base) result = resumeRun(root, s, sessionId) // 같은 작업(구버전 sentinel은 slug=base) → resume
    else throw new FailClosed(`미완료 run ${s.track}/${s.slug}가 활성 상태입니다. 기존 run을 재개하여 완료하거나, 승인 前이라면 \`execution.mjs park --root ${root} --track ${s.track} --slug ${s.slug}\`로 보류한 뒤 새 작업을 시작하세요.`)
    clearPendingRoute(root, sessionId) // 부트스트랩 성공 = 이 세션 라우팅 해소(§3.9, per-session 파일이라 lock-free)
    // 새 run을 만들 때 같은 base의 parked run이 있으면 **후보와 정확한 resume 명령을 안내**(자동 선택은 하지 않음).
    const parked = result.reused ? [] : parkedCandidates(root, track, base)
    if (parked.length)
      return { ...result, parkedCandidates: parked, hint: `보류(park)된 같은 작업의 run이 있습니다: ${parked.join(", ")}. 이어서 하려면 새 run 대신 \`execution.mjs resume --root ${root} --track ${track} --slug <slug>\`.` }
    return result
  })
}

// ── 승인 前 run의 지원되는 종료 경로: park / resume ──────────────────────
// 왜: 승인 前 planning run을 중단하고 다른 작업을 하려면 사용자가 터미널에서 `mv .harnie/active.json …`으로
// 포인터를 손수 치우는 수밖에 없었다 = 지원되는 이탈 경로 부재. 그 우회는 훅 밖에서 벌어져 state lock·rollover와
// 무관하게 sentinel을 흔든다. park는 그 동작을 **lock 하의 지원되는 연산**으로 흡수한다.
// 불변식: ① 승인 前(planHash 없음 ∧ manifest 부재)에만 허용 — 승인 後 run은 park 금지("abort 없음" 결정 유지).
//        ② plan.md·ledger·notepad·run 디렉터리는 **그대로** 두고 sentinel 포인터만 옮긴다(작업 손실 없음).
//        ③ 모든 sentinel RMW는 withStateLock 하에서.
function parkedSentinelPath(root, track, slug) {
  validateSlug(slug)
  if (track !== "plan" && track !== "quick") throw new FailClosed(`track는 plan|quick (${track})`)
  // basename을 active.json으로 두어 guards.isControlPath의 control 보호(tool 직접 쓰기 금지)를 그대로 받는다.
  return join(root, ".harnie", "parked", track, slug, "active.json")
}
export function parkRun(root, { track = "plan", slug = null } = {}) {
  return withStateLock(root, () => {
    const sPath = sentinelPath(root)
    const s = readJSONOrNull(sPath)
    if (!s) throw new FailClosed("활성 run 없음 — park할 포인터가 없습니다(.harnie/active.json 부재)")
    if (!s.track || !s.slug) throw new FailClosed("active.json 손상 — track/slug 누락, fail-closed")
    // 호출자가 대상을 명시하면 활성 run과 정확히 일치해야 한다(엉뚱한 run을 park하는 실수 차단).
    if (slug != null && slug !== s.slug) throw new FailClosed(`park 대상 불일치: --slug ${slug} ≠ 활성 ${s.slug}`)
    if (track !== s.track) throw new FailClosed(`park 대상 불일치: --track ${track} ≠ 활성 ${s.track}`)
    const dir = planDir(root, s.track, s.slug)
    if (s.planHash || existsSync(join(dir, "manifest.json")))
      throw new FailClosed(`승인된 run(${s.track}/${s.slug})은 park할 수 없습니다 — 승인 후에는 완료까지 진행해야 합니다(abort 없음).`)
    // **손상 run을 park로 세탁하지 않는다**: resume과 동일한 strict 검증을 포인터 이동 前에 수행한다.
    // (검증 없이 포인터만 치우면, fail-closed였어야 할 손상 상태가 "비활성"으로 바뀌어 새 작업을 시작할 수 있게 된다.
    //  state.lock 선례와 같이 손상 복구는 **명시적·수동** 행위로 남긴다.)
    const execPath = join(dir, "execution.json")
    if (!existsSync(execPath)) throw new FailClosed(`park 거부: execution.json 부재(${s.track}/${s.slug}) — 손상 상태는 park로 숨길 수 없습니다, fail-closed`)
    const ex = readJSONStrict(execPath) // JSON 손상이면 throw
    if (ex.track !== s.track || ex.slug !== s.slug) throw new FailClosed("park 거부: execution.json이 sentinel과 불일치 — 손상, fail-closed")
    // 미승인인데 실행 단계를 주장하는 phase는 손상(승인 우회 흔적) → park 금지.
    if (ex.phase === "executing" || ex.phase === "final-wave")
      throw new FailClosed(`park 거부: 승인(manifest) 없이 phase=${ex.phase} 주장 — 손상/승인 우회, fail-closed`)
    const pPath = parkedSentinelPath(root, s.track, s.slug)
    // 같은 (track,slug) 경로는 항상 같은 run이다(신규 run은 collisionFreeSlug가 dir 재사용을 막음) → 덮어쓰기 안전.
    // resume 중 crash로 남은 parked 잔재도 이 경로에서 자연 복구된다(수동 개입이 필요한 stuck 상태 없음).
    writeJSONAtomic(pPath, { ...s, parkedAt: new Date().toISOString() })
    unlinkSync(sPath) // 포인터만 치운다
    // 일회성 승인 스캐폴딩은 정리 — 나중 세션에서 stale arm/pending이 승인에 바인딩되지 않게.
    rmSync(join(dir, ".arm-approval.json"), { force: true })
    rmSync(join(dir, ".pending-approval.json"), { force: true })
    return {
      ok: true, parked: { track: s.track, slug: s.slug }, dir, pointer: pPath,
      resumeHint: `execution.mjs resume --root ${root} --track ${s.track} --slug ${s.slug}`,
    }
  })
}
// park해둔 run을 다시 활성화. 활성 run이 이미 있으면 fail-closed(동시 활성 금지).
export function resumeParkedRun(root, { track = "plan", slug = null, sessionId = null } = {}) {
  if (!slug) throw new FailClosed("resume: --slug 필요(park해둔 run의 slug)")
  return withStateLock(root, () => {
    const sPath = sentinelPath(root)
    if (existsSync(sPath)) {
      const cur = readJSONOrNull(sPath) || {}
      throw new FailClosed(`이미 활성 run(${cur.track}/${cur.slug})이 있습니다 — 먼저 완료하거나 park한 뒤 resume하세요.`)
    }
    const pPath = parkedSentinelPath(root, track, slug)
    if (!existsSync(pPath)) throw new FailClosed(`park된 run 없음: ${track}/${slug} (${pPath})`)
    const p = readJSONStrict(pPath)
    if (p.track !== track || p.slug !== slug) throw new FailClosed("park 기록이 경로와 불일치 — 손상, fail-closed")
    // run 디렉터리 무결성은 resumeRun과 같은 기준(strict read + sentinel 일치).
    const execPath = join(planDir(root, track, slug), "execution.json")
    if (!existsSync(execPath)) throw new FailClosed("park된 run에 execution.json 부재 — 손상, fail-closed")
    const ex = readJSONStrict(execPath)
    if (ex.track !== track || ex.slug !== slug) throw new FailClosed("execution.json이 park 기록과 불일치 — 손상, fail-closed")
    const next = { ...p }
    delete next.parkedAt
    // 소유자 집합은 **monotonic union**(resumeRun과 동일 규칙): 재개 세션을 추가하되 이전 참여자를 빼지 않는다.
    // 교체·삭제하면 아직 작업 중인 이전 세션의 H1/H2 보호가 풀리고, 식별자 없는 resume이 집합을 비우면
    // 다음 식별 가능한 resume이 집합을 [새 세션]으로 좁혀 이전 참여자가 빠진다. 레거시 스칼라도 이 기회에 이관.
    const owner = ownerSessionId(sessionId)
    const prev = normalizeOwnerSessions(p)
    next.sessionIds = owner ? (prev.includes(owner) ? prev : [...prev, owner]) : prev
    delete next.sessionId
    writeJSONAtomic(sPath, next)
    rmSync(pPath, { force: true })
    if (existsSync(pPath)) throw new FailClosed(`park 기록 정리 실패(잔존): ${pPath} — 수동 확인 필요`)
    return { ok: true, resumed: true, track, slug, phase: ex.phase }
  })
}

// ── pending-route의 이탈 경로: route-abandon (§3.9) ─────────────────────
// 게이트 해제가 ①track 스킬 성공 ②bootstrap 실패 후 정직 보고 둘뿐이라, **"조사해보니 지금 착수하면 안 되겠다"는
// 정당한 결론을 표현할 수단이 없었다**(세션이 무한 Stop 루프에 걸려, 빠져나오려면 잘못된 트랙 스킬을 호출해야 했다).
// 기존 markRouteFailed 경로를 재사용해 state=failed로 두면 Stop 훅이 이미 "정직한 실패 보고 후 허용·정리"를
// 처리하므로 hooks/ 변경 없이 이탈된다. 항목이 없으면 no-op(직접 진입은 latch 안 함).
export function abandonRoute(root, sessionId, reason = null) {
  if (!sessionId) throw new FailClosed("route-abandon: --session 필요")
  const why = `사용자 결정: 라우팅 포기(착수 보류)${reason ? ` — ${String(reason)}` : ""}`
  markRouteFailed(root, sessionId, why)
  return { ok: true, session: sanitizeSession(sessionId), state: getRouteState(root, sessionId), reason: why }
}
// **pending-route 게이트의 좁은 예외 판정**(PreToolUse가 pending 분기 앞에서 사용). pending 상태에서 Bash가 전면
// 차단되면 이탈 명령 자체를 실행할 수 없으므로, "이 세션의 route-abandon"만 통과시키기 위한 조건을 여기서 정의한다
// (pending-route 상태머신을 소유한 모듈에 두어 게이트 해제 조건이 한 곳에 모이게 한다).
// 조건: ① 셸 메타 없음 ② 인터프리터=bare `node` 또는 신뢰 절대경로 ③ 스크립트=신뢰 execution.mjs 정확 일치
//      ④ 서브커맨드가 정확히 route-abandon ⑤ 중복 플래그 없음 ⑥ 플래그는 --root/--session/--reason만
//      ⑦ --root === active root ⑧ --session === **호출 세션 자신**(남의 route 해제 불가).
const ABANDON_SHELL_META = /[;|&`\n\r]|\$\(|<\(|>\(|[<>]/
const ABANDON_FLAGS = new Set(["--root", "--session", "--reason"])
export function isRouteAbandonCli(command, { trustedClis = new Set(), root = null, sessionId = null, trustedNode = null } = {}) {
  const cmd = String(command || "")
  if (ABANDON_SHELL_META.test(cmd)) return false
  if (root == null || sessionId == null) return false
  const toks = cmd.trim().split(/\s+/)
  const exe = toks[0] || ""
  if (exe !== "node" && !(trustedNode != null && resolve(exe) === trustedNode)) return false
  const script = toks[1] ? resolve(toks[1]) : ""
  if (!trustedClis.has(script) || !script.endsWith("execution.mjs")) return false
  if (toks[2] !== "route-abandon") return false
  const rest = toks.slice(3)
  const flagToks = rest.filter((t) => t.startsWith("--"))
  if (new Set(flagToks).size !== flagToks.length) return false // 중복 → 가드(first-value)와 CLI(last-wins) 불일치 우회 차단
  if (flagToks.some((f) => !ABANDON_FLAGS.has(f))) return false
  const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
  const r = val("--root")
  if (r === undefined || resolve(root, r) !== resolve(root)) return false
  return val("--session") === String(sessionId)
}

// ── CLI 핸들러 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      // 중복 플래그 거부 — 가드는 first-value로 보지만 last-wins면 우회(예: init 전 `--root A … --root B`로 다른 repo에 상태 생성).
      if (Object.prototype.hasOwnProperty.call(flags, key)) die(`중복 플래그 --${key} — 각 플래그는 1회만(모호)`)
      flags[key] = argv[++i]
    } else pos.push(a)
  }
  return { flags, pos }
}

// init --root --track --slug : 부트스트랩(레거시 CLI/테스트용, execution→active 순서 §3.5 정렬). **shared state lock으로 직렬화**(P1-5b:
// bootstrap과 같은 lock을 공유해 active.json 경합 방지). 프로덕션 진입 경로는 bootstrapRun(훅). FailClosed는 throw라
// withStateLock의 finally에서 lock 해제 후 CLI dispatch가 die로 처리(process.exit로 lock을 leak하지 않음).
function cmdInit({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  const dir = planDir(root, track, slug)
  const sentinel = sentinelPath(root)
  const execPath = join(dir, "execution.json")
  out(withStateLock(root, () => {
    if (existsSync(sentinel)) {
      const s = readJSONStrict(sentinel)
      if (s.track === track && s.slug === slug) {
        if (!existsSync(execPath)) throw new FailClosed("sentinel 존재하나 execution.json 부재 — crash/손상, fail-closed")
        const ex = readJSONStrict(execPath)
        if (ex.slug !== slug || ex.track !== track) throw new FailClosed("execution.json이 sentinel과 불일치 — fail-closed")
        return { ok: true, reused: true, phase: ex.phase }
      }
      throw new FailClosed(`다른 활성 단위 존재(active=${s.track}/${s.slug}) — 동시 활성 금지, fail-closed`)
    }
    writeJSONAtomic(execPath, { track, slug, planHash: null, phase: "planning", tasks: {} }) // execution 먼저
    writeJSONAtomic(sentinel, { track, slug, planHash: null, readOnlyThreads: [] })          // active 포인터 마지막(§3.5 정렬, P2-4)
    return { ok: true, reused: false, phase: "planning" }
  }))
}

// 현재 plan.md의 manifest 파생·planHash. 실패 시 {ok:false}(훅에서 best-effort 사용).
export function derivePlanHash(root, slug) {
  const dir = planDir(root, "plan", slug)
  const planPath = join(dir, "plan.md")
  if (!existsSync(planPath)) return { ok: false, reason: "plan.md 없음" }
  const planMd = readFileSync(planPath, "utf8")
  let block
  try { block = extractManifestBlock(planMd) } catch (e) { return { ok: false, reason: e.message } }
  const errs = validateManifest(block)
  if (errs.length) return { ok: false, reason: `manifest 검증 실패: ${errs.join("; ")}` }
  return { ok: true, planHash: computePlanHash(planMd, canonicalManifest(block)), block }
}

// 스킬 A5가 승인 질문 직전 호출 — 이 질문만 승인 후보가 되도록 arm. **기대 질문 텍스트·승인 옵션 값**을 고정해
// PreToolUse가 실제 질문/옵션과 정확히 대조하고, PostToolUse가 그 옵션 값과 정확히 일치하는 선택만 승인으로 본다.
export function armApproval(root, slug, { question = null, header = null, approveOption = "승인" } = {}) {
  if (question == null || question === "") return { ok: false, reason: "arm-approval에는 --question(정확한 승인 질문 텍스트)이 필수" }
  const d = derivePlanHash(root, slug)
  if (!d.ok) return { ok: false, reason: d.reason }
  const dir = planDir(root, "plan", slug)
  // h1 등록 게이트: 실제 시행 영수증 없는(또는 공허한) verification이 있으면 승인 질문 자체를 arm하지 않는다.
  const problems = trialGate(dir, d.block)
  if (problems.length) return { ok: false, reason: `verification 시행 영수증 미비 — 등록 불가: ${problems.join(" | ")}` }
  writeJSONAtomic(join(dir, ".arm-approval.json"), { planHash: d.planHash, question, header, approveOption, at: new Date().toISOString() })
  const execPath = join(dir, "execution.json")
  const ex = readJSONOrNull(execPath) || { track: "plan", slug, planHash: null, phase: "planning", tasks: {} }
  if (ex.phase === "planning") { ex.phase = "awaiting-approval"; writeJSONAtomic(execPath, ex) }
  return { ok: true, planHash: d.planHash }
}

// PreToolUse(AskUserQuestion)가 pending receipt 기록. **arm된 경우에만**(A5 승인 질문) — 그 외 질문은 no-op.
// arm은 **일회성**: 기록 즉시 소비. arm 이후 plan 변경(planHash)·**질문/옵션 불일치**면 기록 안 함(fail-closed).
// 실제 질문(actualQuestion)이 arm.question과 다르거나, arm.approveOption이 실제 옵션(actualOptions)에 없으면 거부.
export function recordPendingApproval(root, slug, toolUseId, actualQuestion = null, actualOptions = null) {
  const dir = planDir(root, "plan", slug)
  const armPath = join(dir, ".arm-approval.json")
  if (!existsSync(armPath)) return { ok: false, reason: "승인 미-arm(A5 승인 질문 아님)" }
  const arm = readJSONOrNull(armPath)
  const d = derivePlanHash(root, slug)
  const abort = (reason) => { rmSync(armPath, { force: true }); return { ok: false, reason } }
  if (!d.ok) return abort(d.reason)
  if (!arm || arm.planHash !== d.planHash) return abort("arm 이후 plan 변경(planHash 불일치)")
  // 질문/옵션 **정확 대조 필수**(비교 불가하면 fail-closed): arm.question 존재 ∧ 실제 질문 일치 ∧ 실제 옵션에 승인 옵션 존재.
  if (arm.question == null) return abort("arm에 질문 텍스트 없음")
  if (actualQuestion !== arm.question) return abort("승인 질문 텍스트 불일치(또는 실제 질문 누락)")
  if (!Array.isArray(actualOptions) || !actualOptions.includes(arm.approveOption)) return abort("승인 옵션이 실제 질문 옵션에 없음(또는 옵션 누락)")
  writeJSONAtomic(join(dir, ".pending-approval.json"), { toolUseId, planHash: d.planHash, question: arm.question, header: arm.header || null, approveOption: arm.approveOption || "승인" })
  rmSync(armPath, { force: true }) // 일회성 소비
  return { ok: true, planHash: d.planHash }
}

// PostToolUse(AskUserQuestion) 승인 바인딩(§4 DR-014). pending의 tool_use_id 일치 ∧ 실제 답이 승인
// ∧ 현재 planHash가 pending과 동일할 때만 manifest 확정·phase=executing. 그 외 awaiting-approval 유지.
// response = AskUserQuestion 원본 tool_response(문자열/객체). **pending 질문 키에 대응하는 선택값만** 추출해
// 정확히 pending.approveOption과 일치할 때만 승인(다른 질문의 "승인" 답 오연결·부분문자열 오판 차단).
export function bindApproval(root, slug, toolUseId, response) {
  const dir = planDir(root, "plan", slug)
  const pendingPath = join(dir, ".pending-approval.json")
  const pending = readJSONOrNull(pendingPath)
  if (!pending) return { ok: false, reason: "pending-approval 없음" }
  // tool_use_id가 다르면 이 질문의 답이 아니다 — pending 보존(다른 질문이 소비하지 않게).
  if (toolUseId !== pending.toolUseId) return { ok: false, reason: "tool_use_id 불일치 — 이 승인 질문의 답 아님", phase: "awaiting-approval" }
  // 일치하면 이 질문의 답 → pending 소비(거절이어도 stale 남기지 않음).
  rmSync(pendingPath, { force: true })
  const approveOption = pending.approveOption || "승인"
  const sel = answerForQuestion(response, pending.question, pending.header)
  const approved = sel.length > 0 && sel.every((v) => v === approveOption) // 그 질문의 선택값이 정확히 승인 옵션
  const d = derivePlanHash(root, slug)
  if (!d.ok) return { ok: false, reason: d.reason, phase: "awaiting-approval" }
  if (!approved) return { ok: false, reason: "승인 옵션 정확 일치 아님 — awaiting-approval 유지", phase: "awaiting-approval" }
  if (d.planHash !== pending.planHash) return { ok: false, reason: "질문 이후 plan 변경(planHash 불일치) — awaiting-approval 유지", phase: "awaiting-approval" }
  // h1 등록 게이트 재확인(arm 이후 trial receipt가 사라진 경우까지) — manifest 확정 직전 fail-closed.
  const problems = trialGate(dir, d.block)
  if (problems.length) return { ok: false, reason: `verification 시행 영수증 미비 — manifest 등록 거부: ${problems.join(" | ")}`, phase: "awaiting-approval" }

  const manifestPath = join(dir, "manifest.json")
  const manifest = { ...canonicalManifest(d.block), planHash: d.planHash }
  if (existsSync(manifestPath)) {
    const prev = readJSONStrict(manifestPath)
    if (prev.planHash !== d.planHash) throw new FailClosed("manifest.json이 이미 다른 planHash로 존재 — immutable 위반")
  } else {
    writeJSONAtomic(manifestPath, manifest)
  }
  const execPath = join(dir, "execution.json")
  const ex = readJSONOrNull(execPath) || { track: "plan", slug, tasks: {} }
  ex.planHash = d.planHash
  ex.phase = "executing"
  writeJSONAtomic(execPath, ex)
  withStateLock(root, () => { // P1-3b: active.json RMW를 lock으로 직렬화 + rollover 감지
    const s = readJSONStrict(sentinelPath(root))
    if (s.slug !== slug || s.track !== "plan") throw new FailClosed("승인 중 active run 변경됨(rollover) — 이 run은 더 이상 활성 아님, fail-closed")
    s.planHash = d.planHash
    writeJSONAtomic(sentinelPath(root), s)
  })
  rmSync(pendingPath, { force: true })
  rmSync(join(dir, ".arm-approval.json"), { force: true })
  return { ok: true, planHash: d.planHash, phase: "executing" }
}

// PostToolUse가 성공한 codex 관찰 후 threadId 등록.
export function registerBuilderThread(root, slug, taskId, threadId) {
  const execPath = join(planDir(root, "plan", slug), "execution.json")
  const ex = readJSONStrict(execPath)
  ex.tasks = ex.tasks || {}
  ex.tasks[taskId] = ex.tasks[taskId] || { runStatus: "building", builderThreadId: null }
  if (ex.tasks[taskId].builderThreadId && ex.tasks[taskId].builderThreadId !== threadId)
    throw new FailClosed(`task ${taskId} builderThreadId 이미 등록됨(${ex.tasks[taskId].builderThreadId})`)
  ex.tasks[taskId].builderThreadId = threadId
  writeJSONAtomic(execPath, ex)
  return { ok: true, taskId, threadId }
}
// 빌더 위임 직전 task를 building으로 표시(스킬 호출) — PreToolUse가 workspace-write codex 부트스트랩을 이걸로 게이트.
export function setTaskRunStatus(root, slug, taskId, runStatus) {
  const VALID = new Set(["pending", "building", "built"])
  if (!VALID.has(runStatus)) throw new FailClosed(`runStatus는 ${[...VALID].join("|")}`)
  const execPath = join(planDir(root, "plan", slug), "execution.json")
  const ex = readJSONStrict(execPath)
  ex.tasks = ex.tasks || {}
  ex.tasks[taskId] = ex.tasks[taskId] || { runStatus: "pending", builderThreadId: null }
  ex.tasks[taskId].runStatus = runStatus
  writeJSONAtomic(execPath, ex)
  return { ok: true, taskId, runStatus }
}
// runStatus=building ∧ builderThreadId==null인 task들(빌더 부트스트랩 대상).
export function buildingUnboundTasks(root, slug) {
  const ex = readJSONOrNull(join(planDir(root, "plan", slug), "execution.json"))
  if (!ex || !ex.tasks) return []
  return Object.entries(ex.tasks).filter(([, t]) => t && t.runStatus === "building" && !t.builderThreadId).map(([id]) => id)
}
// 성공한 workspace-write codex를 유일한 building-unbound task에 자동 귀속(부트스트랩). 모호(0 or 다수)면 no-op.
export function registerBuilderAuto(root, slug, threadId) {
  const cands = buildingUnboundTasks(root, slug)
  if (cands.length !== 1) return { ok: false, reason: `building-unbound task ${cands.length}개 — 자동 귀속 모호`, candidates: cands }
  return registerBuilderThread(root, slug, cands[0], threadId)
}
export function registerReadonlyThread(root, track, slug, threadId) {
  return withStateLock(root, () => { // P1-3b: active.json RMW를 lock으로 직렬화 + rollover 감지
    const s = readJSONStrict(sentinelPath(root))
    if (s.slug !== slug || s.track !== track) throw new FailClosed("thread 등록 중 active run 변경됨(rollover) — 무효, fail-closed")
    s.readOnlyThreads = s.readOnlyThreads || []
    if (!s.readOnlyThreads.includes(threadId)) s.readOnlyThreads.push(threadId)
    writeJSONAtomic(sentinelPath(root), s)
    return { ok: true, threadId, readOnlyThreads: s.readOnlyThreads }
  })
}

// arm-approval만 스킬-facing CLI(A5). pending-approval·approve·register-*는 **CLI로 노출하지 않는다** —
// 승인·threadId 등록은 오직 훅이 실제 툴 호출(AskUserQuestion/codex)을 관찰해 in-process(import)로 수행한다.
// (CLI로 두면 sanctioned Bash로 self-승인·thread 위조가 가능해져 DR-002/DR-014를 무력화한다.)
function cmdArmApproval({ flags }) {
  const r = armApproval(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), { question: flags.question || null, header: flags.header || null, approveOption: flags["approve-option"] || "승인" })
  if (!r.ok) die(r.reason)
  out(r)
}

// park --root --track --slug : 승인 前 run의 sentinel 포인터만 치움(작업물 보존). 승인 後면 die.
function cmdPark({ flags }) {
  out(parkRun(flags.root || die("--root 필요"), { track: flags.track || "plan", slug: flags.slug || die("--slug 필요") }))
}
// resume --root --track --slug [--session <sid>] : park해둔 run을 다시 활성화(소유 세션 갱신).
function cmdResume({ flags }) {
  out(resumeParkedRun(flags.root || die("--root 필요"), { track: flags.track || "plan", slug: flags.slug || die("--slug 필요"), sessionId: flags.session || null }))
}
// route-abandon --root --session <sid> [--reason <why>] : 라우팅 포기(사용자 결정) → state=failed.
function cmdRouteAbandon({ flags }) {
  out(abandonRoute(flags.root || die("--root 필요"), flags.session || die("--session 필요"), flags.reason || null))
}
// trial --root --track --slug : 현재 plan.md의 verification argv를 실제로 실행해 등록용 영수증 기록(A5 arm 前).
// 공허한 시행이 하나라도 있으면 ok:false(등록은 arm-approval에서 거부된다).
function cmdTrial({ flags }) {
  out(runTrials(flags.root || die("--root 필요"), flags.track || "plan", flags.slug || die("--slug 필요")))
}

// seal --root --track --slug : 빌더 호출 직전 authority 집합 canonical hash 기록(§2).
function cmdSeal({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  const dir = planDir(root, track, slug)
  const files = collectAuthorityFiles(root, track, slug)
  const hash = sealHashOf(files)
  writeJSONAtomic(join(dir, ".seal.json"), { sealHash: hash, files: files.map((f) => f.path), at: new Date().toISOString() })
  out({ ok: true, sealHash: hash })
}

// seal-verify --root --track --slug : 빌더 산출 후 delta 귀속 前 재해시 비교. mismatch=fail-closed(exit 3).
function cmdSealVerify({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  const dir = planDir(root, track, slug)
  const sealPath = join(dir, ".seal.json")
  if (!existsSync(sealPath)) die("seal 없음 — 먼저 seal 필요, fail-closed")
  const stored = readJSONStrict(sealPath)
  const hash = sealHashOf(collectAuthorityFiles(root, track, slug))
  if (hash !== stored.sealHash) {
    process.stderr.write(`harnie-exec: SEAL MISMATCH — 빌더가 권위 파일을 변경(그 라운드 무효)\n`)
    out({ ok: false, sealMismatch: true, stored: stored.sealHash, actual: hash })
    process.exit(3)
  }
  out({ ok: true, sealMismatch: false })
}

// verify --root --slug --task <id> : manifest.verification[] argv를 spawnSync(shell 없음)로 실행,
// reviewedPostSHA 기준 scopeHash와 함께 receipt 기록(§4 DR-011b). 검증 전후 scope 불변 확인.
// execFileSync 대신 spawnSync: **stdout/stderr를 캡처**해야 vacuous(공허한 통과)를 판정할 수 있다(h2, shell 없음은 동일).
const VERIFY_MAX_OUT = 16 * 1024 * 1024 // 기본 1MB로는 큰 테스트 스위트가 ENOBUFS → 오탐(실패로 기록)
// `node --test` 자식이 부모의 `NODE_TEST_CONTEXT`를 물려받으면 보고를 v8-serializer 채널로 보내 **stdout이 0바이트**가 된다(실측).
// verify는 자기 자식의 출력을 직접 관찰해야 vacuous를 판정할 수 있으므로 이 컨텍스트만 제거한다(그 외 env는 그대로 전달).
function verifyEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}
// trial 자식용 env: verifyEnv + **경로 환경을 sandbox 기준으로 재작성**. 상속된 `PWD`/`OLDPWD`/`INIT_CWD`
// (npm은 `INIT_CWD`·`npm_config_local_prefix`에 호출 repo를 넣는다)는 자식이 live repo를 가리키게 만드는
// 평범한 실수 경로이므로 sandbox 기준으로 바꾸거나 제거한다. TMPDIR도 sandbox 안으로 두어 임시 쓰기까지 가둔다.
function trialEnv(base, cwd) {
  const env = verifyEnv()
  env.PWD = cwd
  env.TMPDIR = join(base, "tmp")
  delete env.OLDPWD
  delete env.INIT_CWD
  delete env.npm_config_local_prefix
  return env
}
// verification 항목 1개 실행 → 결과 요약(공유: verify 런타임 검증 · trial 설계시점 시행). 출력 원문은 보관하지 않고
// 바이트 수·vacuous 신호만 남긴다(영수증 비대화 방지, 판정에 필요한 것은 신호).
// execRoot = 실행 기준 디렉터리. verify는 live repo, trial은 **격리 sandbox**(승인 前 쓰기 금지 불변식 유지).
// confine = trial 전용 write-confinement 래퍼({wrap, env}) — 주어지면 spawn 시점에 sandbox 밖 쓰기를 OS가 차단한다.
function runVerification(execRoot, v, confine = null) {
  const cwd = v.cwd && v.cwd !== "." ? join(execRoot, v.cwd) : execRoot
  const [exe, argv] = confine ? confine.wrap(v.executable, v.args, cwd) : [v.executable, v.args]
  const env = confine ? confine.env(cwd) : verifyEnv()
  const r = spawnSync(exe, argv, { cwd, timeout: v.timeout, encoding: "utf8", maxBuffer: VERIFY_MAX_OUT, env })
  const stdout = r.stdout == null ? "" : String(r.stdout)
  const stderr = r.stderr == null ? "" : String(r.stderr)
  // timeout(SIGTERM)=124, spawn 실패(ENOENT 등)=1 — 기존 execFileSync 매핑과 동일.
  const exitCode = typeof r.status === "number" ? r.status : (r.signal ? 124 : 1)
  const evidencePolicy = v.evidencePolicy || "output-required"
  const vac = detectVacuous({ executable: v.executable, args: v.args, exitCode, stdout, stderr, evidencePolicy })
  return {
    executable: v.executable, args: v.args, cwd: v.cwd == null ? "." : v.cwd, timeout: v.timeout, evidencePolicy, exitCode,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    vacuous: vac.vacuous, vacuousReasons: vac.reasons,
    ...(r.error ? { spawnError: String(r.error.message).slice(0, 200) } : {}),
  }
}

// ── 설계 시점 시행(trial) — h1의 기계적 강제 ─────────────────────────────
// 요구: "안 돌려본 명령이 manifest에 들어가는 것을 막는다". manifest 안의 자기진술 필드로는 강제되지 않으므로
// (임의 문자열을 쓰면 통과) **우리 CLI가 직접 실행해 기록한 receipt**만 인정한다. 등록(arm/bind) 시 항목마다 receipt를
// 요구하고, 시행 결과가 공허하면 등록 자체를 거부한다(공허한 검증은 B4에서 어차피 미완료 — 등록 시 잡는 게 낫다).
// receipt 경로의 basename을 `receipt.json`으로 둬 guards의 control 보호를 그대로 받는다(tool Write로 위조 불가).
export function trialKey(v) {
  return sha256(stableStringify([String(v.executable), (Array.isArray(v.args) ? v.args : []).map(String), v.cwd == null ? "." : String(v.cwd), v.timeout, v.evidencePolicy || "output-required"]))
}
function trialReceiptPath(dir, key) { return join(dir, "trials", key, "receipt.json") }
// **격리 실행 sandbox** — 승인 前 불변식(소스 쓰기 금지)이 h1의 조기 피드백보다 우선한다.
// trial은 manifest가 선언한 임의 executable을 돌리므로 live repo에서 실행하면 자식 프로세스가 훅을 우회해
// 승인 前에 소스를 쓸 수 있다(사용자 권한 프롬프트는 wrapper만 보여주므로 내부 argv의 부작용을 막지 못한다).
// 구성 3중:
//   ① 내용 격리 — 현재 working tree(추적 수정 + untracked, `.harnie/` 제외)를 tree 객체로 캡처해 **repo 밖**
//      임시 디렉터리에 git archive로 풀고 거기서 실행, 끝나면 통째로 삭제.
//   ② **OS write-confinement** — spawn 시점에 sandbox 밖 쓰기를 커널이 거부한다(cwd 변경만으로는 절대경로·PWD
//      기반 쓰기를 못 막는다). 경로 환경(PWD·OLDPWD·INIT_CWD·TMPDIR)도 sandbox 기준으로 재작성.
//   ③ **카나리아 증명** — 매 실행마다 "밖 쓰기가 실제로 차단되는지"를 먼저 확인하고, 확인되지 않으면 시행 자체를
//      중단한다(플랫폼별 격리 구현을 신뢰하지 않고 런타임에 증명). 격리를 제공할 수 없는 환경은 실행 前 fail-closed.
// 한계(문서화): gitignore된 산출물(node_modules·venv)과 `.git`은 sandbox에 없어 의존성이 필요한 검증은 sandbox에서
// 실패한다 — 실패는 등록을 막지 않으므로(공허만 막는다) 안전성 저하는 없고 조기 피드백만 약해진다.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
// macOS SBPL 프로파일. **허용 규칙을 최소화하는 것이 보증의 핵심**이다(경로 열거로 blind spot을 증명할 수는 없다):
// allow default → 모든 쓰기 deny → 쓰기는 **sandbox base subpath**와 **`/dev/null` 리터럴**만.
// `/dev/null`만 예외인 이유(실측): 자식을 `stdio:'ignore'`로 띄우는 흔한 패턴이 /dev/null을 쓰기로 열어서,
// 이것이 없으면 하위 프로세스를 쓰는 검증 명령이 전부 실패한다. /dev/null은 데이터 경로가 아니라 bit bucket이므로
// 손상 위험이 없다. 이전 시안의 `(subpath "/dev")`는 불필요했고(제거해도 node·node --test 정상) 과대 허용이었다.
export function sandboxProfile(base) {
  return ["(version 1)", "(allow default)", "(deny file-write*)",
    `(allow file-write* (subpath ${JSON.stringify(realpathSync(base))}) (literal "/dev/null"))`].join("\n")
}
// 플랫폼별 confinement. 반환 {kind, wrap(exe,args,cwd)->[exe,args]} 또는 null(미지원 → 호출자 fail-closed).
export function makeConfinement(base) {
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    const profile = sandboxProfile(base)
    return { kind: "sandbox-exec", profile, wrap: (exe, args) => [SANDBOX_EXEC, ["-p", profile, exe, ...args]] }
  }
  // **Linux(bwrap)는 이번 범위에서 의도적으로 제외** — 실행 검증 없이 "지원"으로 넣지 않는다(CR-008).
  // 이전 시안의 `--ro-bind / / --dev-bind /dev /dev`는 read-only root 위에 host `/dev`를 writable로 덮어
  // `/dev/shm`처럼 sandbox base 밖의 일반 사용자 쓰기 가능 경로를 열어 두었다. 재개 조건:
  //   ① 격리된 `--dev /dev` 사용(host /dev를 bind하지 않음) + 필요 시 namespace 내부 `/dev/shm`만 별도 tmpfs
  //   ② Linux 실기에서 회귀 테스트 통과(sandbox 밖 일반 경로 **및** `/dev/shm` 양쪽 쓰기 차단)
  return null
}
// ③ 카나리아: deny 규칙이 이 환경에서 **실제로 적용되는지**를 증명한다.
//   (a) sandbox 밖 쓰기가 차단되는지 — **오직 이 호출이 만든 전용 throwaway 디렉터리**에서만 시도한다.
//   (b) sandbox 안 쓰기는 되는지(과잉 차단이면 모든 시행이 무의미).
// 설계 원칙(CR-009): live repo·`$HOME` 등 **사용자 데이터가 있는 경로에는 절대 쓰지 않는다**. 예측 가능한 이름과
// "쓰였으면 지운다"는 사후 정리는 (i) 부분 격리에서 실제 파일이 잠시 생기고 (ii) 같은 이름의 기존 사용자 파일을
// truncate/삭제할 수 있어, 예방해야 할 불변식을 다시 사후 정리로 되돌린다. 그래서 대상은 전용 임시 디렉터리 + 난수 이름 +
// `flag:'wx'`(기존 파일 truncate 불가)이고, 정리는 **이 호출이 만든 디렉터리 통째로**만 한다.
// 프로파일의 blind spot은 실환경 경로를 열거해 증명할 수 없으므로 `sandboxProfile`의 허용 규칙 최소화로 방지한다.
export function assertConfinement({ work, wrap, env }) {
  const canaryRoot = mkdtempSync(join(tmpdir(), "harnie-canary-")) // 이 호출 소유 — 삭제해도 안전
  const attempt = (target) => {
    const code = `require('node:fs').writeFileSync(${JSON.stringify(target)},'x',{flag:'wx'})` // 기존 파일 절대 truncate 안 함
    const [e, a] = wrap(process.execPath, ["-e", code], work)
    const r = spawnSync(e, a, { cwd: work, encoding: "utf8", timeout: 30000, env })
    return { status: r.status, stderr: String(r.stderr || ""), exists: existsSync(target) }
  }
  try {
    const outside = join(canaryRoot, `canary-${randomBytes(12).toString("hex")}`)
    const out = attempt(outside)
    if (out.status === 0 || out.exists)
      throw new FailClosed("격리 카나리아 실패: sandbox 밖(전용 임시 경로) 쓰기가 차단되지 않았습니다 — 승인 前 쓰기 금지를 보장할 수 없어 trial을 중단합니다.")
    const inside = join(work, `.harnie-canary-${randomBytes(12).toString("hex")}`)
    const existedBefore = existsSync(inside)
    const ins = attempt(inside)
    if (ins.status !== 0 || !ins.exists)
      throw new FailClosed(`격리 카나리아 실패: sandbox 안 쓰기까지 차단됨(과잉 차단으로 모든 시행이 무의미) — ${ins.stderr.slice(0, 200)}`)
    if (!existedBefore && ins.exists) rmSync(inside, { force: true }) // 이 호출이 만든 것만 정리
  } finally {
    rmSync(canaryRoot, { recursive: true, force: true })
  }
}
function withTrialSandbox(root, treeSHA, fn) {
  const base = mkdtempSync(join(tmpdir(), "harnie-trial-"))
  const work = join(base, "work")
  const tar = join(base, "tree.tar")
  try {
    mkdirSync(work, { recursive: true })
    mkdirSync(join(base, "tmp"), { recursive: true }) // sandbox 내부 TMPDIR
    execFileSync("git", ["-C", root, "archive", "--format=tar", "-o", tar, treeSHA])
    execFileSync("tar", ["-x", "-f", tar, "-C", work]) // 빈 tree도 정상(추출 결과 없음)
    const c = makeConfinement(base)
    if (!c)
      throw new FailClosed(`이 플랫폼(${process.platform})에서는 검증된 write-confinement가 없어 trial을 실행하지 않습니다(승인 前 쓰기 금지 보장 불가). 현재 지원 = macOS(${SANDBOX_EXEC}). Linux(bwrap)는 격리 프로파일 수정과 실기 회귀 검증 후 지원 예정입니다.`)
    const confine = { kind: c.kind, wrap: c.wrap, env: (cwd) => trialEnv(base, cwd) }
    // 실행 前 격리 증명 — 전용 throwaway 경로에서만 확인한다(live repo·$HOME에는 쓰지 않는다, CR-009).
    assertConfinement({ work, wrap: c.wrap, env: trialEnv(base, work) })
    return fn(work, confine)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
// 사후 확인용 상태 지문. **captureTree는 `.harnie/`를 제외**하므로 그것만으로는 authority 훼손(sentinel slug 변조 등)을
// 탐지할 수 없다 → live tree 해시 + sentinel·execution.json·권위 파일(plan.md·manifest·ledger·state·receipt) 지문을 함께 본다.
function liveStateFingerprint(root, track, slug) {
  const dir = planDir(root, track, slug)
  const raw = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null)
  return sha256(stableStringify([
    captureTree(root),
    raw(sentinelPath(root)),
    raw(join(dir, "execution.json")),
    sealHashOf(collectAuthorityFiles(root, track, slug)),
  ]))
}
// 현재 plan.md manifest 블록의 모든 verification argv를 **격리 sandbox에서** 실제 실행해 trial receipt 기록.
export function runTrials(root, track, slug) {
  const dir = planDir(root, track, slug)
  const planPath = join(dir, "plan.md")
  if (!existsSync(planPath)) throw new FailClosed("plan.md 없음 — trial 대상 manifest 블록 필요")
  const block = extractManifestBlock(readFileSync(planPath, "utf8"))
  const errs = validateManifest(block)
  if (errs.length) throw new FailClosed(`manifest 검증 실패(trial 前 수정 필요): ${errs.join("; ")}`)
  const treeSHA = captureTree(root)
  const before = liveStateFingerprint(root, track, slug)
  const ran = withTrialSandbox(root, treeSHA, (work, confine) =>
    block.tasks.flatMap((t) => t.verification.map((v) => ({ taskId: t.id, key: trialKey(v), r: runVerification(work, v, confine) }))))
  // 예방(OS confinement)이 1차 보증이고, 이 비교는 그 위의 2차 확인이다. 어긋나면 영수증을 기록하지 않는다.
  if (liveStateFingerprint(root, track, slug) !== before)
    throw new FailClosed("trial 중 live 상태(소스 또는 authority)가 변경됨 — 격리가 예상대로 동작하지 않았습니다. 영수증을 기록하지 않았습니다. 변경 내용을 확인하고 사용자에게 보고하세요.")
  const trials = []
  for (const { taskId, key, r } of ran) {
    writeJSONAtomic(trialReceiptPath(dir, key), { key, taskId, isolated: true, ...r, at: new Date().toISOString() })
    trials.push({ taskId, key, exitCode: r.exitCode, vacuous: r.vacuous, vacuousReasons: r.vacuousReasons })
  }
  return { ok: trials.every((t) => !t.vacuous), isolated: true, trials }
}
// 등록 게이트: 블록의 모든 verification 항목에 **키 일치하는 trial receipt**가 있고 공허하지 않아야 한다. problems[] 반환.
export function trialGate(dir, block) {
  const problems = []
  for (const t of (block && Array.isArray(block.tasks) ? block.tasks : [])) {
    for (const v of (Array.isArray(t.verification) ? t.verification : [])) {
      const key = trialKey(v)
      const label = `${t.id}: ${v.executable} ${(Array.isArray(v.args) ? v.args : []).join(" ")}`
      let rec = null
      const p = trialReceiptPath(dir, key)
      if (existsSync(p)) { try { rec = readJSONStrict(p) } catch { rec = null } }
      // 격리 실행으로 기록된 영수증만 인정(isolated 플래그 없는 구버전/외부 기록은 무효 — 승인 前 쓰기 금지 보장의 일부).
      if (!rec || rec.key !== key || rec.isolated !== true) { problems.push(`${label} — 격리 실행 영수증 없음(먼저 \`execution.mjs trial\` 실행)`); continue }
      if (rec.vacuous === true) problems.push(`${label} — 시행이 공허함(${(rec.vacuousReasons || []).join("; ")})`)
    }
  }
  return problems
}

function cmdVerify({ flags }) {
  const root = flags.root || die("--root 필요")
  const slug = flags.slug || die("--slug 필요")
  const taskId = flags.task || die("--task 필요")
  const dir = planDir(root, "plan", slug)
  const manifest = readJSONStrict(join(dir, "manifest.json"))
  const task = manifest.tasks.find((t) => t.id === taskId)
  if (!task) die(`manifest에 task ${taskId} 없음`)
  const state = readJSONOrNull(join(dir, "review", task.reviewUnit, "state.json"))
  const reviewedPostSHA = state && state.reviewedPostSHA
  if (!reviewedPostSHA) die(`task ${taskId}: reviewedPostSHA 없음(리뷰 APPROVE 후 검증) — fail-closed`)
  const reviewedScopeHash = computeScopeHash(root, reviewedPostSHA, task.scope)

  // 검증 전 working-tree scope 해시(검증이 scope 소스를 변형하는지 탐지).
  const preScope = computeScopeHash(root, captureTree(root), task.scope)
  const results = task.verification.map((v) => runVerification(root, v))
  const postScope = computeScopeHash(root, captureTree(root), task.scope)
  if (preScope !== postScope) die(`task ${taskId}: 검증이 scope 소스를 변형함(scopeHash 불변 위반) — fail-closed`)

  const allPass = results.every((r) => r.exitCode === 0)
  // 공허한 통과는 exitCode 0이어도 미검증 — receipt에 신호를 남겨 완료 재도출이 blocker로 취급한다.
  const vacuousReasons = results.flatMap((r, i) => r.vacuousReasons.map((x) => `verification[${i}] ${r.executable} ${r.args.join(" ")}: ${x}`))
  const vacuous = vacuousReasons.length > 0
  const receipt = { taskId, results, exitCode: allPass ? 0 : (results.find((r) => r.exitCode !== 0)?.exitCode ?? 1), vacuous, vacuousReasons, scopeHash: reviewedScopeHash, planHash: manifest.planHash, at: new Date().toISOString() }
  writeJSONAtomic(join(dir, "review", task.reviewUnit, "receipt.json"), receipt)
  if (vacuous) process.stderr.write(`harnie-exec: VACUOUS VERIFICATION — exitCode 0이지만 검증 증거 없음: ${vacuousReasons.join(" | ")}\n`)
  out({ ok: allPass && !vacuous, receipt })
}

// completion --root --track --slug : manifest 순회로 완료 재도출(§4). Stop 가드가 사용.
function cmdCompletion({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  out(computeCompletion(root, track, slug))
}

// set-phase --root --track --slug --phase <p> : execution.json phase 전진(advisory 갱신).
function cmdSetTask({ flags }) {
  out(setTaskRunStatus(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), flags.task || die("--task 필요"), flags["run-status"] || die("--run-status 필요")))
}
function cmdSetPhase({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  const phase = flags.phase || die("--phase 필요")
  const VALID = new Set(["planning", "awaiting-approval", "final-wave", "closed"])
  // executing 전이는 set-phase로 절대 불가 — 승인 게이트(bindApproval)만 연다(승인 우회 차단).
  if (phase === "executing") die("phase=executing는 set-phase로 불가 — 실제 사용자 승인(AskUserQuestion)만 실행을 연다")
  if (!VALID.has(phase)) die(`phase는 ${[...VALID].join("|")}(executing 제외)`)
  const dir = planDir(root, track, slug)
  const manifestExists = existsSync(join(dir, "manifest.json"))
  // final-wave/closed는 승인 후(=manifest 존재) 단계. manifest 없으면 승인 없이 진입 시도 → fail-closed.
  if ((phase === "final-wave" || phase === "closed") && !manifestExists)
    die(`phase=${phase}는 승인(manifest.json) 후에만 — manifest 부재`)
  // 승인 후 planning/awaiting으로 역전이 금지(Stop 게이트 회피 방지 — 단조 전이).
  if ((phase === "planning" || phase === "awaiting-approval") && manifestExists)
    die(`phase=${phase} 역전이 금지 — 이미 승인됨(단조 전이)`)
  // final-wave/closed 전이는 **현재 승인 권위 재검증**을 선행 조건으로(승인 후 plan.md/manifest 변조 상태로 확정 금지).
  if (phase === "final-wave" || phase === "closed") {
    const sentinelPlanHash = (readJSONOrNull(sentinelPath(root)) || {}).planHash
    if (!authorityApproved(dir, sentinelPlanHash)) die(`phase=${phase}는 승인 권위 유효할 때만 — plan.md/manifest 변조 또는 planHash 불일치`)
  }
  // closed는 **완료 재도출이 complete일 때만**(미완료를 closed로 확정해 Stop 게이트를 우회하지 못하게).
  if (phase === "closed") {
    const comp = computeCompletion(root, track, slug)
    if (!comp.complete) die(`phase=closed는 완료 재도출 complete일 때만 — 남은 것: ${comp.blockers.slice(0, 6).join("; ")}`)
  }
  const execPath = join(dir, "execution.json")
  const ex = readJSONStrict(execPath)
  ex.phase = phase
  writeJSONAtomic(execPath, ex)
  out({ ok: true, phase })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , sub, ...rest] = process.argv
  const args = parseArgs(rest)
  try {
    switch (sub) {
      // 승인·threadId 등록(pending-approval/approve/register-*)은 CLI로 노출하지 않는다 — 훅이 in-process로만.
      case "init": cmdInit(args); break
      case "park": cmdPark(args); break
      case "resume": cmdResume(args); break
      case "route-abandon": cmdRouteAbandon(args); break
      case "trial": cmdTrial(args); break
      case "arm-approval": cmdArmApproval(args); break
      case "seal": cmdSeal(args); break
      case "seal-verify": cmdSealVerify(args); break
      case "verify": cmdVerify(args); break
      case "completion": cmdCompletion(args); break
      case "set-task": cmdSetTask(args); break
      case "set-phase": cmdSetPhase(args); break
      default: die(`알 수 없는 서브커맨드: ${sub ?? "(none)"}`)
    }
  } catch (e) {
    if (e instanceof FailClosed) die(e.message)
    throw e
  }
}
