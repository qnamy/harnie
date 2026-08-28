// harnie 강제 훅의 순수 결정 함수. 위협모델은 fallible·over-eager 오케스트레이터/빌더의 실수 방지다.
import { isAbsolute, resolve } from "node:path"

const CONTROL_BASENAMES = new Set([
  "manifest.json", "execution.json", "active.json", "ledger.json", "state.json", "receipt.json",
  ".seal.json", ".pending-approval.json", ".arm-approval.json",
  ".arm-rebind.json", ".pending-rebind.json",
])
export function isControlPath(relPath) {
  const p = String(relPath).replace(/\\/g, "/")
  if (!p.startsWith(".harnie/")) return false
  if (p === ".harnie/state.lock") return true
  const base = p.split("/").pop()
  if (/^manifest\.v\d+\.json$/.test(base)) return true // 재승인으로 교체된 manifest 아카이브(감사 기록) 보호
  return CONTROL_BASENAMES.has(base)
}

const PLANNING_PHASES = new Set(["planning", "awaiting-approval"])

// 실행 워치독은 권위가 아닌 advisory 예산이다. 상태가 불완전하면 시간을 근거로 막지 않는다.
export const WATCHDOG_DEFAULTS = { wallClockBudgetMs: 30 * 60_000, maxCodexCalls: 15 }
// 벽시계 예산은 빌더뿐 아니라 리뷰 라운드까지 먹는다 — hard run은 리뷰 라운드 수가 많아 기본 예산을 상향한다.
export const WATCHDOG_TIERS = {
  easy: WATCHDOG_DEFAULTS,
  medium: WATCHDOG_DEFAULTS,
  hard: { wallClockBudgetMs: 60 * 60_000, maxCodexCalls: 25 },
  // very-hard: 사용자 지시에 신규 수치 없음 — hard와 동일 예산을 의도적으로 재사용한다.
  // 실측 후 재조정은 후속 과제(plan.md "가정" 절).
  "very-hard": { wallClockBudgetMs: 60 * 60_000, maxCodexCalls: 25 },
}
export function watchdogBudget(difficulty) {
  return WATCHDOG_TIERS[difficulty] || WATCHDOG_DEFAULTS
}

// 예산 산식(0.11): effective = base × (1 + extensions). 카운터는 누적(리셋 없음) — watchdog-extend가 유일한
// 확대 경로다(리셋 방식은 재스폰·rebind로 상한을 우회할 수 있어 폐기, DR-107). 시간 기산점은 첫 빌더 바인딩
// 시각(builderBoundAt) — 러너의 그라운딩·상세설계 단계는 예산 밖이다. 구 상태(builderBoundAt 부재)는 startedAt 폴백.
export function decideWatchdog({
  startedAt,
  builderBoundAt,
  codexCalls,
  extensions,
  now = Date.now(),
  difficulty,
  wallClockBudgetMs,
  maxCodexCalls,
} = {}) {
  const tier = watchdogBudget(difficulty)
  const ext = Number.isInteger(extensions) && extensions >= 0 ? extensions : 0
  const budgetMs = (wallClockBudgetMs == null ? tier.wallClockBudgetMs : wallClockBudgetMs) * (1 + ext)
  const maxCalls = (maxCodexCalls == null ? tier.maxCodexCalls : maxCodexCalls) * (1 + ext)
  const calls = Number.isInteger(codexCalls) && codexCalls >= 0 ? codexCalls : 0
  const anchor = typeof builderBoundAt === "string" ? builderBoundAt : startedAt
  const parsed = typeof anchor === "string" ? Date.parse(anchor) : NaN
  const elapsedMs = Number.isFinite(parsed) ? now - parsed : null
  const elapsedMinutes = elapsedMs == null ? "시간 정보 없음" : `${Math.floor(elapsedMs / 60_000)}분/${budgetMs / 60_000}분`
  const reason = `경과 ${elapsedMinutes}, 빌더 codex 호출 ${calls}/${maxCalls}`
  // 경계 계약: call은 pre-call `>=`(base 15면 15회 사용 후 16번째 거부), wall은 `>`(정확한 경계 시각은 허용).
  const deny = calls >= maxCalls || (elapsedMs != null && elapsedMs > budgetMs)
  const warn = !deny && (calls >= Math.ceil(maxCalls * 0.8) || (elapsedMs != null && elapsedMs >= budgetMs * 0.8))
  return { deny, warn, elapsedMs, calls, reason, wallClockBudgetMs: budgetMs, maxCodexCalls: maxCalls }
}

// control 파일은 항상 보호하고, 승인 전에는 활성 run 디렉터리 밖 Write/Edit를 막는다.
// 0.14 D4 이후 이 deny를 받는 세션은 대개 run과 무관한 방관자다(게이트가 세션을 보지 않는다). 그래서 문구는
// 오케스트레이터가 아니라 그 세션에게 쓴다 — 어느 run이 잠갔는지(slug)와 나가는 두 출구를 담는다.
export function decideWriteEdit({ relPath, phase, track, slug, outside = false, root = null, execCli = null }) {
  const p = String(relPath).replace(/\\/g, "/")
  if (isControlPath(p))
    return { deny: true, reason: `control·review-state 직접 쓰기 금지(${p}) — 기록은 execution.mjs·loop.mjs로만` }
  if (!outside && PLANNING_PHASES.has(phase)) {
    const allowed = `.harnie/${track}/${slug}/`
    if (!p.startsWith(allowed))
      return { deny: true, reason: `승인 前(${phase}) 소스 쓰기 금지 — ${allowed} 밖(${p})은 승인 게이트 후에만. 이 트리는 미완료 harnie run(slug=${slug})이 잠갔다. 출구 둘: 이어가려면 인자 없이 \`/harnie:dev\`, 버리려면 ${abandonHint(root, slug, execCli)}` }
  }
  return { deny: false }
}
// 잠긴 세션에 실행 가능한 명령을 준다. 훅이 아닌 경로(단위 테스트 등)에서 인자가 없으면 형태만 안내한다.
function abandonHint(root, slug, execCli) {
  const cli = execCli || "<plugin>/scripts/execution.mjs"
  const r = root || "<repo root>"
  return `node ${cli} abandon --root ${r} --slug ${slug} --confirm ${slug}`
}

// Bash는 sanctioned CLI 외 `.harnie` 접근만 차단한다. 승인 전 Bash 소스 쓰기는 계획된 트레이드오프로 차단하지 않는다.
// `(?![\\w-])`는 `.harnie`로 시작하는 다른 이름(`.harnie-x` 등)을 매치에서 빼는 경계다 — 보호 대상은 상태
// 디렉터리 `.harnie/` 자신뿐이다. run root가 사용자 트리인 0.14에서는 이 blanket deny가 `cat .harnie/active.json`
// 같은 조회까지 막지만, 완화하지 않는다(설계 §8 — 공인 조회 경로는 loop.mjs export와 Read 도구다).
const HARNIE_STATE_REF = /\.harnie(?![\w-])/
export function referencesHarnie(cmd) {
  return HARNIE_STATE_REF.test(String(cmd || ""))
}

function isSanctionedCli(cmd, { trustedClis, activeRoot }) {
  if (/[;|&`\n\r]|\$\(|<\(|>\(|[<>]/.test(cmd)) return false
  const toks = String(cmd || "").trim().split(/\s+/)
  if (toks[0] !== "node") return false
  if (!isAbsolute(toks[1] || "")) return false
  const scriptAbs = resolve(toks[1])
  if (!trustedClis.has(scriptAbs)) return false
  if (activeRoot == null) return true
  const root = resolve(activeRoot)
  const rest = toks.slice(2)
  const flagVal = (name) => { const i = rest.lastIndexOf(name); return i >= 0 ? rest[i + 1] : undefined }
  const isRoot = (v) => v !== undefined && resolve(root, v) === root
  // 0.14: run root 하나뿐이므로 두 CLI 모두 run root만 받는다(태스크별 worktree 소멸).
  // abandon도 이 분기로 통과한다 — `--root`만 보므로 활성·비활성 slug 대상 둘 다 열린다(DEC-1의 성립 조건).
  if (scriptAbs.endsWith("execution.mjs")) return isRoot(flagVal("--root"))
  if (scriptAbs.endsWith("loop.mjs")) return rest[0] === "apply" ? isRoot(flagVal("--root")) : isRoot(rest[1])
  return false
}

const AUTO_ALLOW_SUB = { "loop.mjs": new Set(["capture", "delta", "export"]), "execution.mjs": new Set(["completion", "seal", "seal-verify"]) }
function hasValidActiveContext(root, slug, track) {
  return typeof root === "string" && root.length > 0 && typeof slug === "string" && slug.length > 0 && (track === "plan" || track === "quick")
}
function isAutoAllowSanctionedSub(cmd) {
  const toks = cmd.trim().split(/\s+/)
  const script = toks[1] || "", sub = toks[2]
  if (sub == null || sub.startsWith("--")) return false
  // seal의 자동 허용 근거는 "오염 흡수를 엔진이 막는다"인데, --after-mismatch는 바로 그 차단을 해제하는 승인이다 → 사용자 프롬프트로 되돌린다.
  if (sub === "seal" && toks.includes("--after-mismatch")) return false
  for (const [name, subs] of Object.entries(AUTO_ALLOW_SUB)) if (script.endsWith(name) && subs.has(sub)) return true
  return false
}
// 신뢰 CLI를 지목했는데 승인에 실패한 명령의 원인 진단. 이게 없으면 deny 이유가 "loop.mjs로만 하라"인데
// 정작 loop.mjs를 쓰고 있는 자기모순 메시지가 되어, 실측에서 오케스트레이터가 .sh 우회로 빠졌다.
function sanctionFailureWhy(cmd, { trustedClis, activeRoot }) {
  if (![...trustedClis].some((p) => cmd.includes(p))) return null
  if (/[;|&`\n\r]|\$\(|<\(|>\(|[<>]/.test(cmd)) return "셸 메타문자·리다이렉션 포함(신뢰 CLI는 단일 평문 명령만 승인)"
  const toks = cmd.trim().split(/\s+/)
  if (toks[0] !== "node" || !isAbsolute(toks[1] || "") || !trustedClis.has(resolve(toks[1])))
    return "`node <신뢰 CLI 절대경로> …` 형태가 아님"
  return `--root 인자가 이 트리의 run root와 불일치(run root ${activeRoot}) — 인자 오타이거나, 다른 트리의 run을 이 세션에서 조작하려는 경우`
}
// 명령이 `node <…>/execution.mjs <sub> …` 형태로 그 서브커맨드를 부르는지. 신뢰 CLI 판정과 독립이다 —
// 여기서 보는 것은 "무엇을 하려는가"이지 "승인된 형태인가"가 아니다.
export function isExecutionSubcommand(cmd, sub) {
  const toks = String(cmd || "").trim().split(/\s+/)
  const i = toks.findIndex((t) => /(?:^|\/)execution\.mjs$/.test(t))
  return i >= 0 && toks[i + 1] === sub
}

export function decideBash({ command, trustedClis = new Set(), activeRoot = null, activeSlug = null, activeTrack = null }) {
  const cmd = String(command || "")
  // DEC-2: 승인 경로를 정하는 것은 run에 적힌 라벨이 아니라 실행 시점의 훅 유무다. 훅이 도는 세션에서
  // 오케스트레이터가 Bash로 approve를 부르는 것은 AskUserQuestion 원샷 바인딩의 우회이므로 여기서 막는다.
  // **자리가 계약의 일부다** — `isSanctionedCli` 안에 넣으면 그 함수의 false가 deny가 아니라 다음 검사로의
  // 통과이고, 다음 `referencesHarnie`는 이 명령 문자열에 `.harnie`가 없어(스크립트 경로는 플러그인, --root는
  // repo root) 불일치한다. 결과는 fail-open이라 오늘보다 나빠진다.
  if (isExecutionSubcommand(cmd, "approve"))
    return { deny: true, reason: "훅이 도는 세션에서 `execution.mjs approve`의 Bash 호출 금지(자가승인 차단) — 승인은 `arm-approval`로 arm한 뒤 plan.md를 사용자에게 제시하고 AskUserQuestion 응답으로 바인딩하는 경로만 유효하다" }
  if (isSanctionedCli(cmd, { trustedClis, activeRoot })) {
    const bound = hasValidActiveContext(activeRoot, activeSlug, activeTrack)
    return { deny: false, autoAllow: bound && isAutoAllowSanctionedSub(cmd) }
  }
  if (referencesHarnie(cmd)) {
    const why = sanctionFailureWhy(cmd, { trustedClis, activeRoot })
    return { deny: true, reason: why ? `Bash로 .harnie 접근 금지 — 신뢰 CLI 형태이나 승인 실패: ${why}` : "Bash로 .harnie 접근 금지 — 상태 접근은 loop.mjs·execution.mjs(신뢰 CLI)로만" }
  }
  return { deny: false, autoAllow: false }
}

// harnie-designer는 Write를 가지지만(설계 산출물 직접 기록) 여기 남는다: 이 집합은 planning 단계에
// 스폰 가능한 에이전트를 정하는 것이고, designer의 Write는 decideWriteEdit가 승인 前
// `.harnie/<track>/<slug>/` 안으로 제한한다(소스 쓰기 불가). 빌더류는 여전히 제외.
const READONLY_AGENTS = new Set(["harnie-scout", "harnie-reviewer", "harnie-designer", "Explore", "Plan"])
function normalizeAgentType(t) {
  return typeof t === "string" && t.startsWith("harnie:") ? t.slice("harnie:".length) : t
}
export function decideTask({ subagentType, phase }) {
  if (PLANNING_PHASES.has(phase) && !READONLY_AGENTS.has(normalizeAgentType(subagentType)))
    return { deny: true, reason: `승인 前(${phase})엔 read-only 서브에이전트만 위임 가능(${subagentType} 차단) — 코드 작성은 승인 후` }
  return { deny: false }
}

// 승인 전 codex는 read-only, 승인 후 builder는 workspace-write + 활성 run root cwd만 허용한다(0.13).
export function decideCodex({ isReply, sandbox, cwd, root, slug = null, threadId, phase, readOnlyThreads = [], builderThreads = [], hasBuildingUnbound = false, buildingUnboundTasks = null, pendingRunRootBootstrap = null, taskRepoWorkroots = {} }) {
  const registered = new Set([...readOnlyThreads, ...builderThreads])
  if (PLANNING_PHASES.has(phase)) {
    if (!isReply) {
      if (sandbox !== "read-only")
        return { deny: true, reason: `승인 前(${phase}) codex는 sandbox:"read-only"만(설계 리뷰) — ${JSON.stringify(sandbox)} 차단` }
      return { deny: false }
    }
    if (!readOnlyThreads.includes(threadId))
      return { deny: true, reason: `승인 前 codex-reply는 등록된 read-only 스레드만(${threadId} 미등록)` }
    return { deny: false }
  }
  if (!isReply) {
    if (sandbox === "read-only") return { deny: false }
    if (sandbox !== "workspace-write")
      return { deny: true, reason: `빌더 codex sandbox는 정확히 "workspace-write"만(${JSON.stringify(sandbox)} 차단 — danger-full-access·미지정 불가)` }
    // 0.13: 태스크별 worktree가 사라져 빌더 cwd는 활성 run root뿐이다. 이 가드가 task worktree cwd를
    // 계속 허용하면 PostToolUse(registerBuilderAuto)가 귀속하지 못하는 호출을 열어, 리뷰·캡처 트리
    // 밖에서 소스가 바뀐다 — 두 게이트의 허용 집합을 같게 유지한다.
    if (cwd == null || root == null || cwd !== root)
      return { deny: true, reason: `빌더 codex cwd는 활성 run root로 명시돼야 함(got ${JSON.stringify(cwd)}, expect ${JSON.stringify(root)})` }
    if (Array.isArray(buildingUnboundTasks)) {
      if (pendingRunRootBootstrap) {
        if (!buildingUnboundTasks.includes(pendingRunRootBootstrap) || taskRepoWorkroots[pendingRunRootBootstrap] !== cwd)
          return { deny: true, reason: `marker task ${pendingRunRootBootstrap}의 building 상태 또는 repo workroot와 cwd 불일치` }
      } else {
        const serialTaskId = buildingUnboundTasks.length === 1 ? buildingUnboundTasks[0] : null
        if (!serialTaskId || taskRepoWorkroots[serialTaskId] !== cwd)
          return { deny: true, reason: "run-root 빌더 부트스트랩은 marker 필요 — marker 없는 serial 예외는 단일 building-unbound일 때만" }
      }
    } else if (!hasBuildingUnbound)
      return { deny: true, reason: "빌더 workspace-write 호출은 building·미바인딩 task가 있을 때만(set-task로 표시 후) — 임의 쓰기 차단" }
    return { deny: false }
  }
  if (!registered.has(threadId))
    return { deny: true, reason: `codex-reply는 등록된 스레드만(빌더/리뷰)(${threadId} 미등록) — 임의 스레드 차단` }
  return { deny: false }
}

export function decideStop({ complete, blockers = [], footer = { present: false }, stopHookActive = false }) {
  if (complete) return { block: false }
  const summary = blockers.length ? blockers.slice(0, 8).join("; ") : "권위 재도출상 미완료"
  if (!stopHookActive)
    return { block: true, reason: `아직 완료 아님(권위 재도출): ${summary}. 남은 것을 끝내거나, 정직하게 미완료를 보고(HARNIE_STATUS: INCOMPLETE — <blocker>)하고 제어권을 반환하라.` }
  if (footer.present && footer.status === "INCOMPLETE") return { block: false }
  return { block: true, reason: `권위상 미완료인데 COMPLETE 주장 또는 footer 부재. 정직 보고 footer가 필요: "HARNIE_STATUS: INCOMPLETE — ${summary}"` }
}
