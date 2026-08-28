import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname, resolve, basename, relative, sep, isAbsolute } from "node:path"
import { execFileSync } from "node:child_process"

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

// run root = 세션 cwd에서 가장 가까운 git repo root(0.14 D1). 우선순위는 체인 전체에 걸린다 — 상향 탐색
// 어디서든 `.git`을 만나면 그것이 답이고, `.harnie/active.json`은 git root가 하나도 없을 때의 폴백이다.
// 두 검사를 같은 반복 안에서 순서만 바꾸면 아무것도 달라지지 않는다(둘이 같은 디렉터리에 있으면 답이 같다).
// 실제로 갈리는 것은 하위 디렉터리에 남은 stale `.harnie/`와 상위의 git root가 경쟁하는 경우다.
export function findRoot(startCwd) {
  const start = resolve(startCwd || process.cwd())
  let dir = start
  let harnieFallback = null
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    if (harnieFallback === null && existsSync(join(dir, ".harnie", "active.json"))) harnieFallback = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return harnieFallback || start
}

// `.git/info/exclude`에 한 항목을 멱등 등록한다(커밋 불필요·.gitignore 비침습). run root가 사용자 작업
// 트리인 0.14에서는 `.harnie/`가 이 트리 안에 살므로, 등록하지 않으면 `git add -A`가 run 제어 상태를 사용자
// 브랜치에 커밋한다. Bash 가드는 문자열 매칭이라 그 실수를 원리적으로 잡지 못한다(설계 §8).
// info/exclude는 worktree 간 공유된 파일 하나뿐이므로 공용 gitdir에서 찾는다.
export function ensureExcludeEntries(repo, entry) {
  const raw = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()
  const excludePath = join(isAbsolute(raw) ? raw : resolve(repo, raw), "info", "exclude")
  mkdirSync(dirname(excludePath), { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
  if (existing.split("\n").includes(entry)) return { excludePath, added: [] }
  const sep = existing.length && !existing.endsWith("\n") ? "\n" : ""
  writeFileSync(excludePath, existing + sep + entry + "\n")
  return { excludePath, added: [entry] }
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
