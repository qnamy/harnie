#!/usr/bin/env node
// harnie execution 상태 엔진 — plan 트랙의 durable 실행 상태 + 권위 재도출 + 강제 훅의 결정적 코어.
// 설계: docs/EXECUTION-STATE-DESIGN.md (rev.10). 위협모델 §0.1 — fallible·over-eager 오케스트레이터/빌더의
// **실수**를 막는다(적대적 완전봉쇄는 비목표). 권위 = planHash 고정 immutable manifest + review-state ledger
// + verification receipt. execution.json은 advisory navigation cache(신뢰하지 않음 — Stop 가드는 재도출).
//
// 순수 함수(IO 없음)는 export해 단위 테스트하고, IO는 CLI 핸들러에 둔다. loop.mjs와 동일한 얇은-래퍼 스타일.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, openSync, closeSync, unlinkSync } from "node:fs"
import { dirname, join, isAbsolute, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
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
    }
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

// ── 순수: 완료 재도출 (§4 — Stop 가드의 심장) ───────────────────────────
// snap.currentWholeTree = 현재 working tree SHA. snap.units[reviewUnit] = {
//   openBlocking:int|null(손상=null), machineState, receipt:{exitCode,planHash,scopeHash}|null,
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
      receipt: receipt && typeof receipt === "object" ? { exitCode: receipt.exitCode, planHash: receipt.planHash, scopeHash: receipt.scopeHash } : null,
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
  // sessionId = run의 소유 세션(hooks/lib.mjs isOwnerSession이 우선 사용). 미기록이면 null → 훅이 repo 전역 적용으로 폴백.
  const fc = (reason) => ({ active: true, failClosed: true, reason, root, track: s.track, slug: s.slug, sessionId: s.sessionId || null, readOnlyThreads: s.readOnlyThreads || [], builderThreads: [] })
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
  return { active: true, root, track: s.track, slug: s.slug, sessionId: s.sessionId || null, phase: effectivePhase, rawPhase, approved, approvalEvidence, readOnlyThreads: s.readOnlyThreads || [], builderThreads }
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
// run의 **소유 세션**(hooks/lib.mjs isOwnerSession의 권위). 빈 값·비문자열은 null로 정규화 —
// 소유자 미기록은 훅에서 "repo 전역 적용"(하위호환·보수적)으로 폴백하므로 fail-closed 방향이다.
function ownerSessionId(sessionId) { return typeof sessionId === "string" && sessionId !== "" ? sessionId : null }
// 새 run 생성: execution.json 먼저, active.json(포인터) 마지막 원자 전환(§3.5). old dir은 건드리지 않음(보존).
function createRun(root, track, base, sessionId) {
  const slug = collisionFreeSlug(root, track, base)
  writeJSONAtomic(join(planDir(root, track, slug), "execution.json"), { track, slug, planHash: null, phase: "planning", tasks: {} })
  writeJSONAtomic(sentinelPath(root), { track, slug, base, planHash: null, readOnlyThreads: [], sessionId: ownerSessionId(sessionId) })
  return { slug, reused: false }
}
// resume: execution.json **strict read + sentinel 일치 검증**(P2-5, cmdInit 수준). 존재 확인만으론 손상 통과.
// 소유권은 **재개하는 세션으로 갱신**한다. 생성 시 기록만 하고 여기서 갱신하지 않으면, 재개 세션이 비-owner로
// 판정돼 run 단위 강제(H1 phase·H2 완료·PostToolUse 관찰)가 통째로 꺼지는 fail-open이 된다 — 두 변경은 한 쌍이다.
function resumeRun(root, s, sessionId) {
  const execPath = join(planDir(root, s.track, s.slug), "execution.json")
  if (!existsSync(execPath)) throw new FailClosed("sentinel 존재하나 execution.json 부재 — 손상, fail-closed")
  const ex = readJSONStrict(execPath) // JSON 손상이면 throw
  if (ex.track !== s.track || ex.slug !== s.slug) throw new FailClosed("execution.json이 sentinel과 불일치 — 손상, fail-closed")
  const owner = ownerSessionId(sessionId)
  // 세션 식별자가 없으면 소유자를 **비운다**(전역 적용). 기존 소유자를 남기면 재개 세션이 비-owner가 되어 fail-open.
  if (s.sessionId !== owner) { s.sessionId = owner; writeJSONAtomic(sentinelPath(root), s) } // 호출자(bootstrapRun)의 state lock 하에서 RMW
  return { slug: s.slug, reused: true, resumed: true }
}
// 진입점 훅이 호출. base=slugify(작업인자). 결정표(§3.4)로 resume/new/block. **state lock으로 직렬화**(P1-3). 성공 시 이 세션의 pending-route 해소.
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
    else throw new FailClosed(`미완료 run ${s.track}/${s.slug}가 활성 상태입니다. 기존 run을 재개하여 완료해야 새 작업을 시작할 수 있습니다.`)
    clearPendingRoute(root, sessionId) // 부트스트랩 성공 = 이 세션 라우팅 해소(§3.9, per-session 파일이라 lock-free)
    return result
  })
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

// verify --root --slug --task <id> : manifest.verification[] argv를 execFile(shell 없음)로 실행,
// reviewedPostSHA 기준 scopeHash와 함께 receipt 기록(§4 DR-011b). 검증 전후 scope 불변 확인.
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
  const results = []
  for (const v of task.verification) {
    const cwd = v.cwd && v.cwd !== "." ? join(root, v.cwd) : root
    let exitCode = 0
    try {
      execFileSync(v.executable, v.args, { cwd, timeout: v.timeout, stdio: "ignore" })
    } catch (e) {
      exitCode = typeof e.status === "number" ? e.status : (e.signal ? 124 : 1)
    }
    results.push({ executable: v.executable, args: v.args, exitCode })
  }
  const postScope = computeScopeHash(root, captureTree(root), task.scope)
  if (preScope !== postScope) die(`task ${taskId}: 검증이 scope 소스를 변형함(scopeHash 불변 위반) — fail-closed`)

  const allPass = results.every((r) => r.exitCode === 0)
  const receipt = { taskId, results, exitCode: allPass ? 0 : (results.find((r) => r.exitCode !== 0)?.exitCode ?? 1), scopeHash: reviewedScopeHash, planHash: manifest.planHash, at: new Date().toISOString() }
  writeJSONAtomic(join(dir, "review", task.reviewUnit, "receipt.json"), receipt)
  out({ ok: allPass, receipt })
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
