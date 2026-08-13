#!/usr/bin/env node
// harnie worktree 엔진(T2, DEC-001) — run별 git worktree 생성·병합·제거.
// 위협모델 §0.1: 실수하는 오케스트레이터의 실수 방지가 목적. execution.mjs 수준의 방어 계층은 두지 않고
// 단순 인자 검증 + git 종료코드 전파만 한다(과설계 지양, T2 프롬프트 §1).
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs"
import { join, dirname, resolve, isAbsolute } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

function die(msg) { process.stderr.write(`harnie-worktree: ${msg}\n`); process.exit(2) }
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n") }

function git(repo, args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }) }
function gitStatus(repo, args) { return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }) }

// 브랜치명을 worktree 디렉터리 이름으로(디렉터리에 못 쓰는 `/`를 안전하게 변환). 예: harnie/foo → harnie-foo.
export function sanitizeBranchForDir(branch) {
  return String(branch).replace(/[\\/]/g, "-")
}
export function worktreeDirFor(repo, branch) {
  return join(repo, ".harnie-wt", sanitizeBranchForDir(branch))
}

// repo(평범한 repo든 그 worktree든) 공용 gitdir — info/exclude는 worktree 간 공유된 파일 하나뿐이다.
function gitCommonDir(repo) {
  const raw = git(repo, ["rev-parse", "--git-common-dir"]).trim()
  return isAbsolute(raw) ? raw : resolve(repo, raw)
}

// `.harnie-wt/`만 info/exclude에 멱등 등록한다(커밋 불필요·.gitignore 비침습). main root의 tree 캡처가
// nested worktree를 embedded content로 걷지 않게 하는 데 필요한 항목이다. `.harnie/`는 delta.mjs의
// captureTree pathspec이 이미 제외하며, gitignore-style exclude에도 넣으면 그 명시 pathspec의 `git add`가
// ignored-path 오류로 실패하므로 여기에 추가하면 안 된다.
export function ensureExcludeEntries(repo) {
  const excludePath = join(gitCommonDir(repo), "info", "exclude")
  mkdirSync(dirname(excludePath), { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
  const rawLines = existing.split("\n")
  const removed = rawLines.includes(".harnie/")
  const lines = rawLines.filter((line) => line !== ".harnie/") // pre-fix durable entry migration
  const need = [".harnie-wt/"].filter((e) => !lines.includes(e))
  let next = lines.join("\n")
  if (need.length) {
    const sep = next.length && !next.endsWith("\n") ? "\n" : ""
    next += sep + need.join("\n") + "\n"
  }
  if (next !== existing) writeFileSync(excludePath, next)
  return { excludePath, added: need, removed: removed ? [".harnie/"] : [] }
}

function branchExists(repo, branch) {
  return gitStatus(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0
}
function listWorktrees(repo) {
  const raw = git(repo, ["worktree", "list", "--porcelain"])
  const entries = []
  let cur = null
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) { if (cur) entries.push(cur); cur = { path: line.slice("worktree ".length) } }
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
  }
  if (cur) entries.push(cur)
  return entries
}

// macOS `/var/...` → `/private/var/...`처럼 tmpdir가 symlink인 경우가 있어, git이 보고하는 worktree 경로와
// 우리가 계산한 경로가 realpath에서만 일치할 수 있다. 존재하지 않는 경로는 resolve로 폴백.
function realOrResolve(p) { try { return realpathSync(p) } catch { return resolve(p) } }

// create --repo <abs> --branch <name> [--from <ref>] : <repo>/.harnie-wt/<sanitized-branch>에 worktree 생성
// (이미 있으면 attach). from 생략 시 git 기본대로 repo의 현재 HEAD에서 분기(사용자 현재 브랜치).
export function createWorktree({ repo, branch, from = null }) {
  if (!repo || typeof repo !== "string") throw new Error("--repo 필요")
  if (!isAbsolute(repo)) throw new Error(`--repo는 절대경로여야 함: ${repo}`)
  if (!branch || typeof branch !== "string") throw new Error("--branch 필요")
  ensureExcludeEntries(repo)
  const dir = worktreeDirFor(repo, branch)
  const existingWt = listWorktrees(repo).find((w) => realOrResolve(w.path) === realOrResolve(dir))
  if (existingWt) {
    if (existingWt.branch && existingWt.branch !== branch)
      throw new Error(`worktree 경로 충돌: ${dir}는 이미 다른 브랜치(${existingWt.branch})에 연결됨`)
    return { worktreePath: dir, created: false }
  }
  if (existsSync(dir)) throw new Error(`worktree 디렉터리가 이미 존재하나 git worktree 목록에 없음(손상 가능성): ${dir}`)
  const args = branchExists(repo, branch)
    ? ["worktree", "add", dir, branch]                                    // 기존 브랜치에 attach
    : (from ? ["worktree", "add", "-b", branch, dir, from] : ["worktree", "add", "-b", branch, dir])
  const r = gitStatus(repo, args)
  if (r.status !== 0) throw new Error(`git worktree add 실패(exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`)
  return { worktreePath: dir, created: true }
}

// merge --repo <abs> --branch <name> --into <ref> : repo(=into가 체크아웃된 run worktree)에서 git merge --no-ff <branch>.
// 충돌 시 merge를 중단하지 않고 남긴 채 {ok:false, conflicts:[...]}를 반환 — 오케스트레이터가 해결.
export function mergeWorktree({ repo, branch, into }) {
  if (!repo || typeof repo !== "string") throw new Error("--repo 필요")
  if (!branch || typeof branch !== "string") throw new Error("--branch 필요")
  if (!into || typeof into !== "string") throw new Error("--into 필요")
  const current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
  if (current !== into) throw new Error(`merge 대상 불일치: ${repo}의 현재 체크아웃은 ${current}(기대 ${into}) — 먼저 ${into}로 checkout하세요`)
  const r = gitStatus(repo, ["merge", "--no-ff", "--no-edit", branch])
  if (r.status === 0) return { ok: true, conflicts: [] }
  const cf = gitStatus(repo, ["diff", "--name-only", "--diff-filter=U"])
  const conflicts = (cf.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)
  return { ok: false, conflicts, stderr: (r.stderr || r.stdout || "").trim() }
}

// remove --repo <abs> --branch <name> [--delete-branch] : worktree 제거. **기본은 브랜치 유지**(T2 스펙 §1)
// — 브랜치까지 지우려면 --delete-branch를 명시(-d, 안전삭제 — 미병합 커밋이 있으면 git이 거부해 fail-closed).
// 기본을 "삭제"로 두면 흔한 정리 케이스(미완료·미병합 run 정리)에서 worktree는 이미 지워졌는데 branch -d만
// 실패해 부분 상태 + 오해하기 쉬운 에러가 남는다 — 기본 유지가 그 부분-실패 창을 없앤다.
export function removeWorktree({ repo, branch, deleteBranch = false }) {
  if (!repo || typeof repo !== "string") throw new Error("--repo 필요")
  if (!branch || typeof branch !== "string") throw new Error("--branch 필요")
  const dir = worktreeDirFor(repo, branch)
  const r = gitStatus(repo, ["worktree", "remove", dir])
  if (r.status !== 0) throw new Error(`git worktree remove 실패(exit ${r.status}, 미커밋 변경 등 확인): ${(r.stderr || r.stdout || "").trim()}`)
  if (deleteBranch) {
    const rb = gitStatus(repo, ["branch", "-d", branch])
    if (rb.status !== 0) throw new Error(`git branch -d 실패(exit ${rb.status}, 미병합 커밋 등 확인): ${(rb.stderr || rb.stdout || "").trim()}`)
  }
  return { ok: true }
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) flags[key] = true // 값 없는 boolean 플래그(--delete-branch)
      else { flags[key] = next; i++ }
    } else pos.push(a)
  }
  return { flags, pos }
}

function cmdCreate({ flags }) {
  try { out(createWorktree({ repo: flags.repo, branch: flags.branch, from: flags.from || null })) }
  catch (e) { die(e.message) }
}
function cmdMerge({ flags }) {
  let r
  try { r = mergeWorktree({ repo: flags.repo, branch: flags.branch, into: flags.into }) }
  catch (e) { die(e.message) }
  out(r)
  if (!r.ok) process.exit(3)
}
function cmdRemove({ flags }) {
  try { out(removeWorktree({ repo: flags.repo, branch: flags.branch, deleteBranch: flags["delete-branch"] === true })) }
  catch (e) { die(e.message) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , sub, ...rest] = process.argv
  const args = parseArgs(rest)
  switch (sub) {
    case "create": cmdCreate(args); break
    case "merge": cmdMerge(args); break
    case "remove": cmdRemove(args); break
    default: die(`알 수 없는 서브커맨드: ${sub ?? "(none)"}`)
  }
}
