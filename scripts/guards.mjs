// harnie 강제 훅의 순수 결정 함수. 위협모델은 fallible·over-eager 오케스트레이터/빌더의 실수 방지다.
import { basename, dirname, isAbsolute, resolve } from "node:path"

const CONTROL_BASENAMES = new Set([
  "manifest.json", "execution.json", "active.json", "ledger.json", "state.json", "receipt.json",
  ".seal.json", ".pending-approval.json", ".arm-approval.json",
])
export function isControlPath(relPath) {
  const p = String(relPath).replace(/\\/g, "/")
  if (!p.startsWith(".harnie/")) return false
  if (p.startsWith(".harnie/pending-route/")) return true
  if (p.startsWith(".harnie/sessions/")) return true // 세션→run(worktree) 바인딩 보호(T2 DEC-001)
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
}
export function watchdogBudget(difficulty) {
  return WATCHDOG_TIERS[difficulty] || WATCHDOG_DEFAULTS
}

export function decideWatchdog({
  startedAt,
  codexCalls,
  now = Date.now(),
  difficulty,
  wallClockBudgetMs,
  maxCodexCalls,
} = {}) {
  const tier = watchdogBudget(difficulty)
  const budgetMs = wallClockBudgetMs == null ? tier.wallClockBudgetMs : wallClockBudgetMs
  const maxCalls = maxCodexCalls == null ? tier.maxCodexCalls : maxCodexCalls
  const calls = Number.isInteger(codexCalls) && codexCalls >= 0 ? codexCalls : 0
  const parsed = typeof startedAt === "string" ? Date.parse(startedAt) : NaN
  const elapsedMs = Number.isFinite(parsed) ? now - parsed : null
  const elapsedMinutes = elapsedMs == null ? "시간 정보 없음" : `${Math.floor(elapsedMs / 60_000)}분/${budgetMs / 60_000}분`
  const reason = `경과 ${elapsedMinutes}, 빌더 codex 호출 ${calls}/${maxCalls}`
  const deny = calls >= maxCalls || (elapsedMs != null && elapsedMs >= budgetMs)
  const warn = !deny && (calls >= Math.ceil(maxCalls * 0.8) || (elapsedMs != null && elapsedMs >= budgetMs * 0.8))
  return { deny, warn, elapsedMs, calls, reason, wallClockBudgetMs: budgetMs, maxCodexCalls: maxCalls }
}

// control 파일은 항상 보호하고, 승인 전에는 활성 run 디렉터리 밖 Write/Edit를 막는다.
export function decideWriteEdit({ relPath, phase, track, slug, outside = false }) {
  const p = String(relPath).replace(/\\/g, "/")
  if (isControlPath(p))
    return { deny: true, reason: `control·review-state 직접 쓰기 금지(${p}) — 기록은 execution.mjs·loop.mjs로만` }
  if (!outside && PLANNING_PHASES.has(phase)) {
    const allowed = `.harnie/${track}/${slug}/`
    if (!p.startsWith(allowed))
      return { deny: true, reason: `승인 前(${phase}) 소스 쓰기 금지 — ${allowed} 밖(${p})은 승인 게이트 후에만` }
  }
  return { deny: false }
}

// Bash는 sanctioned CLI 외 `.harnie` 접근만 차단한다. 승인 전 Bash 소스 쓰기는 계획된 트레이드오프로 차단하지 않는다.
// 첫 대안은 `.harnie` 자체(어디에 nested든) — `\b`가 아니라 `(?![\w-])`를 쓴다: worktree-per-run(T2)의 컨테이너
// `.harnie-wt`는 "harnie"와 "-" 사이가 단어경계라 `\b` 기준으로는 매치돼, 그 안의 평범한 파일까지 Bash로 전부
// 접근 불가능해지는 회귀가 있었다. 둘째 대안은 `.harnie-wt` **컨테이너 자체**(뒤에 실제 worktree 이름(`/<slug>`)
// 으로 이어지지 않는 형태 — `rm -rf .harnie-wt`·트레일링 슬래시(`.harnie-wt/`)·glob(`.harnie-wt/*`) 포함) — 모든
// run의 상태를 한 번에 지우는 실수를 막는다. `.harnie-wt/<slug>/…`처럼 특정 worktree 안의 평범한 파일은 매치하지
// 않아 그 worktree에서 build·test·git 등을 자유롭게 쓸 수 있다.
const HARNIE_STATE_REF = /\.harnie(?![\w-])/
const GLOB_META = /[*?\[\]{}]/
function referencesWorktreeContainer(cmd) {
  const s = String(cmd || "")
  const marker = ".harnie-wt"
  for (let from = 0, at; (at = s.indexOf(marker, from)) >= 0; from = at + marker.length) {
    const tail = (s.slice(at + marker.length).match(/^[^\s'\"]*/) || [""])[0]
    // Empty/container-only tokens and any glob can span the container or multiple paths. A concrete `/segment`
    // without glob syntax names one worktree/path and is intentionally allowed.
    if (tail === "" || tail === "/" || !tail.startsWith("/") || GLOB_META.test(tail)) return true
  }
  return false
}
export function referencesHarnie(cmd) {
  const s = String(cmd || "")
  return HARNIE_STATE_REF.test(s) || referencesWorktreeContainer(s)
}

export function isActiveTaskWorktree(root, slug, candidate) {
  if (root == null || slug == null || candidate == null) return false
  const parent = resolve(root, ".harnie-wt")
  const target = resolve(root, candidate)
  const escapedSlug = String(slug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return dirname(target) === parent && new RegExp(`^harnie-${escapedSlug}-t[A-Za-z0-9._-]+$`).test(basename(target))
}

function isSanctionedCli(cmd, { trustedClis, activeRoot, activeSlug, memberRoots = [] }) {
  if (/[;|&`\n\r]|\$\(|<\(|>\(|[<>]/.test(cmd)) return false
  const toks = String(cmd || "").trim().split(/\s+/)
  if (toks[0] !== "node") return false
  if (!isAbsolute(toks[1] || "")) return false
  const scriptAbs = resolve(toks[1])
  if (!trustedClis.has(scriptAbs)) return false
  if (activeRoot == null) return true
  const root = resolve(activeRoot)
  // workspace run(멀티레포): 등록된 멤버 repo workroot도 loop/worktree의 유효 대상이다(활성 run root 외).
  const roots = [root, ...memberRoots.map((r) => resolve(r))]
  const rest = toks.slice(2)
  const flagVal = (name) => { const i = rest.lastIndexOf(name); return i >= 0 ? rest[i + 1] : undefined }
  const isActiveRoot = (v) => v !== undefined && resolve(root, v) === root
  const isRepo = (v) => v !== undefined && roots.includes(resolve(root, v))
  const isRepoOrTaskWt = (v) => isRepo(v) || (v !== undefined && activeSlug != null && roots.some((rt) => isActiveTaskWorktree(rt, activeSlug, resolve(root, v))))
  if (scriptAbs.endsWith("execution.mjs")) return isActiveRoot(flagVal("--root"))
  if (scriptAbs.endsWith("loop.mjs")) return rest[0] === "apply" ? isRepoOrTaskWt(flagVal("--root")) : isRepoOrTaskWt(rest[1])
  if (scriptAbs.endsWith("worktree.mjs")) return isRepo(flagVal("--repo"))
  return false
}

const AUTO_ALLOW_SUB = { "loop.mjs": new Set(["capture", "delta", "export"]), "execution.mjs": new Set(["completion", "seal-verify"]) }
function hasValidActiveContext(root, slug, track) {
  return typeof root === "string" && root.length > 0 && typeof slug === "string" && slug.length > 0 && (track === "plan" || track === "quick")
}
function isAutoAllowSanctionedSub(cmd) {
  const toks = cmd.trim().split(/\s+/)
  const script = toks[1] || "", sub = toks[2]
  if (sub == null || sub.startsWith("--")) return false
  for (const [name, subs] of Object.entries(AUTO_ALLOW_SUB)) if (script.endsWith(name) && subs.has(sub)) return true
  return false
}
// 신뢰 CLI를 지목했는데 승인에 실패한 명령의 원인 진단. 이게 없으면 deny 이유가 "loop.mjs로만 하라"인데
// 정작 loop.mjs를 쓰고 있는 자기모순 메시지가 되어, 실측에서 오케스트레이터가 .sh 우회로 빠졌다.
function sanctionFailureWhy(cmd, { trustedClis, activeRoot, memberRoots = [] }) {
  if (![...trustedClis].some((p) => cmd.includes(p))) return null
  if (/[;|&`\n\r]|\$\(|<\(|>\(|[<>]/.test(cmd)) return "셸 메타문자·리다이렉션 포함(신뢰 CLI는 단일 평문 명령만 승인)"
  const toks = cmd.trim().split(/\s+/)
  if (toks[0] !== "node" || !isAbsolute(toks[1] || "") || !trustedClis.has(resolve(toks[1])))
    return "`node <신뢰 CLI 절대경로> …` 형태가 아님"
  return `root/repo 인자가 활성 run 바인딩과 불일치(활성 root ${activeRoot}, 등록 멤버 workroot ${memberRoots.length}개) — 인자 오타이거나, 훅이 이 세션의 run 문맥을 읽지 못해(비-owner 세션 등) 멤버 repo가 미등록으로 보이는 경우`
}
export function decideBash({ command, trustedClis = new Set(), activeRoot = null, activeSlug = null, activeTrack = null, memberRoots = [] }) {
  const cmd = String(command || "")
  if (isSanctionedCli(cmd, { trustedClis, activeRoot, activeSlug, memberRoots })) {
    const bound = hasValidActiveContext(activeRoot, activeSlug, activeTrack)
    return { deny: false, autoAllow: bound && isAutoAllowSanctionedSub(cmd) }
  }
  if (referencesHarnie(cmd)) {
    const why = sanctionFailureWhy(cmd, { trustedClis, activeRoot, memberRoots })
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

// 승인 전 codex는 read-only, 승인 후 builder는 workspace-write + 활성 repo/멤버 workroot/task worktree cwd만 허용한다.
export function decideCodex({ isReply, sandbox, cwd, root, slug = null, threadId, phase, readOnlyThreads = [], builderThreads = [], hasBuildingUnbound = false, memberRoots = [] }) {
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
    const allowedCwd = cwd != null && root != null &&
      (cwd === root || isActiveTaskWorktree(root, slug, cwd) ||
        memberRoots.some((m) => cwd === m || isActiveTaskWorktree(m, slug, cwd)))
    if (!allowedCwd)
      return { deny: true, reason: `빌더 codex cwd는 활성 repo root·등록된 멤버 repo workroot 또는 활성 task worktree로 명시돼야 함(got ${JSON.stringify(cwd)}, expect ${JSON.stringify(root)}·등록 멤버 workroot 또는 그 task worktree)` }
    if (!hasBuildingUnbound)
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
