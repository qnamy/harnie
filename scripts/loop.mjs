#!/usr/bin/env node
// harnie loop CLI — 프롬프트 구동 오케스트레이터(main)가 리뷰 루프를 결정적으로 돌리기 위한 얇은 래퍼.
// delta.mjs(fix-delta 캡처) + ledger.mjs(엄격 파싱·병합·verdict 정합)를 조합하고,
// instructions/loop.md의 상태 전이(REVIEWING→APPROVED|REVISING|STALLED)를 코드로 고정한다.
// LLM은 ①②(정성) progress 판단만 --progress로 주입하고, ③(count 기반)·verdict 정합·stagnation은 여기서 계산.
// 셸 확장 없이 서브커맨드 1회 = loop 1스텝(전역 지침의 권한 프롬프트 회피).
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, resolve, basename, join, sep, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { captureTree, computeDelta } from "./delta.mjs"
import { parseReview, mergeLedger } from "./ledger.mjs"

function die(msg) {
  process.stderr.write(`harnie-loop: ${msg}\n`)
  process.exit(2)
}

// --key value 및 위치 인자 파싱(=는 지원 안 함 — 단순 유지).
function parseArgs(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      // 중복 플래그 거부(가드의 first-value 검사와 CLI의 last-wins 불일치로 인한 우회 차단).
      if (Object.prototype.hasOwnProperty.call(flags, key)) die(`중복 플래그 --${key} — 각 플래그는 1회만(모호)`)
      flags[key] = argv[++i]
    } else pos.push(a)
  }
  return { flags, pos }
}

// 상태 CLI가 임의 경로 쓰기 primitive가 되지 않도록: 쓰기 대상(--out/--ledger/--state)은 **canonical 기준 `<root>/.harnie` 내부**여야 함.
// "어디든 .harnie 세그먼트 존재"는 `.harnie/link → src/.harnie` symlink로 우회되므로, **active root를 받아** 그 root의
// `.harnie` 하위인지 realpath containment로 직접 검사한다(가드의 lexical 검사에 대한 backstop).
function canonicalize(p) {
  const abs = resolve(p) // `..` 렉시컬 붕괴
  let dir = abs
  const tail = []
  while (!existsSync(dir) && dirname(dir) !== dir) { tail.unshift(basename(dir)); dir = dirname(dir) }
  const realParent = existsSync(dir) ? realpathSync(dir) : dir // symlink 해소
  return tail.length ? join(realParent, ...tail) : realParent
}
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

// 지속 machineState 후보. AWAIT_REREVIEW는 비커밋 응답 전용이라 영속되지 않음.
const VALID_MACHINE_STATES = new Set(["REVISING", "APPROVED", "STALLED"])
const REENTRY_REASONS = new Set(["new-evidence", "external-state", "user-decision", "scope-change"])
const PROGRESS_FLAGS = new Set(["auto", "yes", "no"])

// --limit은 양의 정수여야 한다. NaN/0/음수면 stagnation 게이트가 무력화되므로 fail-closed.
function parseLimit(v) {
  if (v == null) return 3
  if (!/^[1-9]\d*$/.test(String(v))) die(`--limit은 양의 정수여야 함 (got ${JSON.stringify(v)})`)
  return Number(v)
}

// state.json 구조 검증(fail-closed). STALLED 래치가 machineState를 신뢰하므로 —
// **파일 부재**(정당한 초기 상태)와 **기존 파일의 필드 누락/손상**(래치 우회 시도)을 구분한다.
// 파일이 존재하면 machineState는 **필수**다(≥1 라운드를 거친 상태는 항상 machineState를 기록하므로,
// 누락은 손상/조작이며 STALLED를 round 0으로 위장해 래치를 건너뛰는 경로가 된다).
function readState(path) {
  if (!existsSync(path)) return { round: 0, stagnation: 0 } // 초기: 아직 라운드 없음
  const s = readJSON(path, null)
  if (s === null || typeof s !== "object" || Array.isArray(s)) die("state.json이 plain object가 아님(손상)")
  if (!Number.isInteger(s.round) || s.round < 0) die(`state.json round 손상: ${JSON.stringify(s.round)}`)
  if (!Number.isInteger(s.stagnation) || s.stagnation < 0) die(`state.json stagnation 손상: ${JSON.stringify(s.stagnation)}`)
  if (!VALID_MACHINE_STATES.has(s.machineState)) die(`기존 state.json에 machineState 누락/무효: ${JSON.stringify(s.machineState)}`)
  return s
}

// capture <repo> — builder 실행 직전 baseline tree SHA. 이후 delta의 기준점.
function cmdCapture({ pos }) {
  const repo = pos[0] || die("capture <repo> 필요")
  out({ baselineSHA: captureTree(repo) })
}

// delta <repo> <baselineSHA> [--scope a,b] [--out file] — 증분 fix-delta.
// patch를 --out에 쓰고(있으면), 요약 JSON을 stdout으로.
function cmdDelta({ pos, flags }) {
  const repo = pos[0] || die("delta <repo> <baselineSHA> 필요")
  const baseline = pos[1] || die("baselineSHA 필요")
  const expectScope = flags.scope ? flags.scope.split(",").map((s) => s.trim()).filter(Boolean) : null
  const d = computeDelta(repo, baseline, { expectScope })
  if (flags.out) {
    assertUnderHarnie(flags.out, "out", repo) // delta의 root = positional repo
    mkdirSync(dirname(flags.out), { recursive: true })
    writeFileSync(flags.out, d.patch)
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

// 상태 전이 순수 계산(loop.md의 REVIEWING→APPROVED|REVISING|STALLED). IO 없음 → 테스트 대상.
// merged = mergeLedger 결과(committed 전제). prevState = {round, stagnation}.
export function computeTransition(prevState, merged, verdict, { limit = 3, progressFlag = "auto" } = {}) {
  const newOpenBlocking = merged.newOpenBlocking
  let machineState, stagnation = prevState.stagnation, note
  if (verdict === "APPROVE") {
    machineState = "APPROVED"
    note = "open blocking 0 — 승인"
  } else if (prevState.round === 0) {
    // 첫 리뷰의 REJECT: progress 판정 없이 REVISING(정체 카운트 미시작).
    machineState = "REVISING"
    note = "첫 리뷰 REJECT → REVISING (정체 카운트 시작 전)"
  } else {
    // ③ count 기반 progress(gateProgress) 또는 ①② 정성 progress(--progress yes).
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

// apply --ledger <p> --review <p> --ns CR|DR --state <p> [--limit 3] [--progress auto|yes|no] [--reentry <reason>]
// 리뷰 응답 → 파싱 + 이전 ledger에 병합 + verdict 정합 검증 + 상태 전이. commit 시에만 ledger/state 영속.
function cmdApply({ flags }) {
  const ledgerPath = flags.ledger || die("--ledger 필요")
  const reviewPath = flags.review || die("--review 필요")
  const namespace = flags.ns || die("--ns CR|DR 필요")
  // --state 필수: STALLED 래치는 지속 상태를 요구한다. 생략을 허용하면 이전 STALLED를 round 0으로
  // 간주해 --reentry 없이 커밋하는 우회 경로가 열린다.
  const statePath = flags.state || die("--state 필요(STALLED 래치는 지속 상태를 요구)")
  // ledger·state는 active repo(--root)의 `.harnie/` 안에서만 쓰기(canonical containment — symlink 탈출 차단).
  const root = flags.root || die("--root 필요(ledger·state containment 기준 active repo)")
  assertUnderHarnie(ledgerPath, "ledger", root)
  assertUnderHarnie(statePath, "state", root)
  assertUnderHarnie(reviewPath, "review", root)
  // review-unit 구조 강제: ledger=ledger.json, state=state.json, review=round-N.txt가 **같은 (lexical) unit 디렉터리**에.
  if (basename(ledgerPath) !== "ledger.json") die(`--ledger basename은 ledger.json (got ${basename(ledgerPath)})`)
  if (basename(statePath) !== "state.json") die(`--state basename은 state.json (got ${basename(statePath)})`)
  if (!/^round-\d+\.txt$/.test(basename(reviewPath))) die(`--review basename은 round-N.txt 형식이어야 함 (got ${basename(reviewPath)})`)
  if (dirname(ledgerPath) !== dirname(statePath) || dirname(ledgerPath) !== dirname(reviewPath))
    die(`ledger·state·review는 같은 review-unit 디렉터리를 지정해야 함`)
  // **symlink 재지정 거부**: 각 경로의 canonical이 자기 lexical 위치와 일치해야 한다. "세 canonical 부모가 서로 같은지"만
  // 보면 셋을 함께 다른 unit으로 symlink할 때 canonical 부모끼리는 같아 통과 → 각 경로를 **lexical identity**(realRoot +
  // lexical relative)와 대조해 어떤 symlink 재지정도 거부한다(active unit이 아닌 stale unit으로의 우회 차단).
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
  const assertNoRedirect = (p, name) => {
    const expected = join(realRoot, relative(resolve(root), resolve(p)))
    const actual = canonicalize(p)
    if (actual !== expected) die(`--${name} symlink 재지정 감지 — lexical 위치와 canonical 불일치: ${expected} ≠ ${actual}`)
  }
  assertNoRedirect(ledgerPath, "ledger")
  assertNoRedirect(statePath, "state")
  assertNoRedirect(reviewPath, "review")

  // ledger·state 존재 정합(래치 우회 차단): 둘 다 부재(리뷰 단위 최초) 또는 둘 다 존재(진행 중)만 정당.
  // 하나만 존재하면 "기존 ledger + 새 state" 위장이거나 손상 → fail-closed.
  if (existsSync(ledgerPath) !== existsSync(statePath))
    die(`ledger·state 존재 여부 불일치(ledger=${existsSync(ledgerPath)}, state=${existsSync(statePath)}) — 둘 다 최초이거나 둘 다 진행 중이어야 함`)

  const limit = parseLimit(flags.limit)
  const progressFlag = flags.progress || "auto"
  if (!PROGRESS_FLAGS.has(progressFlag)) die(`--progress는 auto|yes|no (got ${JSON.stringify(progressFlag)})`)
  const reentry = flags.reentry || null
  if (reentry != null && !REENTRY_REASONS.has(reentry)) die(`--reentry는 ${[...REENTRY_REASONS].join("|")} 중 하나 (got ${JSON.stringify(reentry)})`)

  // --artifact <postSHA>: 리뷰된 tree SHA. execution.mjs가 scopeHash 재계산에 쓴다(DR-011a).
  // loop.mjs는 manifest·scope를 모르는 generic이라 reviewedPostSHA만 기록. CR 전용 — DR(설계 리뷰)는 금지.
  // CR(코드 리뷰)은 리뷰된 tree에 바인딩돼야 하므로 **--artifact 필수**(quick은 완료 재도출 엔진이 없어
  // 여기서 강제하지 않으면 artifact 없는 CR APPROVE가 그대로 done이 된다). DR(설계 리뷰)은 금지.
  const artifact = flags.artifact || null
  if (namespace === "CR" && artifact == null) die(`CR(코드 리뷰) apply는 --artifact <postSHA> 필수(리뷰된 tree 바인딩)`)
  if (artifact != null) {
    if (namespace !== "CR") die(`--artifact는 CR(코드 리뷰)에서만 — DR은 금지(설계는 리뷰된 tree 개념 없음)`)
    if (!/^[0-9a-f]{40}$/.test(artifact)) die(`--artifact는 40-hex tree SHA여야 함 (got ${JSON.stringify(artifact)})`)
    // artifact는 **현재 working tree와 일치**해야 함 — 임의/stale SHA·리뷰 후 변경 즉시 차단.
    // (plan은 completion에서 scope 재확인하지만 quick은 이 검사가 유일 게이트.)
    const current = captureTree(root)
    if (artifact !== current) die(`--artifact(${artifact})가 현재 working tree(${current})와 불일치 — stale/임의 SHA 또는 리뷰 후 변경. 재캡처 후 재리뷰 필요`)
  }

  const prevState = readState(statePath)
  const wasStalled = prevState.machineState === "STALLED"

  // STALLED 래치: 명시적 재진입 어서션이 **먼저**여야 한다. gateProgress 같은 사후 사실로 자동 해제하지 않는다.
  // 재진입 없으면 리뷰를 적용하지 않고(ledger·state 불변) needsReentry 반환.
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

  // 병합 실패(파싱·시맨틱·verdict 불일치·blocking 누락) → 재요청. ledger·state 불변.
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

  // 유효 재진입: STALLED→REVISING(stagnation=0)을 이번 라운드의 출발점으로. 근거는 receipt(state·output)에 기록.
  const effectivePrev = { round: prevState.round, stagnation: wasStalled ? 0 : prevState.stagnation }
  const nextState = computeTransition(effectivePrev, merged, parsed.verdict, { limit, progressFlag })

  // commit: ledger·state 영속(fail-closed 지났으므로 안전).
  writeJSON(ledgerPath, merged.ledger)
  const persisted = { round: nextState.round, stagnation: nextState.stagnation, machineState: nextState.machineState, lastVerdict: nextState.lastVerdict, openBlocking: nextState.openBlocking }
  if (reentry) persisted.reentry = reentry
  // 리뷰된 tree SHA 기록. 각 CR 라운드는 **그 라운드가 리뷰한 tree**를 넘겨야 한다 — 이전 값을 이월하지 않는다
  // (이월하면 재리뷰가 artifact 없이 와도 stale SHA가 남아 완료 판정을 오도). 생략 시 reviewedPostSHA 부재 → 완료 재도출 fail-closed.
  if (artifact) persisted.reviewedPostSHA = artifact
  writeJSON(statePath, persisted)

  out({
    committed: true,
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

// 직접 실행일 때만 CLI dispatch(import 시엔 computeTransition만 노출).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , sub, ...rest] = process.argv
  const args = parseArgs(rest)
  switch (sub) {
    case "capture": cmdCapture(args); break
    case "delta": cmdDelta(args); break
    case "apply": cmdApply(args); break
    default: die(`알 수 없는 서브커맨드: ${sub ?? "(none)"} — capture|delta|apply`)
  }
}
