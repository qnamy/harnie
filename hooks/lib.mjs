// harnie 훅 엔트리 공용 헬퍼 — stdin 파싱 + repo root 탐색 + 결정 emit.
// 실제 결정 로직은 scripts/guards.mjs·execution.mjs(순수/테스트됨)에 있고, 여기선 배선만 한다.
import { existsSync, realpathSync } from "node:fs"
import { join, dirname, resolve, basename, relative, sep, isAbsolute } from "node:path"

// Write/Edit 대상의 **symlink-해소 canonical 경로**를 repo root 기준 상대로. escapes=repo 밖(traversal·symlink) 여부.
// 가장 가까운 기존 부모의 realpath로 symlink를 해소하고 남은 꼬리를 붙인다(존재하지 않는 대상 파일도 처리).
export function canonicalRelPath(root, filePath) {
  if (!filePath) return { rel: "", escapes: false }
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  let dir = abs
  const tail = []
  while (!existsSync(dir) && dirname(dir) !== dir) { tail.unshift(basename(dir)); dir = dirname(dir) }
  const realParent = existsSync(dir) ? realpathSync(dir) : dir
  const real = tail.length ? join(realParent, ...tail) : realParent
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
  const rel = relative(realRoot, real)
  return { rel: rel.split(sep).join("/"), escapes: rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) }
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
export function findRoot(startCwd) {
  let dir = resolve(startCwd || process.cwd())
  let gitRoot = null
  for (;;) {
    if (existsSync(join(dir, ".harnie", "active.json"))) return dir
    if (gitRoot === null && existsSync(join(dir, ".git"))) gitRoot = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return gitRoot || resolve(startCwd || process.cwd())
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
