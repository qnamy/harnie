// harnie 강제 훅의 순수 결정 함수. 위협모델은 fallible·over-eager 오케스트레이터/빌더의 실수 방지다.
import { isAbsolute, resolve } from "node:path"

const CONTROL_BASENAMES = new Set([
  "manifest.json", "execution.json", "active.json", "ledger.json", "state.json", "receipt.json",
  ".seal.json", ".pending-approval.json", ".arm-approval.json",
])
export function isControlPath(relPath) {
  const p = String(relPath).replace(/\\/g, "/")
  if (!p.startsWith(".harnie/")) return false
  if (p.startsWith(".harnie/pending-route/")) return true
  if (p === ".harnie/state.lock") return true
  return CONTROL_BASENAMES.has(p.split("/").pop())
}

const PLANNING_PHASES = new Set(["planning", "awaiting-approval"])

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
const HARNIE_REF = /\.harnie(?:[\/]|\b)/
export function referencesHarnie(cmd) { return HARNIE_REF.test(String(cmd || "")) }

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
  const isRepo = (v) => v !== undefined && resolve(root, v) === root
  if (scriptAbs.endsWith("execution.mjs")) return isRepo(flagVal("--root"))
  if (scriptAbs.endsWith("loop.mjs")) return rest[0] === "apply" ? isRepo(flagVal("--root")) : isRepo(rest[1])
  return false
}

const AUTO_ALLOW_SUB = { "loop.mjs": new Set(["capture", "delta"]), "execution.mjs": new Set(["completion", "seal-verify"]) }
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
export function decideBash({ command, trustedClis = new Set(), activeRoot = null, activeSlug = null, activeTrack = null }) {
  const cmd = String(command || "")
  if (isSanctionedCli(cmd, { trustedClis, activeRoot })) {
    const bound = hasValidActiveContext(activeRoot, activeSlug, activeTrack)
    return { deny: false, autoAllow: bound && isAutoAllowSanctionedSub(cmd) }
  }
  if (referencesHarnie(cmd))
    return { deny: true, reason: "Bash로 .harnie 접근 금지 — 상태 접근은 loop.mjs·execution.mjs(신뢰 CLI)로만" }
  return { deny: false, autoAllow: false }
}

const READONLY_AGENTS = new Set(["harnie-scout", "harnie-reviewer", "harnie-designer", "Explore", "Plan"])
function normalizeAgentType(t) {
  return typeof t === "string" && t.startsWith("harnie:") ? t.slice("harnie:".length) : t
}
export function decideTask({ subagentType, phase }) {
  if (PLANNING_PHASES.has(phase) && !READONLY_AGENTS.has(normalizeAgentType(subagentType)))
    return { deny: true, reason: `승인 前(${phase})엔 read-only 서브에이전트만 위임 가능(${subagentType} 차단) — 코드 작성은 승인 후` }
  return { deny: false }
}

// 승인 전 codex는 read-only, 승인 후 builder는 workspace-write + 활성 repo cwd만 허용한다.
export function decideCodex({ isReply, sandbox, cwd, root, threadId, phase, readOnlyThreads = [], builderThreads = [], hasBuildingUnbound = false }) {
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
    if (cwd == null || root == null || cwd !== root)
      return { deny: true, reason: `빌더 codex cwd는 활성 repo root로 명시돼야 함(got ${JSON.stringify(cwd)}, expect ${JSON.stringify(root)})` }
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
