import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from "node:fs"
import { join, dirname, resolve, basename, relative, sep, isAbsolute } from "node:path"

const isOutsideRel = (rel) => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)

// Resolve the nearest existing parent once so new paths still get canonical containment.
export function canonicalRelPath(root, filePath) {
  if (!filePath) return { rel: "", abs: "", escapes: false, outside: false }
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  let dir = abs
  const tail = []
  while (!existsSync(dir) && dirname(dir) !== dir) { tail.unshift(basename(dir)); dir = dirname(dir) }
  const realParent = existsSync(dir) ? realpathSync(dir) : dir
  const real = tail.length ? join(realParent, ...tail) : realParent
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
  const rel = relative(realRoot, real)
  const lexOutside = isOutsideRel(relative(resolve(root), abs)) && isOutsideRel(relative(realRoot, abs))
  const canonOutside = isOutsideRel(rel)
  const outside = canonOutside && lexOutside && isAbsolute(filePath)
  return { rel: rel.split(sep).join("/"), abs: real, escapes: canonOutside && !outside, outside }
}

export function harnieControlSuffix(absPath) {
  const p = String(absPath || "").replace(/\\/g, "/")
  const i = p.lastIndexOf("/.harnie/")
  return i < 0 ? null : p.slice(i + 1)
}

export function readStdin() {
  return new Promise((res) => {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => (buf += d))
    process.stdin.on("end", () => {
      try { res(buf ? JSON.parse(buf) : {}) } catch { res({}) }
    })
    if (process.stdin.isTTY) res({})
  })
}

export function findRoot(startCwd) {
  let dir = resolve(startCwd || process.cwd())
  for (;;) {
    if (existsSync(join(dir, ".harnie", "active.json"))) return dir
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(startCwd || process.cwd())
}

// ── 세션→run 바인딩(worktree-per-run, T2 DEC-001) ───────────────────────────
// main repo의 `.harnie/sessions/<session_id>.json` = {"workroot": "<worktree 절대경로>"}. bootstrap이 dev-full
// worktree 생성 후 기록하고 세션 수명 동안 유지한다(완료 후 후속 변경도 같은 run으로 재검증). 세션의 cwd는 계속 main 작업트리이므로,
// 훅이 자기 run(=worktree)을 찾으려면 이 바인딩을 거쳐야 한다(resolveRoot).
const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/
function sessionBindingPath(root, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_NAME_RE.test(sessionId) || sessionId === "." || sessionId === "..") return null
  return join(root, ".harnie", "sessions", sessionId + ".json")
}
export function readSessionBinding(root, sessionId) {
  const p = sessionBindingPath(root, sessionId)
  if (!p || !existsSync(p)) return null
  try {
    const b = JSON.parse(readFileSync(p, "utf8"))
    // workroot는 절대경로여야 한다 — 상대경로(예: ".")면 resolveRoot가 그걸 cwd 기준으로 해석해 의도와 다른
    // 곳을 활성 root로 오인할 수 있다.
    return b && typeof b.workroot === "string" && isAbsolute(b.workroot) ? b : null
  } catch { return null }
}
export function writeSessionBinding(root, sessionId, workroot) {
  const p = sessionBindingPath(root, sessionId)
  if (!p) throw new Error(`session binding: 부적합 session_id ${JSON.stringify(sessionId)}`)
  if (typeof workroot !== "string" || !isAbsolute(workroot)) throw new Error(`session binding: workroot는 절대경로 필요 (${JSON.stringify(workroot)})`)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + ".tmp"
  writeFileSync(tmp, JSON.stringify({ workroot }, null, 2) + "\n")
  renameSync(tmp, p)
}
export function clearSessionBinding(root, sessionId) {
  const p = sessionBindingPath(root, sessionId)
  if (!p) return
  try { unlinkSync(p) } catch { /* 이미 없음 */ }
}
// H1(PreToolUse)·H2(Stop)·PostToolUse가 활성 run의 root를 찾는 해석 순서:
// ① 이 세션의 바인딩 파일이 있고 그 workroot가 아직 존재하면 그걸 쓴다 — 세션 cwd가 main 작업트리에 그대로
//    있는(흔한) 경우. **이게 항상 먼저다**: cwdRoot 자신에 (이 세션과 무관한) active.json이 남아 있다고 해서
//    (예: 다른 세션의 quick 트랙 잔재, pre-T2 run, 완료 후 정리 전 상태) 그걸 이 세션의 run으로 오인해선 안
//    된다 — 그러면 이 세션 자신의 worktree run이 H1·H2 보호 없이 통째로 무방비가 된다(CR-003).
//    ①의 "먼저"는 cwdRoot 안에서의 우선순위다 — 바인딩 파일은 cwdRoot 아래에서만 찾으므로, cwd가 이미 어떤
//    worktree 안이면 main root의 바인딩은 조회되지 않는다(그 경우 ②가 옳은 답을 낸다).
// ② 바인딩이 없거나 workroot가 사라졌으면(정리됨 등) findRoot 그대로 — 여기엔 "세션이 이미 worktree 안에서
//    시작"(findRoot이 그 `.git`에서 멈춤)과 "비-worktree run(quick 트랙 등)·비활성" 둘 다 하위호환으로 흡수된다.
// ③ ②로 떨어졌는데 cwdRoot 자신에는 활성 run이 없고 등록된 run worktree가 **정확히 1개**면 그걸 쓴다. 세션
//    id가 바뀌어(resume 등) 바인딩 조회가 실패하는 경우가 여기 걸린다 — 그대로 두면 활성 root가 main으로
//    떨어져 capture가 deny되는 동시에 H1·H2 게이트가 통째로 풀린다(관측된 증상). 2개 이상이면 어느 run인지
//    결정할 근거가 없으므로 ②를 유지한다. 새 상태 파일 없이, 오늘 이미 오답을 내는 경로에서만 발동한다.
export function resolveRoot(cwd, sessionId) {
  const cwdRoot = findRoot(cwd)
  const b = sessionId ? readSessionBinding(cwdRoot, sessionId) : null
  if (b && existsSync(b.workroot)) return b.workroot
  if (!existsSync(join(cwdRoot, ".harnie", "active.json"))) {
    const runs = listActiveRunWorktrees(cwdRoot)
    if (runs.length === 1) return runs[0].worktreePath
  }
  return cwdRoot
}

export function sentinelSessionIds(root) {
  try {
    const s = JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8"))
    if (Array.isArray(s && s.sessionIds)) return s.sessionIds.filter((x) => typeof x === "string" && x !== "")
    return s && typeof s.sessionId === "string" && s.sessionId ? [s.sessionId] : []
  } catch { return [] }
}

// 활성 run 워크트리 레지스트리(0.13 T8, 2026-08-26 워크트리 삭제 사고 대응). worktree-per-run(T2)에서 각 run은
// `<mainRoot>/.harnie-wt/<dir>`에 자기 `.harnie/active.json`을 갖는다. 이 스캔은 새 상태 파일 없이 그 디렉터리를
// 훑어 등록된(= active.json이 있는) run만 모은다 — 완료 여부는 보지 않는다: 정리는 항상 worktree.mjs remove(신뢰
// CLI)로 하게 하는 편이, 완료 판정을 여기 복제하는 것보다 간단하고 안전하다. 브랜치명은 새 필드를 추가하지 않고
// bootstrap이 항상 `harnie/<slug>`로 만드는 결정적 관례에서 파생한다(hooks/bootstrap.mjs, execution.mjs
// initCliAuthority — 두 프로덕션 생성 경로가 모두 이 규칙을 따른다).
export function listActiveRunWorktrees(mainRoot) {
  const container = join(mainRoot, ".harnie-wt")
  if (!existsSync(container)) return []
  const out = []
  for (const name of readdirSync(container)) {
    const activePath = join(container, name, ".harnie", "active.json")
    if (!existsSync(activePath)) continue
    try {
      const s = JSON.parse(readFileSync(activePath, "utf8"))
      if (s && typeof s.slug === "string" && s.slug)
        out.push({ worktreePath: join(container, name), slug: s.slug, branch: `harnie/${s.slug}` })
    } catch { /* 손상된 active.json은 등록 대상에서 제외 — 이 스캔은 advisory deny 입력일 뿐 권위 판정이 아니다 */ }
  }
  return out
}

// Every session that entered or resumed the run remains an owner until completion.
// owner 미기록 sentinel(구버전 스키마·stale run)은 식별된 세션을 잠그지 않는다 — 과거 "빈 목록 = 전원 owner"
// 폴백은 harnie를 실행한 적 없는 세션의 소스 쓰기까지 워크스페이스 단위로 잠갔다(실측 사고). 그런 run을
// 실제로 재개(bootstrap)하면 그 세션이 owner로 기록되어 게이트가 다시 붙는다. session_id 없는 payload는
// 구분할 방법이 없으므로 fail-closed(owner 취급) 유지.
export function isOwnerSession(root, ctx, sessionId) {
  const fromCtx = ctx && Array.isArray(ctx.sessionIds) && ctx.sessionIds.length ? ctx.sessionIds : null
  const owners = fromCtx || sentinelSessionIds(root)
  if (!sessionId) return true
  if (!owners.length) return false
  return owners.includes(sessionId)
}

export function classifyCodex(toolName) {
  const t = String(toolName || "")
  const isCodex = /(?:^|__)codex(?:-reply)?$/.test(t)
  const isReply = /(?:^|__)codex-reply$/.test(t)
  return { isCodex, isReply }
}

export function extractThreadId(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj || {})
  const m = s.match(/"threadId"\s*:\s*"([^"]+)"/)
  if (m) return m[1]
  const uuid = s.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
  return uuid ? uuid[0] : null
}

export function extractSelectedAnswers(response) {
  if (response == null) return []
  if (typeof response === "string") {
    const s = response.trim()
    if (s.startsWith("{") || s.startsWith("[")) { try { return extractSelectedAnswers(JSON.parse(s)) } catch { /* not JSON */ } }
    return [response]
  }
  const vals = []
  const push = (v) => { if (typeof v === "string") vals.push(v); else if (v && typeof v === "object") vals.push(...Object.values(v).filter((x) => typeof x === "string")) }
  if (Array.isArray(response)) response.forEach(push)
  else if (response.answers != null) { const a = response.answers; Array.isArray(a) ? a.forEach(push) : push(a) }
  else if (typeof response === "object") {
    for (const v of Object.values(response)) push(v)
  }
  return vals
}

export function denyPreTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n")
  process.exit(0)
}

export function allow() { process.exit(0) }

export function allowPreTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason },
  }) + "\n")
  process.exit(0)
}

export function allowPostTool(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
  }) + "\n")
  process.exit(0)
}

export function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n")
  process.exit(0)
}
