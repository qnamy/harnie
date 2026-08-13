#!/usr/bin/env node
// Durable run state; completion is always re-derived from manifest, reviews, and receipts.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, openSync, closeSync, unlinkSync } from "node:fs"
import { dirname, join, isAbsolute, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { captureTree } from "./delta.mjs"
import { validateLedger, openBlockingCount } from "./ledger.mjs"
import { extractSelectedAnswers } from "../hooks/lib.mjs"

export class FailClosed extends Error {}

function die(msg) {
  process.stderr.write(`harnie-exec: ${msg}\n`)
  process.exit(2)
}

export function sha256(str) {
  return createHash("sha256").update(str).digest("hex")
}

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]"
  const keys = Object.keys(v).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}"
}

export function computePlanHash(planMd, manifestNoHash) {
  return sha256(planMd + "\u0000" + stableStringify(manifestNoHash))
}

const NAME_RE = /^[A-Za-z0-9._-]+$/

export function validateSlug(slug) {
  if (typeof slug !== "string" || !NAME_RE.test(slug) || slug === "." || slug === "..")
    throw new FailClosed(`slug 형식 오류(^[A-Za-z0-9._-]+$, . 및 .. 금지): ${JSON.stringify(slug)}`)
  return slug
}

export function slugify(args) {
  const norm = String(args == null ? "" : args).trim().replace(/\s+/g, " ")
  if (norm === "") return ""
  const prefix = norm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 6).join("-")
  const hash = sha256(norm).slice(0, 8)
  return prefix ? `${prefix}-${hash}` : hash
}

export function assertContainedRel(rel, what) {
  if (typeof rel !== "string" || rel === "") throw new FailClosed(`${what}: 경로 문자열 필요`)
  if (isAbsolute(rel)) throw new FailClosed(`${what}: 절대경로 금지(${rel})`)
  const norm = normalize(rel)
  if (norm === ".." || norm.startsWith(".." + sep) || norm.split(sep).includes(".."))
    throw new FailClosed(`${what}: 상위 traversal 금지(${rel})`)
  return rel
}

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
      if (v.evidencePolicy != null && v.evidencePolicy !== "output-required" && v.evidencePolicy !== "exit-code-only")
        errors.push(`tasks[${i}].verification[${j}].evidencePolicy는 "output-required"|"exit-code-only" (기본 output-required)`)
    }
  }
  for (const [i, t] of (Array.isArray(obj.tasks) ? obj.tasks : []).entries())
    if (Array.isArray(t?.deps)) for (const d of t.deps) if (!taskIds.has(d)) errors.push(`tasks[${i}].deps: 미지 task ${JSON.stringify(d)}`)
  const gateNames = []
  for (const [i, g] of (Array.isArray(obj.gates) ? obj.gates : []).entries()) {
    if (!g || typeof g !== "object") { errors.push(`gates[${i}]: 객체 아님`); continue }
    if (typeof g.name !== "string" || !g.name) errors.push(`gates[${i}].name 필요`)
    else gateNames.push(g.name)
    claimUnit(g.reviewUnit, `gates[${i}]`)
  }
  const REQUIRED_GATES = ["coverage", "quality", "runtime", "scope"]
  const gs = new Set(gateNames)
  const missing = REQUIRED_GATES.filter((n) => !gs.has(n))
  const extra = gateNames.filter((n) => !REQUIRED_GATES.includes(n))
  if (missing.length) errors.push(`Final Wave 게이트 누락: ${missing.join(", ")}(정확히 coverage·quality·runtime·scope 필요)`)
  if (extra.length) errors.push(`Final Wave에 규약 외 게이트: ${extra.join(", ")}`)
  if (gateNames.length !== new Set(gateNames).size) errors.push(`Final Wave 게이트 이름 중복`)
  return errors
}

export function canonicalManifest(obj) {
  return { tasks: obj.tasks, gates: obj.gates }
}

const SEARCH_BASENAMES = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"])
const COUNT_FLAG = /^(?:--count|--count-matches|-[A-Za-z]*c[A-Za-z]*)$/

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
  if (evidencePolicy !== "exit-code-only" && so.trim() === "" && se.trim() === "")
    reasons.push("출력 0바이트(stdout·stderr 모두 공백) — 무엇을 검증했는지 증거 없음(의도된 침묵이면 evidencePolicy:\"exit-code-only\" 명시)")
  if (base === "node" && argv.includes("--test")) {
    const pass = tapCounter(so, "pass")
    const tests = tapCounter(so, "tests")
    if (pass === 0) reasons.push(`node --test가 통과시킨 테스트 0건(tests=${tests == null ? "?" : tests}, pass=0) — 경로·glob·이름필터가 아무 테스트도 실행하지 않음`)
  }
  if (SEARCH_BASENAMES.has(base) || (base === "git" && argv[0] === "grep")) {
    const lines = so.split("\n").map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) reasons.push("검색 명령인데 매치 0건 — 확인한 것이 없음")
    else if (argv.some((a) => COUNT_FLAG.test(a)) && lines.every((l) => /(?:^|:)0$/.test(l)))
      reasons.push("검색 카운트가 전부 0 — 매치 0건")
  }
  return { vacuous: reasons.length > 0, reasons }
}

// Bind approval and verification evidence to the currently reviewed working tree.
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
      if (u.receipt.vacuous) blockers.push(`task ${t.id}: verification이 공허함(${(u.receipt.vacuousReasons || []).join("; ") || "실행 증거 없음"}) — 실제로 검증하는 명령으로 교체 후 재검증`)
      if (u.receipt.planHash !== snap.planHash) blockers.push(`task ${t.id}: receipt planHash 불일치`)
      if (u.expectedScopeHash == null) blockers.push(`task ${t.id}: 리뷰된 artifact(reviewedPostSHA) 없음 — scope 바인딩 불가`)
      else {
        if (u.receipt.scopeHash !== u.expectedScopeHash) blockers.push(`task ${t.id}: receipt scopeHash ≠ 리뷰 tree scope(검증이 리뷰 tree 밖에서 돎)`)
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
    if (!u.reviewedPostSHA) blockers.push(`gate ${g.name}: reviewedPostSHA 없음 — 전체 tree 바인딩 불가`)
    else if (snap.currentWholeTree != null && u.reviewedPostSHA !== snap.currentWholeTree)
      blockers.push(`gate ${g.name}: 게이트 리뷰 후 코드 변경됨(현재 tree ≠ 리뷰 tree) — Final Wave 재실행 필요`)
  }
  return { complete: blockers.length === 0, blockers }
}

export function sealHashOf(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256(stableStringify(sorted.map((f) => [f.path, sha256(f.content)])))
}

export function parseStatusFooter(lastMessage) {
  if (typeof lastMessage !== "string") return { present: false, status: null }
  const m = lastMessage.match(/HARNIE_STATUS:\s*(COMPLETE|INCOMPLETE)\b(.*)$/im)
  if (!m) return { present: false, status: null }
  return { present: true, status: m[1].toUpperCase(), detail: (m[2] || "").trim() }
}

function readJSONStrict(path) {
  const raw = readFileSync(path, "utf8")
  let obj
  try { obj = JSON.parse(raw) } catch (e) { throw new FailClosed(`${path} JSON 손상: ${e.message}`) }
  return obj
}

function readJSONOrNull(path) {
  return existsSync(path) ? readJSONStrict(path) : null
}

function writeJSONAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + ".tmp"
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n")
  renameSync(tmp, path)
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
}

function planDir(root, track, slug) {
  validateSlug(slug)
  if (track !== "plan" && track !== "quick") throw new FailClosed(`track는 plan|quick (${track})`)
  return join(root, ".harnie", track, slug)
}

function sentinelPath(root) { return join(root, ".harnie", "active.json") }

function computeScopeHash(root, treeSHA, scopePaths) {
  const lsTree = execFileSync("git", ["-C", root, "ls-tree", "-r", treeSHA, "--", ...scopePaths], { encoding: "utf8" })
  return sha256(lsTree)
}

function buildSnapshot(root, track, slug, manifest, planHash) {
  const dir = planDir(root, track, slug)
  const reviewRoot = join(dir, "review")
  const units = {}
  const unitNames = new Set([...manifest.tasks.map((t) => t.reviewUnit), ...manifest.gates.map((g) => g.reviewUnit)])
  const taskByUnit = new Map(manifest.tasks.map((t) => [t.reviewUnit, t]))
  const currentWholeTree = captureTree(root)
  for (const name of unitNames) {
    const uDir = join(reviewRoot, name)
    const ledger = readJSONOrNull(join(uDir, "ledger.json"))
    let openBlocking = null
    if (ledger !== null) {
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

// Recompute approval from plan.md instead of trusting advisory phase state.
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

export function loadContext(root) {
  const sentinel = sentinelPath(root)
  if (!existsSync(sentinel)) return { active: false }
  const s = readJSONStrict(sentinel)
  if (!s || typeof s !== "object" || !s.track || !s.slug) return { active: true, failClosed: true, reason: "active.json 손상" }
  const dir = planDir(root, s.track, s.slug)
  const execPath = join(dir, "execution.json")
  const fc = (reason) => ({ active: true, failClosed: true, reason, root, track: s.track, slug: s.slug, sessionIds: normalizeOwnerSessions(s), readOnlyThreads: s.readOnlyThreads || [], builderThreads: [] })
  if (!existsSync(execPath)) return fc("sentinel 존재하나 execution.json 부재(§3 crash/손상)")
  let ex
  try { ex = readJSONStrict(execPath) } catch (e) { return fc(e.message) }
  if (ex.slug !== s.slug || ex.track !== s.track) return fc("execution.json이 sentinel과 불일치")
  const builderThreads = Object.values(ex.tasks || {}).map((t) => t && t.builderThreadId).filter(Boolean)
  const approved = authorityApproved(dir, s.planHash)
  const approvalEvidence = existsSync(join(dir, "manifest.json")) || !!s.planHash
  const rawPhase = ex.phase
  const effectivePhase = approved ? rawPhase : (rawPhase === "executing" || rawPhase === "final-wave" ? "awaiting-approval" : rawPhase)
  return { active: true, root, track: s.track, slug: s.slug, sessionIds: normalizeOwnerSessions(s), phase: effectivePhase, rawPhase, approved, approvalEvidence, readOnlyThreads: s.readOnlyThreads || [], builderThreads }
}

export function computeCompletion(root, track, slug) {
  const dir = planDir(root, track, slug)
  const manifestPath = join(dir, "manifest.json")
  if (!existsSync(manifestPath)) return { complete: true, blockers: [], noManifest: true }
  const manifest = readJSONStrict(manifestPath)
  const snap = buildSnapshot(root, track, slug, manifest, manifest.planHash)
  return deriveCompletion(manifest, snap)
}

function lockPath(root) { return join(root, ".harnie", "state.lock") }

// O_EXCL serializes active-state updates; stale locks require explicit recovery.
function acquireLock(root) {
  const lp = lockPath(root)
  mkdirSync(dirname(lp), { recursive: true })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const fd = openSync(lp, "wx")
      closeSync(fd)
      return lp
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      if (attempt < 99) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  throw new FailClosed("harnie state.lock이 존재합니다 — 활성 harnie 상태 작업이 없음을 확인한 뒤 `rm .harnie/state.lock`으로 제거하세요(훅 내부 Bash로는 차단됩니다 — 사용자가 외부 터미널에서 직접 삭제해야 합니다).")
}

function releaseLock(lock) {
  if (!lock) return
  try { unlinkSync(lock) } catch { /* already absent */ }
}

export function withStateLock(root, fn) {
  const lock = acquireLock(root)
  try { return fn() } finally { releaseLock(lock) }
}

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

export function clearPendingRoute(root, sessionId) {
  if (!sessionId) return
  const f = routeFile(root, sessionId)
  rmSync(f, { force: true }) // ENOENT 무시, 권한/IO 오류는 throw
  if (existsSync(f)) throw new FailClosed(`pending-route 정리 실패(파일 잔존) — gate가 남을 수 있음: ${f}`)
}

export function getRouteState(root, sessionId) {
  if (!sessionId) return null
  const f = routeFile(root, sessionId)
  if (!existsSync(f)) return null
  const e = readJSONStrict(f)
  if (!e || typeof e !== "object" || Array.isArray(e) || e.state !== "pending") {
    throw new FailClosed(`pending-route 손상(알 수 없는 state) — 수동 확인 필요: ${f}`)
  }
  return e.state
}

export function hasPendingRoute(root, sessionId) { return getRouteState(root, sessionId) !== null }

function collisionFreeSlug(root, track, base) {
  validateSlug(base)
  let slug = base
  for (let n = 2; existsSync(planDir(root, track, slug)); n++) slug = `${base}-${n}`
  return slug
}

function genuinelyComplete(root, track, slug) {
  const dir = planDir(root, track, slug)
  const sentinelPlanHash = (readJSONOrNull(sentinelPath(root)) || {}).planHash
  if (!authorityApproved(dir, sentinelPlanHash)) return false
  const comp = computeCompletion(root, track, slug)
  return comp.complete === true && comp.noManifest !== true
}

function ownerSessionId(sessionId) { return typeof sessionId === "string" && sessionId !== "" ? sessionId : null }

// Owner membership only grows while a run is active.
export function normalizeOwnerSessions(s) {
  if (!s || typeof s !== "object") return []
  if (Array.isArray(s.sessionIds)) return s.sessionIds.filter((x) => typeof x === "string" && x !== "")
  const one = ownerSessionId(s.sessionId)
  return one ? [one] : []
}

function createRun(root, track, base, sessionId) {
  const slug = collisionFreeSlug(root, track, base)
  const owner = ownerSessionId(sessionId)
  writeJSONAtomic(join(planDir(root, track, slug), "execution.json"), { track, slug, planHash: null, phase: "planning", tasks: {} })
  writeJSONAtomic(sentinelPath(root), { track, slug, base, planHash: null, readOnlyThreads: [], sessionIds: owner ? [owner] : [] })
  return { slug, reused: false }
}

// Resume preserves earlier owners and adds the current identifiable session.
function resumeRun(root, s, sessionId) {
  const execPath = join(planDir(root, s.track, s.slug), "execution.json")
  if (!existsSync(execPath)) throw new FailClosed("sentinel 존재하나 execution.json 부재 — 손상, fail-closed")
  const ex = readJSONStrict(execPath) // JSON 손상이면 throw
  if (ex.track !== s.track || ex.slug !== s.slug) throw new FailClosed("execution.json이 sentinel과 불일치 — 손상, fail-closed")
  const owner = ownerSessionId(sessionId)
  const prev = normalizeOwnerSessions(s)
  const next = owner ? (prev.includes(owner) ? prev : [...prev, owner]) : prev
  if (stableStringify(next) !== stableStringify(prev) || s.sessionId !== undefined || !Array.isArray(s.sessionIds)) {
    s.sessionIds = next
    delete s.sessionId
    writeJSONAtomic(sentinelPath(root), s)
  }
  return { slug: s.slug, reused: true, resumed: true }
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
    else throw new FailClosed(`미완료 run ${s.track}/${s.slug}가 활성 상태입니다. 기존 run을 완료하거나, 별도 worktree checkout에서 이 스킬을 다시 실행해 새 run을 시작하세요.`)
    clearPendingRoute(root, sessionId) // 부트스트랩 성공 = 이 세션 라우팅 해소(§3.9, per-session 파일이라 lock-free)
    return result
  })
}

function parseArgs(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      flags[key] = argv[++i]
    } else pos.push(a)
  }
  return { flags, pos }
}

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

// The first observed AskUserQuestion after arming is the one-shot approval candidate.
export function armApproval(root, slug, { approveOption = "승인" } = {}) {
  const d = derivePlanHash(root, slug)
  if (!d.ok) return { ok: false, reason: d.reason }
  const dir = planDir(root, "plan", slug)
  writeJSONAtomic(join(dir, ".arm-approval.json"), { planHash: d.planHash, approveOption, at: new Date().toISOString() })
  const execPath = join(dir, "execution.json")
  const ex = readJSONOrNull(execPath) || { track: "plan", slug, planHash: null, phase: "planning", tasks: {} }
  if (ex.phase === "planning") { ex.phase = "awaiting-approval"; writeJSONAtomic(execPath, ex) }
  return { ok: true, planHash: d.planHash }
}

export function recordPendingApproval(root, slug, toolUseId) {
  const dir = planDir(root, "plan", slug)
  const armPath = join(dir, ".arm-approval.json")
  if (!existsSync(armPath)) return { ok: false, reason: "승인 미-arm(A5 승인 질문 아님)" }
  const arm = readJSONOrNull(armPath)
  const d = derivePlanHash(root, slug)
  const abort = (reason) => { rmSync(armPath, { force: true }); return { ok: false, reason } }
  if (!d.ok) return abort(d.reason)
  if (!arm || arm.planHash !== d.planHash) return abort("arm 이후 plan 변경(planHash 불일치)")
  writeJSONAtomic(join(dir, ".pending-approval.json"), { toolUseId, planHash: d.planHash, approveOption: arm.approveOption || "승인" })
  rmSync(armPath, { force: true }) // 일회성 소비
  return { ok: true, planHash: d.planHash }
}

export function bindApproval(root, slug, toolUseId, response) {
  const dir = planDir(root, "plan", slug)
  const pendingPath = join(dir, ".pending-approval.json")
  const pending = readJSONOrNull(pendingPath)
  if (!pending) return { ok: false, reason: "pending-approval 없음" }
  if (toolUseId !== pending.toolUseId) return { ok: false, reason: "tool_use_id 불일치 — 이 승인 질문의 답 아님", phase: "awaiting-approval" }
  rmSync(pendingPath, { force: true })
  const approveOption = pending.approveOption || "승인"
  const sel = extractSelectedAnswers(response)
  const approved = sel.length > 0 && sel.every((v) => v === approveOption)
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

export function buildingUnboundTasks(root, slug) {
  const ex = readJSONOrNull(join(planDir(root, "plan", slug), "execution.json"))
  if (!ex || !ex.tasks) return []
  return Object.entries(ex.tasks).filter(([, t]) => t && t.runStatus === "building" && !t.builderThreadId).map(([id]) => id)
}

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

function cmdArmApproval({ flags }) {
  const r = armApproval(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), { approveOption: flags["approve-option"] || "승인" })
  if (!r.ok) die(r.reason)
  out(r)
}

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

const VERIFY_MAX_OUT = 16 * 1024 * 1024 // 기본 1MB로는 큰 테스트 스위트가 ENOBUFS → 오탐(실패로 기록)

function verifyEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

// Capture enough output evidence to reject vacuous success.
function runVerification(execRoot, v) {
  const cwd = v.cwd && v.cwd !== "." ? join(execRoot, v.cwd) : execRoot
  const r = spawnSync(v.executable, v.args, { cwd, timeout: v.timeout, encoding: "utf8", maxBuffer: VERIFY_MAX_OUT, env: verifyEnv() })
  const stdout = r.stdout == null ? "" : String(r.stdout)
  const stderr = r.stderr == null ? "" : String(r.stderr)
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
  const preScope = computeScopeHash(root, captureTree(root), task.scope)
  const results = task.verification.map((v) => runVerification(root, v))
  const postScope = computeScopeHash(root, captureTree(root), task.scope)
  if (preScope !== postScope) die(`task ${taskId}: 검증이 scope 소스를 변형함(scopeHash 불변 위반) — fail-closed`)
  const allPass = results.every((r) => r.exitCode === 0)
  const vacuousReasons = results.flatMap((r, i) => r.vacuousReasons.map((x) => `verification[${i}] ${r.executable} ${r.args.join(" ")}: ${x}`))
  const vacuous = vacuousReasons.length > 0
  const receipt = { taskId, results, exitCode: allPass ? 0 : (results.find((r) => r.exitCode !== 0)?.exitCode ?? 1), vacuous, vacuousReasons, scopeHash: reviewedScopeHash, planHash: manifest.planHash, at: new Date().toISOString() }
  writeJSONAtomic(join(dir, "review", task.reviewUnit, "receipt.json"), receipt)
  if (vacuous) process.stderr.write(`harnie-exec: VACUOUS VERIFICATION — exitCode 0이지만 검증 증거 없음: ${vacuousReasons.join(" | ")}\n`)
  out({ ok: allPass && !vacuous, receipt })
}

function cmdCompletion({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  out(computeCompletion(root, track, slug))
}

function cmdSetTask({ flags }) {
  out(setTaskRunStatus(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), flags.task || die("--task 필요"), flags["run-status"] || die("--run-status 필요")))
}

function cmdSetPhase({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  const phase = flags.phase || die("--phase 필요")
  const VALID = new Set(["planning", "awaiting-approval", "final-wave", "closed"])
  if (phase === "executing") die("phase=executing는 set-phase로 불가 — 실제 사용자 승인(AskUserQuestion)만 실행을 연다")
  if (!VALID.has(phase)) die(`phase는 ${[...VALID].join("|")}(executing 제외)`)
  const dir = planDir(root, track, slug)
  const manifestExists = existsSync(join(dir, "manifest.json"))
  if ((phase === "final-wave" || phase === "closed") && !manifestExists)
    die(`phase=${phase}는 승인(manifest.json) 후에만 — manifest 부재`)
  if ((phase === "planning" || phase === "awaiting-approval") && manifestExists)
    die(`phase=${phase} 역전이 금지 — 이미 승인됨(단조 전이)`)
  if (phase === "final-wave" || phase === "closed") {
    const sentinelPlanHash = (readJSONOrNull(sentinelPath(root)) || {}).planHash
    if (!authorityApproved(dir, sentinelPlanHash)) die(`phase=${phase}는 승인 권위 유효할 때만 — plan.md/manifest 변조 또는 planHash 불일치`)
  }
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
