#!/usr/bin/env node
// Deterministic review-state transitions around the model-produced verdict.
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, readdirSync, renameSync } from "node:fs"
import { dirname, resolve, basename, join, sep, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { captureTree, captureWorkspaceTree, computeDelta } from "./delta.mjs"
import { parseReview, mergeLedger } from "./ledger.mjs"

function die(msg) {
  process.stderr.write(`harnie-loop: ${msg}\n`)
  process.exit(2)
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

function canonicalize(p) {
  const abs = resolve(p) // `..` 렉시컬 붕괴
  let dir = abs
  const tail = []
  while (!existsSync(dir) && dirname(dir) !== dir) { tail.unshift(basename(dir)); dir = dirname(dir) }
  const realParent = existsSync(dir) ? realpathSync(dir) : dir // symlink 해소
  return tail.length ? join(realParent, ...tail) : realParent
}

// Canonical containment prevents review-state writes from escaping the active repo.
function assertUnderHarnie(p, name, root) {
  const real = canonicalize(p)
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
  const harnieRoot = join(realRoot, ".harnie")
  const rel = relative(harnieRoot, real)
  if (rel === "" || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))
    die(`--${name} 경로는 <root>/.harnie 안이어야 함(canonical containment — traversal·symlink 우회 차단): ${p} → ${real} (root ${realRoot})`)
}

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n")
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
}

const VALID_MACHINE_STATES = new Set(["REVISING", "APPROVED", "STALLED"])
const REENTRY_REASONS = new Set(["new-evidence", "external-state", "user-decision", "scope-change"])
const PROGRESS_FLAGS = new Set(["auto", "yes", "no"])
const CONTROL_BASENAMES = new Set(["manifest.json", "execution.json", "active.json", "ledger.json", "state.json", "receipt.json", "errata.md", ".seal.json", ".pending-approval.json", ".arm-approval.json", ".pending-errata.json", ".arm-errata.json"])

function parseLimit(v) {
  if (v == null) return 3
  if (!/^[1-9]\d*$/.test(String(v))) die(`--limit은 양의 정수여야 함 (got ${JSON.stringify(v)})`)
  return Number(v)
}

function readState(path) {
  if (!existsSync(path)) return { round: 0, stagnation: 0 } // 초기: 아직 라운드 없음
  const s = readJSON(path, null)
  if (s === null || typeof s !== "object" || Array.isArray(s)) die("state.json이 plain object가 아님(손상)")
  if (!Number.isInteger(s.round) || s.round < 0) die(`state.json round 손상: ${JSON.stringify(s.round)}`)
  if (!Number.isInteger(s.stagnation) || s.stagnation < 0) die(`state.json stagnation 손상: ${JSON.stringify(s.stagnation)}`)
  if (!VALID_MACHINE_STATES.has(s.machineState)) die(`기존 state.json에 machineState 누락/무효: ${JSON.stringify(s.machineState)}`)
  return s
}

// root의 "현재 tree" 아티팩트 — git repo면 40-hex tree SHA, workspace run root(비-git, active.json에
// workspaceRoot·repos)면 멤버 repo 합성 `ws:<sha256>`. 그 외(비-git·비-workspace)는 fail-closed.
function workspaceRepos(root) {
  const s = readJSON(join(root, ".harnie", "active.json"), null)
  if (!s || typeof s.workspaceRoot !== "string" || !s.workspaceRoot) return null
  return s.repos && typeof s.repos === "object" && !Array.isArray(s.repos) ? s.repos : {}
}
function currentArtifact(root) {
  if (existsSync(join(root, ".git"))) return captureTree(root)
  const repos = workspaceRepos(root)
  if (repos == null) die(`root가 git repo도 workspace run root도 아님: ${root}`)
  const ws = captureWorkspaceTree(repos)
  if (ws == null) die("workspace run에 등록된 repo 없음 — 먼저 execution.mjs repo-add로 등록하세요")
  return ws
}
// apply의 artifact 신선도 검증에 쓰는 허용 집합. workspace run root에선 합성값 외에 **각 멤버 repo의 현재
// tree(40-hex)** 도 허용한다 — task 단위 CR은 자기 멤버 repo tree를 아티팩트로 쓰고(레저는 run root에 있어
// --root는 run root), 그 task의 권위 바인딩은 execution.mjs가 manifest의 repo 키 + scope 해시로 재검증한다.
function acceptableArtifacts(root) {
  if (existsSync(join(root, ".git"))) return [captureTree(root)]
  const repos = workspaceRepos(root)
  if (repos == null) die(`root가 git repo도 workspace run root도 아님: ${root}`)
  const ws = captureWorkspaceTree(repos)
  if (ws == null) die("workspace run에 등록된 repo 없음 — 먼저 execution.mjs repo-add로 등록하세요")
  return [ws, ...Object.values(repos).map((r) => captureTree(r.workroot))]
}

function isUnderHarnie(p, root) {
  const real = canonicalize(p)
  const harnieRoot = join(existsSync(root) ? realpathSync(root) : resolve(root), ".harnie")
  const rel = relative(harnieRoot, real)
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)
}

function recordRunRoot(recordDir) {
  let dir = canonicalize(recordDir)
  while (dirname(dir) !== dir) {
    if (basename(dir) === ".harnie") return dirname(dir)
    dir = dirname(dir)
  }
  return null
}

function assertCaptureRecord(recordDir, repo) {
  if (isUnderHarnie(recordDir, repo)) return
  const runRoot = recordRunRoot(recordDir)
  if (!runRoot || !isUnderHarnie(recordDir, runRoot)) die(`--record는 positional repo 또는 활성 run workroot의 .harnie 아래여야 함: ${recordDir}`)
  const sentinel = readJSON(join(runRoot, ".harnie", "active.json"), null)
  if (!sentinel || !sentinel.slug || !sentinel.track) die(`--record 대상 run root sentinel 없음/손상: ${runRoot}`)
  const realRepo = existsSync(repo) ? realpathSync(repo) : resolve(repo)
  if (sentinel.workspaceRoot) {
    const member = Object.values(sentinel.repos || {}).some((r) => r && typeof r.workroot === "string" && existsSync(r.workroot) && realpathSync(r.workroot) === realRepo)
    if (!member) die(`--record positional repo가 대상 workspace run의 등록 멤버 workroot가 아님: ${repo}`)
  } else if (realpathSync(runRoot) !== realRepo) {
    die(`--record positional repo가 대상 single-repo run workroot와 불일치: ${repo}`)
  }
}

function cmdCapture({ pos, flags }) {
  const repo = pos[0] || die("capture <repo> 필요")
  const baselineSHA = currentArtifact(repo)
  let recordFile = null
  if (flags.record) {
    assertCaptureRecord(flags.record, repo)
    const dir = canonicalize(flags.record)
    mkdirSync(dir, { recursive: true })
    const nums = readdirSync(dir).map((name) => name.match(/^baseline-(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1]))
    const n = (nums.length ? Math.max(...nums) : 0) + 1
    recordFile = join(dir, `baseline-${n}.json`)
    const tmp = recordFile + ".tmp"
    writeFileSync(tmp, JSON.stringify({ baselineSHA, at: new Date().toISOString(), n }, null, 2) + "\n")
    renameSync(tmp, recordFile)
  }
  out({ baselineSHA, ...(recordFile ? { recordFile } : {}) })
}

function cmdDelta({ pos, flags }) {
  const repo = pos[0] || die("delta <repo> <baselineSHA> 필요")
  if (!existsSync(join(repo, ".git"))) die(`delta는 git repo(단일 repo 또는 멤버 repo workroot)에서만 — workspace run root는 불가: ${repo}`)
  const baseline = pos[1] || die("baselineSHA 필요")
  const expectScope = flags.scope ? flags.scope.split(",").map((s) => s.trim()).filter(Boolean) : null
  const d = computeDelta(repo, baseline, { expectScope })
  if (flags.out) {
    assertUnderHarnie(flags.out, "out", repo) // delta의 root = positional repo
    const outBase = basename(canonicalize(flags.out))
    if (CONTROL_BASENAMES.has(outBase) || /^manifest\.v\d+\.json$/.test(outBase)) die(`--out은 harnie control 파일을 덮어쓸 수 없음: ${flags.out}`)
    mkdirSync(dirname(flags.out), { recursive: true })
    writeFileSync(flags.out, d.patch)
    // 실측 기록: 동결 manifest/설계의 파일 수 추정은 승인 시점 값이라 실제와 어긋난다(실측 W6 18↔52 등).
    // patch 옆 `<out>.json`에 라운드마다 실제 changedPaths를 남겨, 추정-실측 회귀를 잡을 근거를 기계가 보존한다.
    const sidecar = flags.out + ".json"
    const sideBase = basename(canonicalize(sidecar))
    if (!CONTROL_BASENAMES.has(sideBase) && !/^manifest\.v\d+\.json$/.test(sideBase))
      writeJSON(sidecar, { baselineSHA: d.baselineSHA, postSHA: d.postSHA, changedCount: d.changedPaths.length, changedPaths: d.changedPaths, outOfScope: d.outOfScope, at: new Date().toISOString() })
  }
  out({
    baselineSHA: d.baselineSHA,
    postSHA: d.postSHA,
    changedPaths: d.changedPaths,
    outOfScope: d.outOfScope,
    nameStatus: d.nameStatus,
    patchFile: flags.out || null,
    empty: d.changedPaths.length === 0,
  })
}

// Read-only export of a .harnie artifact. The Bash guard blanket-blocks any command whose text
// references `.harnie` (reads included — read-only shell commands can't be classified reliably),
// so design docs and receipts leave .harnie through this sanctioned subcommand, never via cp/grep.
// Writes nothing under .harnie; --out must land outside it so this can't become a state-write primitive.
function cmdExport({ pos, flags }) {
  const repo = pos[0] || die("export <repo> <rel> 필요 — <rel>은 .harnie/ 기준 상대경로(예: plan/<slug>/design/rev-3.md)")
  const rel = pos[1] || die("export: .harnie/ 기준 상대경로 필요(예: plan/<slug>/design/rev-3.md)")
  const src = join(repo, ".harnie", rel)
  assertUnderHarnie(src, "export", repo)
  if (!existsSync(src)) die(`export 대상 없음: ${src}`)
  const content = readFileSync(src, "utf8")
  if (flags.out) {
    const dest = canonicalize(flags.out)
    const realRepo = existsSync(repo) ? realpathSync(repo) : resolve(repo)
    const relOut = relative(join(realRepo, ".harnie"), dest)
    if (!(relOut.startsWith(".." + sep) || relOut === ".." || isAbsolute(relOut)))
      die(`--out은 .harnie 밖이어야 함(상태 쓰기 프리미티브 전용 방지): ${flags.out}`)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, content)
    out({ ok: true, src, out: dest, bytes: Buffer.byteLength(content) })
  } else {
    process.stdout.write(content)
  }
}

// Only qualitative progress remains model-supplied; counters and transitions are deterministic.
export function computeTransition(prevState, merged, verdict, { limit = 3, progressFlag = "auto" } = {}) {
  const newOpenBlocking = merged.newOpenBlocking
  let machineState, stagnation = prevState.stagnation, note
  if (verdict === "APPROVE") {
    machineState = "APPROVED"
    note = "open blocking 0 — 승인"
  } else if (prevState.round === 0) {
    machineState = "REVISING"
    note = "첫 리뷰 REJECT → REVISING (정체 카운트 시작 전)"
  } else {
    const progress = merged.gateProgress || progressFlag === "yes"
    if (progress) {
      stagnation = 0
      machineState = "REVISING"
      note = merged.gateProgress
        ? `gate progress (open blocking ${merged.prevOpenBlocking}→${newOpenBlocking})`
        : "정성 progress(①/② orchestrator 판정) → stagnation reset"
    } else {
      stagnation = prevState.stagnation + 1
      machineState = stagnation >= limit ? "STALLED" : "REVISING"
      note = `no progress → stagnation ${prevState.stagnation}→${stagnation}${machineState === "STALLED" ? ` (limit ${limit} 도달)` : ""}`
    }
  }
  return {
    round: prevState.round + 1,
    stagnation,
    machineState,
    lastVerdict: verdict,
    openBlocking: newOpenBlocking,
    note,
  }
}

// Advisory context-budget signal: count APPROVED sibling units under the same review/ parent.
// Every 4th completed unit re-raises the dev-full SKILL's session-split proposal mechanically —
// the guideline lives there; this is only the backstop that keeps firing when context judgment degrades.
function countApprovedUnits(statePath) {
  let count = 0
  try {
    const reviewDir = dirname(dirname(statePath))
    for (const entry of readdirSync(reviewDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const s = JSON.parse(readFileSync(join(reviewDir, entry.name, "state.json"), "utf8"))
        if (s.machineState === "APPROVED") count++
      } catch { /* advisory only — an unreadable sibling never affects the apply */ }
    }
  } catch { /* advisory only */ }
  return count
}

function cmdApply({ flags }) {
  const ledgerPath = flags.ledger || die("--ledger 필요")
  const reviewPath = flags.review || die("--review 필요")
  const namespace = flags.ns || die("--ns CR|DR 필요")
  const statePath = flags.state || die("--state 필요(STALLED 래치는 지속 상태를 요구)")
  const root = flags.root || die("--root 필요(ledger·state containment 기준 active repo)")
  assertUnderHarnie(ledgerPath, "ledger", root)
  assertUnderHarnie(statePath, "state", root)
  assertUnderHarnie(reviewPath, "review", root)
  // Symlink redirection is outside the threat model; enforce lexical unit colocation only.
  if (basename(ledgerPath) !== "ledger.json") die(`--ledger basename은 ledger.json (got ${basename(ledgerPath)})`)
  if (basename(statePath) !== "state.json") die(`--state basename은 state.json (got ${basename(statePath)})`)
  if (!/^round-\d+\.txt$/.test(basename(reviewPath))) die(`--review basename은 round-N.txt 형식이어야 함 (got ${basename(reviewPath)})`)
  if (dirname(ledgerPath) !== dirname(statePath) || dirname(ledgerPath) !== dirname(reviewPath))
    die(`ledger·state·review는 같은 review-unit 디렉터리를 지정해야 함`)
  // Ledger and state must be created and advanced as one review unit.
  if (existsSync(ledgerPath) !== existsSync(statePath))
    die(`ledger·state 존재 여부 불일치(ledger=${existsSync(ledgerPath)}, state=${existsSync(statePath)}) — 둘 다 최초이거나 둘 다 진행 중이어야 함`)
  const limit = parseLimit(flags.limit)
  const progressFlag = flags.progress || "auto"
  if (!PROGRESS_FLAGS.has(progressFlag)) die(`--progress는 auto|yes|no (got ${JSON.stringify(progressFlag)})`)
  const reentry = flags.reentry || null
  if (reentry != null && !REENTRY_REASONS.has(reentry)) die(`--reentry는 ${[...REENTRY_REASONS].join("|")} 중 하나 (got ${JSON.stringify(reentry)})`)
  const artifact = flags.artifact || null
  if (namespace === "CR" && artifact == null) die(`CR(코드 리뷰) apply는 --artifact <postSHA> 필수(리뷰된 tree 바인딩)`)
  if (artifact != null) {
    if (namespace !== "CR") die(`--artifact는 CR(코드 리뷰)에서만 — DR은 금지(설계는 리뷰된 tree 개념 없음)`)
    if (!/^(?:[0-9a-f]{40}|ws:[0-9a-f]{64})$/.test(artifact))
      die(`--artifact는 40-hex tree SHA 또는 workspace 합성 ws:<sha256>여야 함 (got ${JSON.stringify(artifact)})`)
    const acceptable = acceptableArtifacts(root)
    if (!acceptable.includes(artifact))
      die(`--artifact(${artifact})가 현재 working tree(${acceptable.join(", ")})와 불일치 — stale/임의 SHA 또는 리뷰 후 변경. 재캡처 후 재리뷰 필요`)
  }
  const prevState = readState(statePath)
  const wasStalled = prevState.machineState === "STALLED"
  // STALLED is latched until the caller asserts a concrete reentry reason.
  if (reentry != null && !wasStalled) die("--reentry는 STALLED 상태에서만 유효")
  if (wasStalled && !reentry) {
    out({
      committed: false,
      needsReentry: true,
      machineState: "STALLED",
      stagnation: prevState.stagnation,
      reason: `STALLED 해제에는 --reentry <${[...REENTRY_REASONS].join("|")}> 필요(오케스트레이터가 사용자에게 surface 후 어서션). scope-change는 사용자 승인 후에만.`,
    })
    return
  }
  const prevLedger = readJSON(ledgerPath, {})
  const reviewText = readFileSync(reviewPath, "utf8")
  const parsed = parseReview(reviewText, { namespace })
  const merged = mergeLedger(prevLedger, parsed, { namespace })
  if (!merged.committed) {
    out({
      committed: false,
      needsReRequest: true,
      machineState: "AWAIT_REREVIEW",
      reasons: merged.reasons,
      protocolViolations: merged.protocolViolations,
      omittedBlocking: merged.omittedBlocking,
    })
    return
  }
  const effectivePrev = { round: prevState.round, stagnation: wasStalled ? 0 : prevState.stagnation }
  const nextState = computeTransition(effectivePrev, merged, parsed.verdict, { limit, progressFlag })
  writeJSON(ledgerPath, merged.ledger)
  const persisted = { round: nextState.round, stagnation: nextState.stagnation, machineState: nextState.machineState, lastVerdict: nextState.lastVerdict, openBlocking: nextState.openBlocking }
  if (reentry) persisted.reentry = reentry
  if (artifact) persisted.reviewedPostSHA = artifact
  writeJSON(statePath, persisted)
  const contextBudget = {}
  if (nextState.machineState === "APPROVED") {
    const completedUnits = countApprovedUnits(statePath)
    contextBudget.completedUnits = completedUnits
    contextBudget.sessionSplitRecommended = completedUnits > 0 && completedUnits % 4 === 0
  }
  out({
    committed: true,
    ...contextBudget,
    needsReRequest: false,
    needsReentry: false,
    machineState: nextState.machineState,
    verdict: parsed.verdict,
    round: nextState.round,
    stagnation: nextState.stagnation,
    openBlocking: merged.newOpenBlocking,
    prevOpenBlocking: merged.prevOpenBlocking,
    gateProgress: merged.gateProgress,
    reentry: reentry || null,
    protocolViolations: merged.protocolViolations, // non-blocking 누락(진행은 가능, receipt 기록용)
    openIds: Object.keys(merged.ledger).filter((id) => merged.ledger[id].status === "open"),
    note: reentry ? `유효 재진입(${reentry}): STALLED 해제·stagnation reset 후 적용. ${nextState.note}` : nextState.note,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , sub, ...rest] = process.argv
  const args = parseArgs(rest)
  switch (sub) {
    case "capture": cmdCapture(args); break
    case "delta": cmdDelta(args); break
    case "apply": cmdApply(args); break
    case "export": cmdExport(args); break
    default: die(`알 수 없는 서브커맨드: ${sub ?? "(none)"} — capture|delta|apply|export`)
  }
}
