// harnie 훅 엔트리 공용 헬퍼 — stdin 파싱 + repo root 탐색 + 결정 emit.
// 실제 결정 로직은 scripts/guards.mjs·execution.mjs(순수/테스트됨)에 있고, 여기선 배선만 한다.
import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { join, dirname, resolve, basename, relative, sep, isAbsolute } from "node:path"

const isOutsideRel = (rel) => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)

// Write/Edit 대상의 **symlink-해소 canonical 경로**를 repo root 기준 상대로.
// 가장 가까운 기존 부모의 realpath로 symlink를 해소하고 남은 꼬리를 붙인다(존재하지 않는 대상 파일도 처리).
// repo 밖으로 나가는 두 경우를 **구분**한다(둘은 상호배타):
//   escapes = repo 기준으로 해석되는 경로가 밖을 가리킴(symlink 우회 + **상대경로 `../` traversal**) → 차단 대상.
//   outside = 입력이 애초에 repo 밖 **절대경로**(예: ~/.claude/*, 스크래치패드) → run의 소스가 아니므로 phase 게이트 대상 아님.
// 상대경로는 정의상 run root 기준 해석이므로 밖으로 새는 것 자체가 우회다 → outside 아님(escapes 유지).
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
  // 입력의 lexical 위치 판정 — root가 symlink(/tmp→/private/tmp)일 수 있어 lexical root·realRoot 둘 다에서 밖일 때만 밖으로 본다.
  const lexOutside = isOutsideRel(relative(resolve(root), abs)) && isOutsideRel(relative(realRoot, abs))
  const canonOutside = isOutsideRel(rel)
  const outside = canonOutside && lexOutside && isAbsolute(filePath)
  return { rel: rel.split(sep).join("/"), abs: real, escapes: canonOutside && !outside, outside }
}

// repo 밖 경로라도 **다른 harnie run의 권위 파일**은 계속 보호한다: canonical 절대경로에서 마지막 `.harnie/`
// 조각을 잘라 control 규칙(guards.isControlPath)으로 검사할 수 있게 반환한다. `.harnie`가 없으면 null.
export function harnieControlSuffix(absPath) {
  const p = String(absPath || "").replace(/\\/g, "/")
  const i = p.toLowerCase().lastIndexOf("/.harnie/")
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
    // stdin이 안 열리는 환경 방어
    if (process.stdin.isTTY) res({})
  })
}

// cwd에서 상향 탐색해 `.harnie/active.json`(우선) 또는 `.git`을 가진 디렉터리를 repo root로.
// **git repo 경계에서 탐색 중단**: `.git`을 만나면 그 디렉터리가 root다. 즉 `.harnie/active.json`은
// 현재 git repo 안에서만 유효하며, 포인터가 없다고 부모 워크스페이스의 run에 바인딩되지 않는다
// (그 경우 phase·containment·escapes 판정이 전부 다른 repo 기준으로 틀어졌다).
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
// worktree 생성 후 기록하고, run 종료(completion) 시 정리한다. 세션의 cwd는 계속 main 작업트리이므로,
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
// ② 바인딩이 없거나 workroot가 사라졌으면(정리됨 등) findRoot 그대로 — 여기엔 "세션이 이미 worktree 안에서
//    시작"(findRoot이 그 `.git`에서 멈춤)과 "비-worktree run(quick 트랙 등)·비활성" 둘 다 하위호환으로 흡수된다.
export function resolveRoot(cwd, sessionId) {
  const cwdRoot = findRoot(cwd)
  const b = sessionId ? readSessionBinding(cwdRoot, sessionId) : null
  return b && existsSync(b.workroot) ? b.workroot : cwdRoot
}

// active run에 **진입·재개한 소유 세션 집합**을 sentinel에서 직접 읽는다(기록이 없으면 []).
// 컨텍스트(loadContext)가 소유자를 노출하지 않는 경우 — 구버전 sentinel·부분 통합·손상 상태의 축약된
// 반환 형태 — 를 위한 폴백이다. 레거시 스칼라 `sessionId`도 1개 집합으로 취급한다.
export function sentinelSessionIds(root) {
  try {
    const s = JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8"))
    if (Array.isArray(s && s.sessionIds)) return s.sessionIds.filter((x) => typeof x === "string" && x !== "")
    return s && typeof s.sessionId === "string" && s.sessionId ? [s.sessionId] : []
  } catch { return [] }
}

// 이 세션이 active run의 **소유 세션 중 하나**인가. run 단위 게이트(H1 phase·H2 완료·PostToolUse 관찰)를 owner로
// 좁혀 같은 repo에 우연히 있는 무관한 세션이 차단되거나 owner run 상태를 오염시키지 않게 한다.
// **membership**인 이유: 소유자를 하나만 두고 resume이 교체하면, 아직 작업 중인 이전 소유 세션이 그 즉시
// 비-owner가 되어 보호가 전부 풀린다(세션 종료를 확인할 증거가 없다). 진입·재개한 세션은 모두 계속 owner다.
// sentinel에 소유자가 없거나(구버전) payload에 session_id가 없으면 하위호환·보수적으로 owner 취급(=전역 적용).
export function isOwnerSession(root, ctx, sessionId) {
  const fromCtx = ctx && Array.isArray(ctx.sessionIds) && ctx.sessionIds.length ? ctx.sessionIds : null
  const owners = fromCtx || sentinelSessionIds(root)
  if (!owners.length || !sessionId) return true
  return owners.includes(sessionId)
}

// codex MCP 툴명 판별(플러그인/로컬 양형). isReply = codex-reply.
export function classifyCodex(toolName) {
  const t = String(toolName || "")
  const isCodex = /(?:^|__)codex(?:-reply)?$/.test(t)
  const isReply = /(?:^|__)codex-reply$/.test(t)
  return { isCodex, isReply }
}

// tool_response/tool_input에서 threadId 추출(codex 성공 관찰용).
export function extractThreadId(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj || {})
  const m = s.match(/"threadId"\s*:\s*"([^"]+)"/)
  if (m) return m[1]
  const uuid = s.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
  return uuid ? uuid[0] : null
}

// AskUserQuestion 응답에서 **선택된 답 값만** 추출(질문 텍스트 제외 — 질문에 "승인"이 있어도 오탐 안 되게).
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
    // content 배열(MCP 형태) 등 — 문자열 값만 긁되 최상위 값만(키=질문 제외).
    for (const v of Object.values(response)) push(v)
  }
  return vals
}

// PreToolUse deny emit(현행 hookSpecificOutput 계약). allow는 무출력 exit 0.
export function denyPreTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n")
  process.exit(0)
}
export function allow() { process.exit(0) }

// PreToolUse auto-allow emit(프롬프트 skip). 무의견 exit 0(allow())과 구분 — 이건 명시적 allow 결정.
// user·project의 deny/ask 규칙은 여전히 우선하므로 사용자 통제는 유지된다.
export function allowPreTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason },
  }) + "\n")
  process.exit(0)
}

// Stop block emit.
export function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n")
  process.exit(0)
}
