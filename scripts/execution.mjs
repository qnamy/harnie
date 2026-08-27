#!/usr/bin/env node
// Durable run state; completion is always re-derived from manifest, reviews, and receipts.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, openSync, closeSync, unlinkSync, realpathSync } from "node:fs"
import { dirname, join, isAbsolute, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { captureTree } from "./delta.mjs"
import { createWorktree } from "./worktree.mjs"
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

// argv 엔트리(verification·setup·integrationVerification) 공통 검증. kind에 따라 evidencePolicy 허용이 갈린다.
// manifest 스키마의 repo 키 형식(워크스페이스 상대경로). 0.13에서 workspace 모드가 사라져 repo 키는
// validateRepoBinding이 항상 거부하지만, 스키마 오류와 계약 위반을 구분해 보고하려면 형식 검사는 남는다.
const REPO_KEY_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

function validateArgvEntry(v, where, errors, { allowEvidencePolicy = true, allowRepo = false } = {}) {
  if (!v || typeof v !== "object") { errors.push(`${where} 객체 아님`); return }
  if (typeof v.executable !== "string" || !v.executable) errors.push(`${where}.executable 필요`)
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === "string")) errors.push(`${where}.args 문자열 배열`)
  const cwd = v.cwd == null ? "." : v.cwd
  try { if (cwd !== ".") assertContainedRel(cwd, `${where}.cwd`) } catch (e) { errors.push(e.message) }
  if (!Number.isInteger(v.timeout) || v.timeout <= 0) errors.push(`${where}.timeout 양의 정수(ms) 필요`)
  // 단위 착오 가드: 초 단위로 적으면(예: 60) spawnSync에 60ms로 전달돼 전 항목 영구 실패한다. 1초 미만에 유의미한 검증은 없다.
  else if (v.timeout < 1000) errors.push(`${where}.timeout ${v.timeout}ms — 1000ms 미만 거부(밀리초 단위; 초로 적은 단위 착오 의심)`)
  if (allowEvidencePolicy) {
    if (v.evidencePolicy != null && v.evidencePolicy !== "output-required" && v.evidencePolicy !== "exit-code-only")
      errors.push(`${where}.evidencePolicy는 "output-required"|"exit-code-only" (기본 output-required)`)
  } else if (v.evidencePolicy != null) errors.push(`${where}: evidencePolicy 불가(웜업은 검증 증거가 아님)`)
  if (v.repo != null && !allowRepo) errors.push(`${where}.repo 불가(integrationVerification 전용)`)
  if (v.repo != null && (typeof v.repo !== "string" || !REPO_KEY_RE.test(v.repo))) errors.push(`${where}.repo 형식 오류(${JSON.stringify(v.repo)})`)
}

// mode(0.11 S/M/L): 미지정 = 레거시(0.10) 규칙(4게이트). "M"/"L"은 게이트 티어링·integrationVerification 필수를 적용한다.
export function validateManifest(obj, { mode = null } = {}) {
  const errors = []
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return ["manifest 최상위가 plain object 아님"]
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) errors.push("tasks는 비어있지 않은 배열")
  if (!Array.isArray(obj.gates)) errors.push("gates는 배열")
  // difficulty(선택): run 난이도 — 실행 워치독 예산 티어의 소스. A5에서 manifest와 함께 승인된다.
  if (obj.difficulty != null && !["easy", "medium", "hard", "very-hard"].includes(obj.difficulty))
    errors.push(`difficulty는 "easy"|"medium"|"hard"|"very-hard" (선택; got ${JSON.stringify(obj.difficulty)})`)
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
    if (t.repo != null && (typeof t.repo !== "string" || !REPO_KEY_RE.test(t.repo) || t.repo.split("/").some((seg) => seg === "." || seg === "..")))
      errors.push(`tasks[${i}].repo 형식 오류(워크스페이스 상대 repo 키, traversal 금지): ${JSON.stringify(t.repo)}`)
    claimUnit(t.reviewUnit, `tasks[${i}]`)
    if (!Array.isArray(t.scope) || t.scope.length === 0) errors.push(`tasks[${i}].scope 비어있지 않은 배열 필요`)
    else for (const s of t.scope) { try { assertContainedRel(s, `tasks[${i}].scope`) } catch (e) { errors.push(e.message) } }
    if (!Array.isArray(t.verification) || t.verification.length === 0) errors.push(`tasks[${i}].verification 비어있지 않은 배열 필요(런타임 증거 강제)`)
    else for (const [j, v] of t.verification.entries()) validateArgvEntry(v, `tasks[${i}].verification[${j}]`, errors)
    // setup(선택): verification 前 1회 실행하는 웜업 argv(의존성 설치·콜드-스타트 컴파일). 증거가 아니므로 evidencePolicy 불가.
    if (t.setup != null) {
      if (!Array.isArray(t.setup) || t.setup.length === 0) errors.push(`tasks[${i}].setup은 생략 또는 비어있지 않은 배열(웜업 argv)`)
      else for (const [j, s] of t.setup.entries()) validateArgvEntry(s, `tasks[${i}].setup[${j}]`, errors, { allowEvidencePolicy: false })
    }
  }
  // integrationVerification(0.11): 통합 후 전체 스위트 — run-level receipt의 원천. M·L 필수(mode 지정 시).
  if (obj.integrationVerification != null) {
    if (!Array.isArray(obj.integrationVerification) || obj.integrationVerification.length === 0)
      errors.push("integrationVerification은 생략 또는 비어있지 않은 배열")
    else for (const [j, v] of obj.integrationVerification.entries())
      validateArgvEntry(v, `integrationVerification[${j}]`, errors, { allowRepo: true })
  }
  if (mode === "M" && !(Array.isArray(obj.integrationVerification) && obj.integrationVerification.length > 0))
    errors.push(`mode ${mode}: integrationVerification 필수(통합 후 전체 스위트 — 최종 트리 성공 receipt의 원천)`)
  for (const [i, t] of (Array.isArray(obj.tasks) ? obj.tasks : []).entries())
    if (Array.isArray(t?.deps)) for (const d of t.deps) if (!taskIds.has(d)) errors.push(`tasks[${i}].deps: 미지 task ${JSON.stringify(d)}`)
  // repo 키는 all-or-none: 워크스페이스 run은 모든 task가 repo 바인딩 필수, 단일-repo run은 repo 키 금지.
  if (Array.isArray(obj.tasks) && obj.tasks.length) {
    const withRepo = obj.tasks.filter((t) => t && t.repo != null).length
    if (withRepo !== 0 && withRepo !== obj.tasks.length)
      errors.push(`tasks의 repo 키는 all-or-none — ${withRepo}/${obj.tasks.length}개만 지정됨(워크스페이스 run이면 전부, 아니면 전부 생략)`)
  }
  // task 간 scope disjoint 강제(같은 repo 안에서): 동일 경로 또는 디렉터리 부모/자식이면 병렬 격리와 delta 귀속이 깨진다.
  // 승인 후 manifest는 immutable이라 B1에서 발견하면 복구 경로가 없으므로, 여기(arm-approval 경유)에서 fail-closed로 걸어야 한다.
  if (Array.isArray(obj.tasks)) {
    const normScope = (p) => String(p).replace(/\/+$/, "")
    const scopeEntries = []
    for (const [i, t] of obj.tasks.entries())
      if (t && Array.isArray(t.scope)) for (const s of t.scope) if (typeof s === "string") scopeEntries.push({ i, repo: t.repo == null ? "" : t.repo, path: normScope(s) })
    for (let a = 0; a < scopeEntries.length; a++)
      for (let b = a + 1; b < scopeEntries.length; b++) {
        const A = scopeEntries[a], B = scopeEntries[b]
        if (A.i === B.i || A.repo !== B.repo) continue
        if (A.path === B.path || A.path.startsWith(B.path + "/") || B.path.startsWith(A.path + "/"))
          errors.push(`tasks[${A.i}]·tasks[${B.i}] scope 겹침(${A.path} ↔ ${B.path}) — task scope는 쌍마다 disjoint 필요(A4에서 분해 수정)`)
      }
  }
  const gateNames = []
  for (const [i, g] of (Array.isArray(obj.gates) ? obj.gates : []).entries()) {
    if (!g || typeof g !== "object") { errors.push(`gates[${i}]: 객체 아님`); continue }
    if (typeof g.name !== "string" || !g.name) errors.push(`gates[${i}].name 필요`)
    else gateNames.push(g.name)
    claimUnit(g.reviewUnit, `gates[${i}]`)
  }
  if (gateNames.length !== new Set(gateNames).size) errors.push(`게이트 이름 중복`)
  // 게이트 티어링(0.11): M = 없음. mode 미지정 = 레거시(0.10) 4게이트 규칙 유지.
  if (mode === "M") {
    if (gateNames.length !== 0) errors.push(`mode M: gates는 빈 배열(단일 태스크 — 게이트 없음, got ${JSON.stringify(gateNames)})`)
  } else {
    const REQUIRED_GATES = ["coverage", "quality", "runtime", "scope"]
    const gs = new Set(gateNames)
    const missing = REQUIRED_GATES.filter((n) => !gs.has(n))
    const extra = gateNames.filter((n) => !REQUIRED_GATES.includes(n))
    if (missing.length) errors.push(`Final Wave 게이트 누락: ${missing.join(", ")}(정확히 coverage·quality·runtime·scope 필요)`)
    if (extra.length) errors.push(`Final Wave에 규약 외 게이트: ${extra.join(", ")}`)
  }
  // "integration" reviewUnit은 통합 검증 receipt 디렉터리(review/integration/)로 예약(0.11) — 충돌 금지.
  if (mode != null && reviewUnits.has("integration")) errors.push(`reviewUnit "integration"은 예약어(통합 검증 receipt) — 다른 이름 사용`)
  return errors
}

export function canonicalManifest(obj) {
  // difficulty·integrationVerification은 있을 때만 포함 — 기존(필드 없는) manifest의 planHash를 바꾸지 않는다.
  return {
    tasks: obj.tasks, gates: obj.gates,
    ...(obj.difficulty != null ? { difficulty: obj.difficulty } : {}),
    ...(obj.integrationVerification != null ? { integrationVerification: obj.integrationVerification } : {}),
  }
}

// ── 0.11 mode(S/M) — 크기 판정의 권위 기록. 상향 전이만 허용된다. L은 0.13에서 삭제됐다. ─────────
const MODE_ORDER = { sizing: 0, S: 1, M: 2 }
// sentinel·execution 양쪽 mode를 검증해 읽는다(권위 소비자용 — CR-001). 레거시(0.10)는 양쪽 모두 부재일 때만
// null; 한쪽만 있으면 손상으로 fail-closed. 이 run이 활성 run인지(slug·track 일치)도 함께 검증한다.
export function readMode(root, track, slug) {
  const s = readJSONOrNull(sentinelPath(root))
  const ex = readJSONOrNull(join(planDir(root, track, slug), "execution.json"))
  const sMode = s && typeof s.mode === "string" ? s.mode : null
  const exMode = ex && typeof ex.mode === "string" ? ex.mode : null
  // 활성 run이 아닌 과거 run(sentinel이 다른 run을 가리킴)의 판독은 execution.json 기준(sentinel mode는 무관).
  const isActiveRun = s && s.track === track && s.slug === slug
  if (isActiveRun && sMode !== exMode)
    throw new FailClosed(`mode 불일치(sentinel=${sMode}, execution=${exMode}) — 상태 손상, fail-closed`)
  // 0.13: L 삭제. 디스크에 남은 미지 mode(업그레이드 전 L run 등)는 레거시 4게이트 경로로 흘러들어
  // 부당한 완료 판정을 받을 수 있으므로 여기서 fail-closed한다(설계 rev-1 §6 X2 / DR-002).
  if (exMode != null && !(exMode in MODE_ORDER))
    throw new FailClosed(`알 수 없는 mode(${exMode}) — 0.13에서 삭제된 모드일 수 있음(L). 이 run은 재개·완료할 수 없다`)
  return exMode
}
export function setMode(root, slug, mode) {
  if (!["S", "M"].includes(mode)) throw new FailClosed(`set-mode: --mode는 S|M (${mode})`)
  return withStateLock(root, () => {
    const s = readJSONStrict(sentinelPath(root))
    if (s.track !== "plan") throw new FailClosed("set-mode: plan track 전용")
    if (s.slug !== slug) throw new FailClosed(`set-mode: --slug(${slug})가 활성 run(${s.slug})과 불일치 — fail-closed`)
    const execPath = join(planDir(root, "plan", s.slug), "execution.json")
    const ex = readJSONStrict(execPath)
    const sMode = typeof s.mode === "string" ? s.mode : "sizing"
    const exMode = typeof ex.mode === "string" ? ex.mode : "sizing"
    if (sMode !== exMode) throw new FailClosed(`mode 불일치(sentinel=${sMode}, execution=${exMode}) — 상태 손상, fail-closed`)
    if (!(MODE_ORDER[mode] > MODE_ORDER[sMode]))
      throw new FailClosed(`set-mode: 상향 전이만 허용(${sMode} → ${mode} 불가; 하향·동급 재설정 금지)`)
    ex.mode = mode
    s.mode = mode
    if (mode === "S") {
      // S: manifest 없음 — 단일 암묵 태스크 t1이 빌더 threadId 귀속·워치독·seal의 태스크 매핑을 제공한다(DR-114).
      ex.tasks = ex.tasks || {}
      ex.tasks.t1 = ex.tasks.t1 || { runStatus: "building", builderThreadId: null, startedAt: new Date().toISOString(), codexCalls: 0 }
    }
    writeJSONAtomic(execPath, ex)
    writeJSONAtomic(sentinelPath(root), s)
    return { ok: true, mode, slug: s.slug }
  })
}

// ── 0.12 set-difficulty — 재판정 값 갱신(매니페스트 불변, planHash 안전) ──
// difficulty는 A5 승인 시 manifest.json에 함께 봉인되고 canonicalManifest()가 planHash 계산에 포함하므로,
// 승인 후 manifest.json의 difficulty를 직접 고치면 이미 승인된 TASK-DETAIL dr: 해시가 부당하게 무효화된다.
// 재판정(model-matrix.md §2의 두 체크포인트)은 그래서 execution.json의 별도 필드에만 기록한다. 상향/하향
// 판단은 오케스트레이터(MUST 규칙, skills/dev/SKILL.md)의 책임이며, 이 CLI는 enum 검증과 활성 run 식별
// 일치만 본다(승인 성격이 아니라 "다음 스테이지가 참조할 값 갱신"이므로 훅 강제를 새로 얹지 않는다).
const DIFFICULTY_VALUES = ["easy", "medium", "hard", "very-hard"]
export function setDifficulty(root, slug, difficulty) {
  if (!DIFFICULTY_VALUES.includes(difficulty))
    throw new FailClosed(`set-difficulty: --difficulty는 easy|medium|hard|very-hard (${difficulty})`)
  return withStateLock(root, () => {
    const readStrictOrFail = (path, label) => {
      try { return readJSONStrict(path) }
      catch (e) {
        if (e.code === "ENOENT") throw new FailClosed(`set-difficulty: ${label} 없음(활성 run 아님) — fail-closed`)
        throw new FailClosed(`set-difficulty: ${label} 손상 — ${e.message}`)
      }
    }
    const s = readStrictOrFail(sentinelPath(root), "sentinel")
    if (s.track !== "plan") throw new FailClosed("set-difficulty: plan track 전용")
    if (s.slug !== slug) throw new FailClosed(`set-difficulty: --slug(${slug})가 활성 run(${s.slug})과 불일치 — fail-closed`)
    const execPath = join(planDir(root, "plan", s.slug), "execution.json")
    const ex = readStrictOrFail(execPath, "execution.json")
    ex.difficulty = difficulty
    writeJSONAtomic(execPath, ex)
    return { ok: true, difficulty, slug: s.slug }
  })
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
    if (u.repoUnresolved) { blockers.push(`task ${t.id}: repo 바인딩 실패 — ${u.repoUnresolved}`); continue }
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

// task의 git root(scope 해시·verify·delta 기준) 해석. 실패 사유를 함께 반환해 완료 재도출 blocker에 쓴다.
// 0.13: workspace(멀티레포) 모드 삭제 — run은 항상 단일 repo이고 task.repo 키는 금지된다.
function resolveTaskGitRoot(root, task) {
  if (task.repo != null) return { gitRoot: null, reason: `task.repo(${task.repo})는 유효하지 않음 — 단일 repo run 전용` }
  return { gitRoot: root, reason: null }
}

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
    let expectedScopeHash = null, currentScopeHash = null, repoUnresolved = null
    if (task) {
      const { gitRoot, reason } = resolveTaskGitRoot(root, task)
      repoUnresolved = reason
      if (gitRoot && reviewedPostSHA) {
        try { expectedScopeHash = computeScopeHash(gitRoot, reviewedPostSHA, task.scope) } catch { expectedScopeHash = null }
      }
      if (gitRoot) {
        try { currentScopeHash = computeScopeHash(gitRoot, currentWholeTree, task.scope) } catch { currentScopeHash = null }
      }
    }
    units[name] = {
      repoUnresolved,
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
  let mode = null
  try { const ex = readJSONOrNull(join(dir, "execution.json")); mode = ex && typeof ex.mode === "string" && ex.mode !== "sizing" ? ex.mode : null } catch { mode = null }
  if (validateManifest(block, { mode }).length) return false
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
  // mode(0.11): sentinel과 execution 양쪽에 기록되며 불일치는 손상이다. 레거시 run(양쪽 모두 부재)은 mode=null.
  const sMode = typeof s.mode === "string" ? s.mode : null
  const exMode = typeof ex.mode === "string" ? ex.mode : null
  if (sMode !== exMode) return fc(`mode 불일치(sentinel=${sMode}, execution=${exMode})`)
  const mode = sMode
  const authority = typeof s.authority === "string" ? s.authority : "hook"
  const builderThreads = Object.values(ex.tasks || {}).map((t) => t && t.builderThreadId).filter(Boolean)
  const approved = authorityApproved(dir, s.planHash)
  const approvalEvidence = existsSync(join(dir, "manifest.json")) || !!s.planHash
  const rawPhase = ex.phase
  const effectivePhase = approved ? rawPhase : (rawPhase === "executing" || rawPhase === "final-wave" ? "awaiting-approval" : rawPhase)
  const buildingUnboundTaskIds = Object.entries(ex.tasks || {}).filter(([, t]) => t && t.runStatus === "building" && !t.builderThreadId).map(([id]) => id)
  const manifest = readJSONOrNull(join(dir, "manifest.json"))
  const taskRepoWorkroots = {}
  for (const task of manifest?.tasks || []) taskRepoWorkroots[task.id] = root
  // S mode: manifest 없이 암묵 t1이 유일 태스크 — 빌더 cwd·워치독 매핑을 run root로 합성한다(DR-114).
  if (mode === "S" && ex.tasks && ex.tasks.t1) taskRepoWorkroots.t1 = root
  return { active: true, root, track: s.track, slug: s.slug, mode, authority, sessionIds: normalizeOwnerSessions(s), phase: effectivePhase, rawPhase, approved, approvalEvidence, readOnlyThreads: s.readOnlyThreads || [], builderThreads, buildingUnboundTaskIds, pendingRunRootBootstrap: ex.pendingRunRootBootstrap || null, taskRepoWorkroots }
}

export function computeCompletion(root, track, slug) {
  const dir = planDir(root, track, slug)
  const mode = readMode(root, track, slug)
  if (mode === "S") {
    // S(0.11): 승인 게이트·manifest 없음 — canonical 단일 리뷰 유닛(review/code/)의 APPROVED와
    // reviewedPostSHA=현재 tree 바인딩이 완료 권위다(검증 증거는 리뷰 前 수행되어 리뷰 APPROVE가 보증).
    const blockers = []
    const state = readJSONOrNull(join(dir, "review", "code", "state.json"))
    if (!state || state.machineState !== "APPROVED") blockers.push(`S: review/code 미승인(machineState=${state ? state.machineState : "없음"})`)
    else if (!state.reviewedPostSHA) blockers.push("S: reviewedPostSHA 없음 — 리뷰 tree 바인딩 불가")
    else {
      let current = null
      try { current = captureTree(root) } catch { current = null }
      if (current == null) blockers.push("S: 현재 tree 캡처 실패")
      else if (current !== state.reviewedPostSHA) blockers.push("S: 코드가 리뷰 후 변경됨(현재 tree ≠ 리뷰 tree) — 재리뷰 필요")
    }
    return { complete: blockers.length === 0, blockers, mode: "S" }
  }
  const manifestPath = join(dir, "manifest.json")
  if (!existsSync(manifestPath)) return { complete: true, blockers: [], noManifest: true }
  const manifest = readJSONStrict(manifestPath)
  const snap = buildSnapshot(root, track, slug, manifest, manifest.planHash)
  const result = deriveCompletion(manifest, snap)
  // 통합 검증(0.11): 선언된 run은 최종 트리에 바인딩된 성공 receipt 정확히 1개가 완료 조건이다(NFR-2).
  if (Array.isArray(manifest.integrationVerification) && manifest.integrationVerification.length) {
    const r = readJSONOrNull(join(dir, "review", "integration", "receipt.json"))
    const expectedHash = sha256(stableStringify(manifest.integrationVerification))
    if (!r) result.blockers.push("통합 검증 receipt 없음 — verify --integration 실행 필요")
    else {
      if (r.exitCode !== 0) result.blockers.push(`통합 검증 실패(exitCode=${r.exitCode})`)
      if (r.vacuous) result.blockers.push(`통합 검증이 공허함(${(r.vacuousReasons || []).join("; ") || "실행 증거 없음"})`)
      if (r.planHash !== manifest.planHash) result.blockers.push("통합 receipt planHash 불일치(승인 개정 후 재실행 필요)")
      if (r.verificationHash !== expectedHash) result.blockers.push("통합 receipt가 승인된 integrationVerification 계약과 불일치")
      if (r.artifact !== snap.currentWholeTree) result.blockers.push("코드가 통합 검증 후 변경됨(현재 tree ≠ receipt tree) — verify --integration 재실행 필요")
    }
  }
  result.complete = result.blockers.length === 0
  return result
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

function collisionFreeSlug(root, track, base) {
  validateSlug(base)
  let slug = base
  for (let n = 2; existsSync(planDir(root, track, slug)); n++) slug = `${base}-${n}`
  return slug
}

function genuinelyComplete(root, track, slug) {
  const comp = computeCompletion(root, track, slug)
  if (comp.mode === "S") return comp.complete === true // S: 승인 권위 없음 — 리뷰 바인딩 완주가 완료
  const dir = planDir(root, track, slug)
  const sentinelPlanHash = (readJSONOrNull(sentinelPath(root)) || {}).planHash
  if (!authorityApproved(dir, sentinelPlanHash)) return false
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

function createRun(root, track, base, sessionId, { authority = null } = {}) {
  const slug = collisionFreeSlug(root, track, base)
  const owner = ownerSessionId(sessionId)
  writeJSONAtomic(join(planDir(root, track, slug), "execution.json"), { track, slug, planHash: null, phase: "planning", mode: "sizing", tasks: {} })
  const sentinel = { track, slug, base, planHash: null, mode: "sizing", readOnlyThreads: [], sessionIds: owner ? [owner] : [] }
  if (authority) sentinel.authority = authority // "cli" = dev-solo(훅 부재) — approve CLI는 이 run에서만 유효
  writeJSONAtomic(sentinelPath(root), sentinel)
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

export function bootstrapRun(root, { base, track = "plan", sessionId = null, authority = null } = {}) {
  if (track !== "plan") throw new FailClosed(`bootstrapRun: 현재 track=plan만 (${track})`) // quick 이연(§3.8)
  if (typeof base !== "string" || base === "") throw new FailClosed("bootstrap: 빈 작업 인자 — 진행 불가")
  validateSlug(base)
  return withStateLock(root, () => {
    const s = readJSONOrNull(sentinelPath(root))
    let result
    if (!s) result = createRun(root, track, base, sessionId, { authority })
    else if (!s.track || !s.slug) throw new FailClosed("active.json 손상 — track/slug 누락, fail-closed")
    else if (genuinelyComplete(root, s.track, s.slug)) result = createRun(root, track, base, sessionId, { authority }) // 완료 → 새 run(포인터 전환·old 보존)
    else if (s.track === track && (s.base || s.slug) === base) result = resumeRun(root, s, sessionId) // 같은 작업(구버전 sentinel은 slug=base) → resume
    else throw new FailClosed(`미완료 run ${s.track}/${s.slug}가 활성 상태입니다. 기존 run을 완료하거나, 별도 worktree checkout에서 이 스킬을 다시 실행해 새 run을 시작하세요.`)
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
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) flags[key] = true
      else { flags[key] = next; i++ }
    } else pos.push(a)
  }
  return { flags, pos }
}

function cmdInit({ flags }) {
  const root = flags.root || die("--root 필요")
  const slug = flags.slug || die("--slug 필요")
  if (flags.authority === "cli") { out(initCliAuthority(root, slug)); return } // dev-solo(훅 부재) — run worktree 생성 포함
  if (flags.authority != null) die(`--authority는 cli만(훅 run은 bootstrap 훅이 생성 — init 직접 호출 금지)`)
  const track = flags.track || "plan"
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
    writeJSONAtomic(execPath, { track, slug, planHash: null, phase: "planning", mode: "sizing", tasks: {} }) // execution 먼저
    writeJSONAtomic(sentinel, { track, slug, planHash: null, mode: "sizing", readOnlyThreads: [] })          // active 포인터 마지막(§3.5 정렬, P2-4)
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
  const exMode = readMode(root, "plan", slug)
  const mode = exMode && exMode !== "sizing" ? exMode : null
  if (mode === "S") return { ok: false, reason: "S mode는 manifest·승인 게이트가 없음 — 승인이 필요하면 set-mode로 M/L 승격" }
  const errs = validateManifest(block, { mode })
  if (errs.length) return { ok: false, reason: `manifest 검증 실패: ${errs.join("; ")}` }
  return { ok: true, planHash: computePlanHash(planMd, canonicalManifest(block)), block }
}

// manifest의 task.repo·integrationVerification[].repo 바인딩이 이 run의 등록 repo와 정합한지 —
// 승인 시점에 fail-closed로 확인한다(verify 시점 지연 실패 방지, CR-005).
export function validateRepoBinding(root, block) {
  const withRepo = block.tasks.filter((t) => t.repo != null)
  const iv = Array.isArray(block.integrationVerification) ? block.integrationVerification : []
  if (withRepo.length) return `task.repo는 유효하지 않음 — run은 단일 repo 전용(${withRepo.length}개 지정)`
  const ivRepo = iv.filter((v) => v.repo != null).length
  return ivRepo ? `integrationVerification[].repo는 유효하지 않음 — run은 단일 repo 전용(${ivRepo}개 지정)` : null
}

// 원샷 arm 상호배제(0.11 DR-108·CR-004): A5 승인·rebind의 arm/pending은 run 전체에서 **타입 무관하게
// 동시에 하나만** 존재한다 — 하나의 AskUserQuestion 응답이 복수 권위 전이를 소비하거나 payload가 덮이는 것을
// 막는다. 재-arm이 필요하면 먼저 기존 arm을 소비시켜라(다음 질문이 stale arm을 소비·정리한다).
const ONE_SHOT_ARM_FILES = [
  ".arm-approval.json", ".pending-approval.json",
  ".arm-rebind.json", ".pending-rebind.json",
]
function otherArmPending(dir) {
  return ONE_SHOT_ARM_FILES.find((f) => existsSync(join(dir, f))) || null
}

// The first observed AskUserQuestion after arming is the one-shot approval candidate.
export function armApproval(root, slug, { approveOption = "승인" } = {}) {
  const d = derivePlanHash(root, slug)
  if (!d.ok) return { ok: false, reason: d.reason }
  const rb = validateRepoBinding(root, d.block)
  if (rb) return { ok: false, reason: rb }
  const dir = planDir(root, "plan", slug)
  return withStateLock(root, () => {
    const other = otherArmPending(dir)
    if (other) return { ok: false, reason: `원샷 승인 대기 중(${other}) — run 전체 단일 arm/pending(타입 무관 상호배제). 기존 것을 먼저 소비(질문)하거나 정리 후 재-arm` }
    writeJSONAtomic(join(dir, ".arm-approval.json"), { planHash: d.planHash, approveOption, at: new Date().toISOString() })
    const execPath = join(dir, "execution.json")
    const ex = readJSONOrNull(execPath) || { track: "plan", slug, planHash: null, phase: "planning", tasks: {} }
    if (ex.phase === "planning") { ex.phase = "awaiting-approval"; writeJSONAtomic(execPath, ex) }
    return { ok: true, planHash: d.planHash }
  })
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
  const rb = validateRepoBinding(root, d.block)
  if (rb) return { ok: false, reason: `repo 바인딩 불일치 — ${rb}`, phase: "awaiting-approval" }
  return withStateLock(root, () => {
    const manifestPath = join(dir, "manifest.json")
    const manifest = { ...canonicalManifest(d.block), planHash: d.planHash }
    if (existsSync(manifestPath)) {
      const prev = readJSONStrict(manifestPath)
      if (prev.planHash !== d.planHash) {
      // manifest 개정 — 실제 사용자 재승인을 통과한 뒤에만 도달한다(approve 선택 + 새 planHash 일치).
      // 이전 정본은 감사용으로 manifest.v<n>.json에 아카이브하고 교체한다. 이 분기 밖에서 manifest를
      // 바꾸는 경로는 없다: 직접 쓰기는 훅이, set-phase 역전이는 CLI가 여전히 차단한다.
      // 기존 receipt는 옛 planHash로 남아 completion이 재검증을 강제한다(verify 재실행 필요, 리뷰 ledger는 유지).
        let n = 1
        while (existsSync(join(dir, `manifest.v${n}.json`))) n++
        writeJSONAtomic(join(dir, `manifest.v${n}.json`), { ...prev, supersededAt: new Date().toISOString(), supersededBy: d.planHash })
        writeJSONAtomic(manifestPath, manifest)
      }
    } else {
      writeJSONAtomic(manifestPath, manifest)
    }
    const execPath = join(dir, "execution.json")
    const ex = readJSONOrNull(execPath) || { track: "plan", slug, tasks: {} }
    ex.planHash = d.planHash
    ex.phase = "executing"
    writeJSONAtomic(execPath, ex)
    const s = readJSONStrict(sentinelPath(root))
    if (s.slug !== slug || s.track !== "plan") throw new FailClosed("승인 중 active run 변경됨(rollover) — 이 run은 더 이상 활성 아님, fail-closed")
    s.planHash = d.planHash
    writeJSONAtomic(sentinelPath(root), s)
    rmSync(pendingPath, { force: true })
    rmSync(join(dir, ".arm-approval.json"), { force: true })
    return { ok: true, planHash: d.planHash, phase: "executing" }
  })
}

function registerBuilderThreadLocked(root, slug, taskId, threadId, { clearBootstrap = false } = {}) {
  const execPath = join(planDir(root, "plan", slug), "execution.json")
  const ex = readJSONStrict(execPath)
  ex.tasks = ex.tasks || {}
  ex.tasks[taskId] = ex.tasks[taskId] || { runStatus: "building", builderThreadId: null }
  if (!ex.tasks[taskId].startedAt) ex.tasks[taskId].startedAt = new Date().toISOString()
  if (!Number.isInteger(ex.tasks[taskId].codexCalls) || ex.tasks[taskId].codexCalls < 0) ex.tasks[taskId].codexCalls = 0
  if (ex.tasks[taskId].builderThreadId && ex.tasks[taskId].builderThreadId !== threadId)
    throw new FailClosed(`task ${taskId} builderThreadId 이미 등록됨(${ex.tasks[taskId].builderThreadId})`)
  ex.tasks[taskId].builderThreadId = threadId
  // 워치독 시간 기산점(0.11): 태스크의 **첫** 바인딩 성공 시각. 이후 재스폰·rebind에도 불변 — 리셋은 예산 우회 경로(DR-107).
  // 레거시(builderBoundAt 없이 이미 rebind 이력이 있는 0.10 task)는 startedAt을 anchor로 보존한다 —
  // rebind로 지금 시각을 새 anchor로 삼으면 no-reset 계약이 우회된다(CR-006).
  if (!ex.tasks[taskId].builderBoundAt) {
    const priorRebind = Array.isArray(ex.threadRebindings) && ex.threadRebindings.some((r) => r && r.taskId === taskId && r.action === "rebind")
    ex.tasks[taskId].builderBoundAt = priorRebind && ex.tasks[taskId].startedAt ? ex.tasks[taskId].startedAt : new Date().toISOString()
  }
  if (clearBootstrap) delete ex.pendingRunRootBootstrap
  writeJSONAtomic(execPath, ex)
  return { ok: true, taskId, threadId }
}

export function registerBuilderThread(root, slug, taskId, threadId) {
  return withStateLock(root, () => registerBuilderThreadLocked(root, slug, taskId, threadId))
}

export function setTaskRunStatus(root, slug, taskId, runStatus) {
  const VALID = new Set(["pending", "building", "built"])
  if (!VALID.has(runStatus)) throw new FailClosed(`runStatus는 ${[...VALID].join("|")}`)
  return withStateLock(root, () => {
    const execPath = join(planDir(root, "plan", slug), "execution.json")
    const ex = readJSONStrict(execPath)
    ex.tasks = ex.tasks || {}
    ex.tasks[taskId] = ex.tasks[taskId] || { runStatus: "pending", builderThreadId: null }
    const firstBuild = ex.tasks[taskId].runStatus === "pending" && runStatus === "building"
    ex.tasks[taskId].runStatus = runStatus
    if (firstBuild) {
      ex.tasks[taskId].startedAt = new Date().toISOString()
      ex.tasks[taskId].codexCalls = 0
    }
    writeJSONAtomic(execPath, ex)
    return { ok: true, taskId, runStatus }
  })
}

export function buildingUnboundTasks(root, slug) {
  const ex = readJSONOrNull(join(planDir(root, "plan", slug), "execution.json"))
  if (!ex || !ex.tasks) return []
  return Object.entries(ex.tasks).filter(([, t]) => t && t.runStatus === "building" && !t.builderThreadId).map(([id]) => id)
}

function taskWorkroot(root, task) {
  return task.repo == null ? root : null
}

function gitRootOf(cwd) {
  try { return realpathOf(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()) }
  catch { return null }
}

export function registerBuilderAuto(root, slug, threadId, cwd = null) {
  return withStateLock(root, () => {
    const dir = planDir(root, "plan", slug)
    const execPath = join(dir, "execution.json")
    const ex = readJSONOrNull(execPath)
    if (!ex || ex.track !== "plan") return { ok: false, reason: "plan 실행 상태 없음 — 자동 귀속 대상 아님" }
    const cands = Object.entries(ex.tasks || {}).filter(([, t]) => t && t.runStatus === "building" && !t.builderThreadId).map(([id]) => id)
    const manifest = readJSONOrNull(join(dir, "manifest.json")) || { tasks: [] }
    if (!existsSync(sentinelPath(root))) return { ok: false, reason: "활성 run sentinel 없음 — 자동 귀속 대상 아님" }
    // S mode(0.11, DR-114): manifest 없음 — run root cwd의 workspace-write 호출만 암묵 t1에 귀속(fail-closed cwd 검증).
    if (ex.mode === "S") {
      if (!cands.includes("t1")) return { ok: false, reason: "S mode: t1이 building-unbound 아님", candidates: cands }
      if (typeof cwd !== "string" || !existsSync(cwd) || gitRootOf(cwd) !== realpathOf(root))
        return { ok: false, reason: `S mode: 빌더 cwd의 git root가 run root와 불일치(got ${JSON.stringify(cwd)}, expect ${root})` }
      return registerBuilderThreadLocked(root, slug, "t1", threadId)
    }
    const directRoot = typeof cwd === "string" && existsSync(cwd) && existsSync(root) && realpathOf(root) === realpathOf(cwd)
    if (directRoot) {
      const taskId = ex.pendingRunRootBootstrap
      if (taskId) {
        const task = manifest.tasks.find((t) => t.id === taskId)
        const expectedRoot = task && taskWorkroot(root, task)
        if (!task || !expectedRoot || gitRootOf(cwd) !== realpathOf(expectedRoot))
          return { ok: false, reason: `pendingRunRootBootstrap task ${taskId}의 repo workroot와 cwd git root 불일치` }
        if (!cands.includes(taskId)) return { ok: false, reason: `marker task ${taskId}가 building-unbound 아님`, candidates: cands }
        return registerBuilderThreadLocked(root, slug, taskId, threadId, { clearBootstrap: true })
      }
      const serialTaskId = cands.length === 1 ? cands[0] : null
      const serialTask = manifest.tasks.find((t) => t.id === serialTaskId)
      const serialRoot = serialTask && taskWorkroot(root, serialTask)
      if (!serialTask || !serialRoot || gitRootOf(cwd) !== realpathOf(serialRoot))
        return { ok: false, reason: "run-root 부트스트랩 marker 필요 — marker 없는 serial 예외는 단일 building-unbound일 때만", candidates: cands }
      return registerBuilderThreadLocked(root, slug, serialTaskId, threadId)
    }
    if (cwd != null) return { ok: false, reason: `codex cwd가 활성 run root와 불일치: ${cwd}`, candidates: cands }
    if (cands.length !== 1) return { ok: false, reason: `building-unbound task ${cands.length}개 — 자동 귀속 모호`, candidates: cands }
    return registerBuilderThreadLocked(root, slug, cands[0], threadId)
  })
}

// 빌더 호출 수는 워치독 표시용이다. 권위 상태가 아니므로 조회 실패는 호출자에서 fail-open으로 다룬다.
export function recordBuilderCall(root, slug, threadId) {
  return withStateLock(root, () => {
    const execPath = join(planDir(root, "plan", slug), "execution.json")
    const ex = readJSONStrict(execPath)
    const found = Object.entries(ex.tasks || {}).find(([, task]) => task && task.builderThreadId === threadId)
    if (!found) return { ok: false }
    const [taskId, task] = found
    task.codexCalls = Number.isInteger(task.codexCalls) && task.codexCalls >= 0 ? task.codexCalls + 1 : 1
    if (!task.startedAt) task.startedAt = new Date().toISOString()
    writeJSONAtomic(execPath, ex)
    const difficulty = resolveTaskDifficulty(root, slug)
    return { ok: true, taskId, codexCalls: task.codexCalls, startedAt: task.startedAt, builderBoundAt: task.builderBoundAt || null, extensions: Array.isArray(task.watchdogExtensions) ? task.watchdogExtensions.length : 0, ...(difficulty ? { difficulty } : {}) }
  })
}

// execution.json.difficulty(재판정) 우선, 없으면 A5 승인 시 manifest.json에 봉인된 값으로 폴백.
function resolveTaskDifficulty(root, slug) {
  const ex = readJSONOrNull(join(planDir(root, "plan", slug), "execution.json"))
  if (ex && typeof ex.difficulty === "string") return ex.difficulty
  const manifest = readJSONOrNull(join(planDir(root, "plan", slug), "manifest.json"))
  return manifest && typeof manifest.difficulty === "string" ? manifest.difficulty : undefined
}

export function taskWatchdogUsage(root, slug, { threadId = null, taskId = null } = {}) {
  try {
    const ex = readJSONOrNull(join(planDir(root, "plan", slug), "execution.json"))
    if (!ex || !ex.tasks) return null
    const found = threadId != null
      ? Object.entries(ex.tasks).find(([, task]) => task && task.builderThreadId === threadId)
      : taskId != null && ex.tasks[taskId] ? [taskId, ex.tasks[taskId]] : null
    if (!found) return null
    const [id, task] = found
    const difficulty = resolveTaskDifficulty(root, slug)
    return { taskId: id, codexCalls: task.codexCalls, startedAt: task.startedAt, builderBoundAt: task.builderBoundAt || null, extensions: Array.isArray(task.watchdogExtensions) ? task.watchdogExtensions.length : 0, ...(difficulty ? { difficulty } : {}) }
  } catch { return null } // advisory 읽기 실패는 훅 차단 근거가 아니다.
}

export function watchdogExtend(root, slug, taskId, reason) {
  if (typeof reason !== "string" || reason.trim() === "") throw new FailClosed("watchdog-extend: --reason 필요")
  return withStateLock(root, () => {
    const execPath = join(planDir(root, "plan", slug), "execution.json")
    const ex = readJSONStrict(execPath)
    const task = ex.tasks && ex.tasks[taskId]
    if (!task) throw new FailClosed(`watchdog-extend: task ${taskId} 없음`)
    const normalized = reason.trim()
    task.watchdogExtensions = Array.isArray(task.watchdogExtensions) ? task.watchdogExtensions : []
    if (normalized === "auto-cap" && task.watchdogExtensions.length > 0)
      throw new FailClosed(`watchdog-extend: task ${taskId} auto-cap은 기존 연장 전 1회만 허용(총 예산 최대 2×)`)
    const at = new Date().toISOString()
    // 0.11: 카운터·기산점 리셋 없음 — 연장은 effective 예산 확대(base×(1+extensions))로만 반영된다(DR-107).
    task.watchdogExtensions.push({ at, reason: normalized })
    writeJSONAtomic(execPath, ex)
    return { ok: true, taskId, extensions: task.watchdogExtensions.length }
  })
}

export function rebindTask(root, slug, { taskId, reason, cancel = false }) {
  // finding:<reviewUnit>:CR-NNN = 통합 후 순수 코드 결함(그 finding을 낸 유닛 ledger에 귀속 — 유닛 식별자가
  // 있어야 CR ID 중복이 모호하지 않다) / verification:integration = ledger 없는 통합 검증 실패(0.11 CR-209·219).
  // 둘 다 run-root 부트스트랩 마커 경로는 동일하다.
  const correction = /^(finding:[A-Za-z0-9._-]+:CR-\d{3}|verification:integration)$/.test(String(reason || ""))
  const approvedArtifact = /^approved-artifact:[0-9a-f]{40}$/.test(String(reason || ""))
  if ((!cancel && !correction) || (cancel && !approvedArtifact))
    throw new FailClosed(`rebind-task: reason 형식 오류(${cancel ? "approved-artifact:<postSHA>" : "finding:<reviewUnit>:<CR-NNN> | verification:integration"})`)
  return withStateLock(root, () => {
    const execPath = join(planDir(root, "plan", slug), "execution.json")
    const ex = readJSONStrict(execPath)
    const task = ex.tasks && ex.tasks[taskId]
    if (!task) throw new FailClosed(`rebind-task: task ${taskId} 없음`)
    ex.threadRebindings = Array.isArray(ex.threadRebindings) ? ex.threadRebindings : []
    const at = new Date().toISOString()
    if (cancel) {
      if (ex.pendingRunRootBootstrap !== taskId) throw new FailClosed(`rebind-task --cancel: task ${taskId} marker 없음`)
      delete ex.pendingRunRootBootstrap
      ex.threadRebindings.push({ action: "cancel", taskId, reason, at })
    } else {
      if (ex.pendingRunRootBootstrap) throw new FailClosed(`rebind-task: pendingRunRootBootstrap ${ex.pendingRunRootBootstrap} 이미 존재`)
      const oldThreadId = task.builderThreadId
      if (!oldThreadId) throw new FailClosed(`rebind-task: task ${taskId} builderThreadId 없음`)
      task.builderThreadId = null
      task.runStatus = "building"
      // 0.11: startedAt·codexCalls·builderBoundAt 리셋 없음 — 예산 우회 방지(DR-107); 확대는 watchdog-extend만.
      ex.pendingRunRootBootstrap = taskId
      ex.threadRebindings.push({ action: "rebind", taskId, oldThreadId, reason, at })
    }
    writeJSONAtomic(execPath, ex)
    return { ok: true, taskId, reason, cancel, pendingRunRootBootstrap: ex.pendingRunRootBootstrap || null }
  })
}

// ── dead-session rebind(0.11 §6-d) — 사용자 승인 원샷 바인딩 + provider terminal 원문 봉인 ─────────
// Codex MCP 세션 유실(hmm 런 6회+ 수기 복구)의 sanctioned 복구 경로. CLI 단독으로는 전이 불가:
// arm(원문 검증·봉인) → 다음 AskUserQuestion(질문 본문에 원문 그대로 제시) → 정확한 승인 선택에만 원자 전이.
const TERMINAL_MARKERS = [/session not found/i, /no such session/i, /thread not found/i, /unknown thread/i, /session .{0,20}expired/i]

export function rebindArm(root, slug, { taskId, oldThread, evidence, approveOption = "승인" }) {
  if (typeof evidence !== "string" || !evidence.trim()) throw new FailClosed("rebind-arm: --evidence <provider terminal 응답 원문> 필요")
  if (!TERMINAL_MARKERS.some((re) => re.test(evidence)))
    throw new FailClosed("rebind-arm: --evidence에 provider terminal 마커(Session not found류)가 없음 — idle timeout은 terminal 증거가 아니다(기존 fail-fast·세션 재시작 경로 사용)")
  return withStateLock(root, () => {
    const dir = planDir(root, "plan", slug)
    const other = otherArmPending(dir)
    if (other) throw new FailClosed(`rebind-arm: 원샷 승인 대기 중(${other}) — run 전체 단일 arm/pending(타입 무관 상호배제)`)
    const ex = readJSONStrict(join(dir, "execution.json"))
    const task = ex.tasks && ex.tasks[taskId]
    if (!task) throw new FailClosed(`rebind-arm: task ${taskId} 없음`)
    if (ex.pendingRunRootBootstrap) throw new FailClosed(`rebind-arm: pendingRunRootBootstrap ${ex.pendingRunRootBootstrap} 이미 존재`)
    if (!task.builderThreadId) throw new FailClosed(`rebind-arm: task ${taskId} builderThreadId 없음(해제할 스레드 없음)`)
    if (task.builderThreadId !== oldThread)
      throw new FailClosed(`rebind-arm: --old-thread 불일치(현재 바인딩 ${task.builderThreadId}) — 다른 태스크·낡은 스레드의 증거 재사용 방지`)
    writeJSONAtomic(join(dir, ".arm-rebind.json"), { taskId, oldThreadId: oldThread, evidence: evidence.trim(), approveOption, at: new Date().toISOString() })
    return { ok: true, taskId, oldThreadId: oldThread }
  })
}

export function recordPendingRebind(root, slug, toolUseId) {
  const dir = planDir(root, "plan", slug)
  const armPath = join(dir, ".arm-rebind.json")
  if (!existsSync(armPath)) return { ok: false, reason: "rebind 승인 미-arm" }
  return withStateLock(root, () => {
    const arm = readJSONStrict(armPath)
    writeJSONAtomic(join(dir, ".pending-rebind.json"), { ...arm, toolUseId })
    rmSync(armPath, { force: true })
    return { ok: true, taskId: arm.taskId }
  })
}

export function bindRebind(root, slug, toolUseId, toolInput, response) {
  const dir = planDir(root, "plan", slug)
  const pendingPath = join(dir, ".pending-rebind.json")
  if (!existsSync(pendingPath)) return { ok: false, reason: "pending-rebind 없음" }
  return withStateLock(root, () => {
    const pending = readJSONStrict(pendingPath)
    if (pending.toolUseId !== toolUseId) return { ok: false, reason: "tool_use_id 불일치" }
    rmSync(pendingPath, { force: true })
    // 질문 본문 대조: 봉인된 원문·태스크·구 threadId가 질문에 그대로 제시됐는가(요약·전언 금지 — 사용자 눈앞 검증).
    const haystack = JSON.stringify(toolInput || {})
    const needle = JSON.stringify(String(pending.evidence)).slice(1, -1)
    if (!haystack.includes(needle) || !haystack.includes(pending.taskId) || !haystack.includes(pending.oldThreadId))
      return { ok: false, reason: "승인 질문 본문에 봉인된 증거 원문·task·old threadId가 그대로 제시되지 않음 — 비바인딩" }
    const selected = extractSelectedAnswers(response)
    if (!selected.length || !selected.every((v) => v === pending.approveOption)) return { ok: false, reason: "승인 옵션 정확 일치 아님" }
    const execPath = join(dir, "execution.json")
    const ex = readJSONStrict(execPath)
    const task = ex.tasks && ex.tasks[pending.taskId]
    if (!task || task.builderThreadId !== pending.oldThreadId)
      return { ok: false, reason: `rebind 대상 상태 변화(현재 바인딩 ${task ? task.builderThreadId : "task 없음"}) — 비바인딩` }
    if (ex.pendingRunRootBootstrap) return { ok: false, reason: `pendingRunRootBootstrap ${ex.pendingRunRootBootstrap} 이미 존재` }
    task.builderThreadId = null
    task.runStatus = "building"
    // 카운터·기산점 리셋 없음(DR-107) — 예산 확대는 watchdog-extend만.
    ex.pendingRunRootBootstrap = pending.taskId
    ex.threadRebindings = Array.isArray(ex.threadRebindings) ? ex.threadRebindings : []
    ex.threadRebindings.push({ action: "rebind", taskId: pending.taskId, oldThreadId: pending.oldThreadId, reason: "dead-session", evidence: pending.evidence, at: new Date().toISOString() })
    writeJSONAtomic(execPath, ex)
    return { ok: true, taskId: pending.taskId, oldThreadId: pending.oldThreadId }
  })
}

// ── dev-solo(훅 부재 환경) CLI 권위 경로(0.11 §9) ─────────────────────────────
// init --authority cli: 훅 부트스트랩이 하던 실행 환경 준비(run worktree/branch)를 CLI로 수행한다.
// authority:"cli" run에서만 approve 서브커맨드가 유효하다(훅 run의 자가승인 차단 불변).
export function initCliAuthority(root, slug) {
  validateSlug(slug)
  if (!existsSync(join(root, ".git"))) throw new FailClosed(`init --authority cli: root가 git repo가 아님(${root})`)
  const workroot = createWorktree({ repo: root, branch: `harnie/${slug}` }).worktreePath
  const result = bootstrapRun(workroot, { base: slug, track: "plan", sessionId: null, authority: "cli" })
  return { ok: true, workroot, slug: result.slug, reused: result.reused === true, authority: "cli" }
}

export function approveCli(root, slug, planHashArg) {
  if (typeof planHashArg !== "string" || !planHashArg) throw new FailClosed("approve: --plan-hash 필요(사용자에게 제시·확인한 plan의 해시)")
  const s = readJSONStrict(sentinelPath(root))
  if (s.authority !== "cli")
    throw new FailClosed("approve: authority=cli run 전용 — 훅 부트스트랩 run의 승인은 AskUserQuestion 원샷 바인딩만 유효(자가승인 차단)")
  if (s.slug !== slug || s.track !== "plan") throw new FailClosed("approve: 활성 run과 slug 불일치")
  const d = derivePlanHash(root, slug)
  if (!d.ok) throw new FailClosed(d.reason)
  if (d.planHash !== planHashArg) throw new FailClosed("approve: --plan-hash가 현재 plan.md와 불일치 — 사용자에게 제시한 판과 다름")
  const rb = validateRepoBinding(root, d.block)
  if (rb) throw new FailClosed(`approve: repo 바인딩 불일치 — ${rb}`)
  return withStateLock(root, () => {
    const dir = planDir(root, "plan", slug)
    const manifestPath = join(dir, "manifest.json")
    const manifest = { ...canonicalManifest(d.block), planHash: d.planHash }
    if (existsSync(manifestPath)) {
      const prev = readJSONStrict(manifestPath)
      if (prev.planHash !== d.planHash) {
        let n = 1
        while (existsSync(join(dir, `manifest.v${n}.json`))) n++
        writeJSONAtomic(join(dir, `manifest.v${n}.json`), { ...prev, supersededAt: new Date().toISOString(), supersededBy: d.planHash })
        writeJSONAtomic(manifestPath, manifest)
      }
    } else writeJSONAtomic(manifestPath, manifest)
    const execPath = join(dir, "execution.json")
    const ex = readJSONStrict(execPath)
    ex.planHash = d.planHash
    ex.phase = "executing"
    ex.cliApprovals = Array.isArray(ex.cliApprovals) ? ex.cliApprovals : []
    ex.cliApprovals.push({ planHash: d.planHash, at: new Date().toISOString() }) // 감사 기록(대화 승인의 기계 바인딩 부재는 문서화된 한계)
    writeJSONAtomic(execPath, ex)
    const s2 = readJSONStrict(sentinelPath(root))
    if (s2.slug !== slug || s2.track !== "plan") throw new FailClosed("approve 중 active run 변경됨 — fail-closed")
    s2.planHash = d.planHash
    writeJSONAtomic(sentinelPath(root), s2)
    return { ok: true, planHash: d.planHash, phase: "executing" }
  })
}

// realpath: macOS tmpdir symlink(/var→/private/var) 등으로 경로 문자열 비교가 어긋나는 것 방지
function realpathOf(p) { return realpathSync(p) }

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

// CLI 진입 공통 가드(CR-001): 권위 상태를 변경하는 서브커맨드는 실행 전에 ① 인자(track/slug)가 활성 run과
// 일치하고 ② sentinel/execution의 mode mirror가 정합함을 검증한다(불일치 = 손상, fail-closed). init 제외.
export function assertActiveRun(root, slug, track = "plan") {
  const s = readJSONOrNull(sentinelPath(root))
  if (!s) throw new FailClosed("활성 run 없음(active.json 부재) — fail-closed")
  if (s.track !== track || s.slug !== slug)
    throw new FailClosed(`활성 run(${s.track}/${s.slug})과 인자(${track}/${slug}) 불일치 — fail-closed`)
  readMode(root, track, slug) // mode mirror 불일치 시 throw
}
function guardActive(flags, track = flags.track || "plan") {
  assertActiveRun(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), track)
}

function cmdArmApproval({ flags }) {
  guardActive(flags)
  const r = armApproval(flags.root, flags.slug, { approveOption: flags["approve-option"] || "승인" })
  if (!r.ok) die(r.reason)
  out(r)
}

function cmdSeal({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  guardActive(flags, track)
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

// 웜업(setup) 실행 — 검증 증거가 아니므로 vacuous 판정 없음. exitCode만 기록한다.
function runSetup(execRoot, s) {
  const cwd = s.cwd && s.cwd !== "." ? join(execRoot, s.cwd) : execRoot
  const r = spawnSync(s.executable, s.args, { cwd, timeout: s.timeout, encoding: "utf8", maxBuffer: VERIFY_MAX_OUT, env: verifyEnv() })
  const exitCode = typeof r.status === "number" ? r.status : (r.signal ? 124 : 1)
  return {
    executable: s.executable, args: s.args, cwd: s.cwd == null ? "." : s.cwd, timeout: s.timeout, exitCode,
    ...(r.error ? { spawnError: String(r.error.message).slice(0, 200) } : {}),
  }
}

// 통합 검증(0.11 §6-b): 전체 스위트 1회 — run-level receipt(review/integration/receipt.json).
// 유효 키 = whole-tree 아티팩트 + planHash + 승인된 integrationVerification 계약 해시. 동일 키 pass receipt 존재 시
// 재실행하지 않는다(무변화 중복 실행 금지의 기계화). 아티팩트는 실행 **후** 트리(검증이 캐시 등을 만들 수 있음).
function cmdVerifyIntegration({ flags }) {
  const root = flags.root || die("--root 필요")
  const slug = flags.slug || die("--slug 필요")
  const dir = planDir(root, "plan", slug)
  const manifest = readJSONStrict(join(dir, "manifest.json"))
  const iv = manifest.integrationVerification
  if (!Array.isArray(iv) || iv.length === 0) die("manifest에 integrationVerification 없음 — M 승인 계약에 포함돼야 함")
  const expectedHash = sha256(stableStringify(iv))
  const currentTree = captureTree(root)
  const receiptPath = join(dir, "review", "integration", "receipt.json")
  const prev = readJSONOrNull(receiptPath)
  if (prev && prev.exitCode === 0 && !prev.vacuous && prev.planHash === manifest.planHash && prev.verificationHash === expectedHash && prev.artifact === currentTree) {
    out({ ok: true, skipped: "existing-receipt", receipt: prev })
    return
  }
  const execRootOf = (v) => {
    if (v.repo != null) die("integrationVerification entry에 repo 키 불가 — run은 단일 repo 전용")
    return root
  }
  const results = iv.map((v) => runVerification(execRootOf(v), v))
  const allPass = results.every((r) => r.exitCode === 0)
  const vacuousReasons = results.flatMap((r, i) => r.vacuousReasons.map((x) => `integrationVerification[${i}] ${r.executable} ${r.args.join(" ")}: ${x}`))
  const artifact = captureTree(root) // 실행 후 트리에 바인딩
  const receipt = { integration: true, results, exitCode: allPass ? 0 : (results.find((r) => r.exitCode !== 0)?.exitCode ?? 1), vacuous: vacuousReasons.length > 0, vacuousReasons, planHash: manifest.planHash, verificationHash: expectedHash, artifact, at: new Date().toISOString() }
  writeJSONAtomic(receiptPath, receipt)
  if (receipt.vacuous) process.stderr.write(`harnie-exec: VACUOUS VERIFICATION — ${vacuousReasons.join(" | ")}\n`)
  out({ ok: allPass && !receipt.vacuous, receipt })
}

function cmdVerify({ flags }) {
  guardActive(flags, "plan")
  if (flags.integration === true) { cmdVerifyIntegration({ flags }); return }
  const root = flags.root
  const slug = flags.slug
  const taskId = flags.task || die("--task 필요")
  const dir = planDir(root, "plan", slug)
  const manifest = readJSONStrict(join(dir, "manifest.json"))
  const task = manifest.tasks.find((t) => t.id === taskId)
  if (!task) die(`manifest에 task ${taskId} 없음`)
  const state = readJSONOrNull(join(dir, "review", task.reviewUnit, "state.json"))
  const reviewedPostSHA = state && state.reviewedPostSHA
  if (!reviewedPostSHA) die(`task ${taskId}: reviewedPostSHA 없음(리뷰 APPROVE 후 검증) — fail-closed`)
  const { gitRoot, reason } = resolveTaskGitRoot(root, task)
  if (!gitRoot) die(`task ${taskId}: repo 바인딩 실패 — ${reason}`)
  const reviewedScopeHash = computeScopeHash(gitRoot, reviewedPostSHA, task.scope)
  const preScope = computeScopeHash(gitRoot, captureTree(gitRoot), task.scope)
  // 웜업: verification 前 순차 1회(의존성 설치·콜드-스타트 컴파일이 verification timeout을 먹지 않게).
  // setup 실패 시 verification을 돌리지 않고 receipt에 실패로 기록한다. setup도 scope 소스 불변 검사에 포함된다.
  const setupResults = (Array.isArray(task.setup) ? task.setup : []).map((s) => runSetup(gitRoot, s))
  const setupFail = setupResults.find((r) => r.exitCode !== 0)
  const results = setupFail ? [] : task.verification.map((v) => runVerification(gitRoot, v))
  const postScope = computeScopeHash(gitRoot, captureTree(gitRoot), task.scope)
  if (preScope !== postScope) die(`task ${taskId}: 검증이 scope 소스를 변형함(scopeHash 불변 위반) — fail-closed`)
  const allPass = !setupFail && results.every((r) => r.exitCode === 0)
  const vacuousReasons = results.flatMap((r, i) => r.vacuousReasons.map((x) => `verification[${i}] ${r.executable} ${r.args.join(" ")}: ${x}`))
  const vacuous = vacuousReasons.length > 0
  const receipt = { taskId, ...(setupResults.length ? { setupResults } : {}), results, exitCode: setupFail ? setupFail.exitCode : (allPass ? 0 : (results.find((r) => r.exitCode !== 0)?.exitCode ?? 1)), vacuous, vacuousReasons, scopeHash: reviewedScopeHash, planHash: manifest.planHash, at: new Date().toISOString() }
  writeJSONAtomic(join(dir, "review", task.reviewUnit, "receipt.json"), receipt)
  if (setupFail) process.stderr.write(`harnie-exec: SETUP FAILED — 웜업 실패(exitCode ${setupFail.exitCode}): ${setupFail.executable} ${setupFail.args.join(" ")} — verification 미실행\n`)
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
  guardActive(flags, "plan")
  out(setTaskRunStatus(flags.root, flags.slug, flags.task || die("--task 필요"), flags["run-status"] || die("--run-status 필요")))
}

function cmdWatchdogExtend({ flags }) {
  guardActive(flags, "plan")
  out(watchdogExtend(flags.root, flags.slug, flags.task || die("--task 필요"), flags.reason || die("--reason 필요")))
}

function cmdRebindTask({ flags }) {
  guardActive(flags, "plan")
  out(rebindTask(flags.root, flags.slug, { taskId: flags.task || die("--task 필요"), reason: flags.reason || die("--reason 필요"), cancel: flags.cancel === true }))
}

function cmdRebindArm({ flags }) {
  guardActive(flags, "plan")
  const evidence = flags.evidence || die("--evidence <provider terminal 응답 원문|@file> 필요")
  const text = String(evidence).startsWith("@") ? readFileSync(String(evidence).slice(1), "utf8") : String(evidence)
  out(rebindArm(flags.root, flags.slug, { taskId: flags.task || die("--task 필요"), oldThread: flags["old-thread"] || die("--old-thread 필요"), evidence: text, approveOption: flags["approve-option"] || "승인" }))
}

function cmdSetMode({ flags }) {
  out(setMode(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), flags.mode || die("--mode S|M|L 필요"))) // slug·mirror 검증은 setMode 내부
}

function cmdSetDifficulty({ flags }) {
  out(setDifficulty(flags.root || die("--root 필요"), flags.slug || die("--slug 필요"), flags.difficulty || die("--difficulty easy|medium|hard|very-hard 필요")))
}

function cmdApprove({ flags }) {
  guardActive(flags, "plan")
  out(approveCli(flags.root, flags.slug, flags["plan-hash"] || die("--plan-hash 필요")))
}

function cmdSetPhase({ flags }) {
  const root = flags.root || die("--root 필요")
  const track = flags.track || "plan"
  const slug = flags.slug || die("--slug 필요")
  guardActive(flags, track)
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
  withStateLock(root, () => {
    const execPath = join(dir, "execution.json")
    const ex = readJSONStrict(execPath)
    ex.phase = phase
    writeJSONAtomic(execPath, ex)
  })
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
      case "watchdog-extend": cmdWatchdogExtend(args); break
      case "rebind-task": cmdRebindTask(args); break
      case "rebind-arm": cmdRebindArm(args); break
      case "set-mode": cmdSetMode(args); break
      case "set-difficulty": cmdSetDifficulty(args); break
      case "approve": cmdApprove(args); break
      case "set-phase": cmdSetPhase(args); break
      default: die(`알 수 없는 서브커맨드: ${sub ?? "(none)"}`)
    }
  } catch (e) {
    if (e instanceof FailClosed) die(e.message)
    throw e
  }
}
