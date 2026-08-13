import { existsSync, realpathSync, readFileSync } from "node:fs"
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

export function sentinelSessionIds(root) {
  try {
    const s = JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8"))
    if (Array.isArray(s && s.sessionIds)) return s.sessionIds.filter((x) => typeof x === "string" && x !== "")
    return s && typeof s.sessionId === "string" && s.sessionId ? [s.sessionId] : []
  } catch { return [] }
}

// Every session that entered or resumed the run remains an owner until completion.
export function isOwnerSession(root, ctx, sessionId) {
  const fromCtx = ctx && Array.isArray(ctx.sessionIds) && ctx.sessionIds.length ? ctx.sessionIds : null
  const owners = fromCtx || sentinelSessionIds(root)
  if (!owners.length || !sessionId) return true
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

export function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n")
  process.exit(0)
}
