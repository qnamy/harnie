#!/usr/bin/env node
// harnie worktree 엔진(T2, DEC-001) — run별 git worktree 생성·병합·제거.
// 위협모델 §0.1: 실수하는 오케스트레이터의 실수 방지가 목적. execution.mjs 수준의 방어 계층은 두지 않고
// 단순 인자 검증 + git 종료코드 전파만 한다(과설계 지양, T2 프롬프트 §1).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, renameSync, rmSync } from "node:fs"
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
function assertWithinContainer(repo, dir) {
  if (dirname(dir) !== join(repo, ".harnie-wt"))
    throw new Error(`worktree 경로가 .harnie-wt 컨테이너를 벗어남: ${dir}`)
}

// repo(평범한 repo든 그 worktree든) 공용 gitdir — info/exclude는 worktree 간 공유된 파일 하나뿐이다.
function gitCommonDir(repo) {
  const raw = git(repo, ["rev-parse", "--git-common-dir"]).trim()
  return isAbsolute(raw) ? raw : resolve(repo, raw)
}

// `.harnie-wt/`만 info/exclude에 멱등 등록한다(커밋 불필요·.gitignore 비침습). main root의 tree 캡처가
// nested worktree를 embedded content로 걷지 않게 하는 데 필요한 항목이다. `.harnie/`는 delta.mjs의
// captureTree가 이제 add 후 `git rm --cached --ignore-unmatch`로 제외한다(과거엔 exclude pathspec을 썼고,
// `.harnie/`가 .gitignore에도 등재돼 있으면 그 pathspec이 ignored-path 오류로 실패했다 — delta.mjs가
// 두 단계 방식으로 고쳤다). 그 실패 제약은 사라졌지만, 그렇다고 `.harnie/`를 여기 info/exclude에 추가로
// 넣을 필요가 생기는 것도 아니다(추가해도 무해하지만 아무 것도 얻지 못한다) — 불필요한 복잡도를 만들지 않는다.
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
  const dir = worktreeDirFor(repo, branch)
  assertWithinContainer(repo, dir)
  ensureExcludeEntries(repo)
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

function archiveTarget({ repo, branch, archiveTo }) {
  if (!isAbsolute(archiveTo)) throw new Error(`--archive-to는 절대경로여야 함: ${archiveTo}`)
  const activePath = join(archiveTo, ".harnie", "active.json")
  if (!existsSync(activePath)) throw new Error(`--archive-to에 active run sentinel 없음: ${archiveTo}`)
  const sentinel = JSON.parse(readFileSync(activePath, "utf8"))
  if (!sentinel || sentinel.track !== "plan" || typeof sentinel.slug !== "string") throw new Error(`--archive-to sentinel 손상/비-plan run: ${archiveTo}`)
  const realRepo = realOrResolve(repo), realArchive = realOrResolve(archiveTo)
  if (sentinel.workspaceRoot) {
    const registered = Object.values(sentinel.repos || {}).some((r) => r && realOrResolve(r.workroot) === realRepo)
    if (!registered) throw new Error(`--repo가 archive run의 등록 멤버 workroot가 아님: ${repo}`)
  } else if (realRepo !== realArchive) throw new Error(`--repo가 archive run의 single repo workroot가 아님: ${repo}`)
  const prefix = `harnie/${sentinel.slug}-t`
  if (!branch.startsWith(prefix) || branch.length === prefix.length) throw new Error(`--branch가 archive run slug의 task branch가 아님: ${branch}`)
  const taskId = branch.slice(prefix.length)
  const manifestPath = join(archiveTo, ".harnie", "plan", sentinel.slug, "manifest.json")
  if (!existsSync(manifestPath)) throw new Error(`archive run manifest 없음: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.some((t) => t && t.id === taskId))
    throw new Error(`branch task ${taskId}가 archive run manifest에 없음`)
  return { slug: sentinel.slug, taskId, destination: join(archiveTo, ".harnie", "plan", sentinel.slug, "review-archive", `t${taskId}`) }
}

// remove --repo <abs> --branch <name> [--delete-branch] : worktree 제거. **기본은 브랜치 유지**(T2 스펙 §1)
// — 브랜치까지 지우려면 --delete-branch를 명시(-d, 안전삭제 — 미병합 커밋이 있으면 git이 거부해 fail-closed).
// 기본을 "삭제"로 두면 흔한 정리 케이스(미완료·미병합 run 정리)에서 worktree는 이미 지워졌는데 branch -d만
// 실패해 부분 상태 + 오해하기 쉬운 에러가 남는다 — 기본 유지가 그 부분-실패 창을 없앤다.
export function removeWorktree({ repo, branch, deleteBranch = false, archiveTo = null }) {
  if (!repo || typeof repo !== "string") throw new Error("--repo 필요")
  if (!branch || typeof branch !== "string") throw new Error("--branch 필요")
  const dir = worktreeDirFor(repo, branch)
  assertWithinContainer(repo, dir)
  const harniePath = join(dir, ".harnie")
  const reviewPath = join(harniePath, "review")
  let archive = null, archivedNow = false
  if (archiveTo) {
    archive = archiveTarget({ repo, branch, archiveTo })
    const temp = archive.destination + ".tmp"
    if (existsSync(temp)) {
      if (existsSync(archive.destination)) rmSync(temp, { recursive: true, force: true })
      else renameSync(temp, archive.destination)
    }
    if (existsSync(reviewPath)) {
      rmSync(temp, { recursive: true, force: true })
      if (existsSync(archive.destination)) rmSync(archive.destination, { recursive: true, force: true })
      mkdirSync(dirname(archive.destination), { recursive: true })
      try {
        renameSync(reviewPath, temp)
        renameSync(temp, archive.destination)
        archivedNow = true
      } catch (e) {
        if (existsSync(temp) && !existsSync(reviewPath)) {
          mkdirSync(dirname(reviewPath), { recursive: true })
          renameSync(temp, reviewPath)
        }
        throw new Error(`review archive 이관 실패: ${e.message}`)
      }
    }
    if (!existsSync(dir) && existsSync(archive.destination)) return { ok: true, archive: archive.destination }
  }
  const hasRunState = [join(harniePath, "active.json"), join(harniePath, "plan"), join(harniePath, "quick")].some(existsSync)
  const status = gitStatus(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const changes = (status.stdout || "").split("\0").filter(Boolean)
  const onlyHarnie = status.status === 0 && changes.every((entry) => {
    const p = entry.length > 3 && entry[2] === " " ? entry.slice(3) : entry
    return p === ".harnie" || p.startsWith(".harnie/")
  })
  // 이동→remove→(성공 시만)스태시 삭제/실패 시 원복 — 유일본은 remove 성공 前엔 어느 시점에도 지워지지 않는다.
  // 두 rename 사이에 프로세스가 죽으면 `.harnie-wt/.harnie-stash-*`에 고아로 남을 수 있으나(데이터 소실은 아님),
  // 복구 경로는 그 디렉터리를 그대로 `<dir>/.harnie`로 옮기는 것뿐이다(§0.1: 적대적 방어·프로세스 크래시 복구는 비목표).
  let stashRoot = null, stashPath = null
  if (existsSync(harniePath) && !hasRunState && onlyHarnie) {
    stashRoot = mkdtempSync(join(repo, ".harnie-wt", ".harnie-stash-"))
    stashPath = join(stashRoot, ".harnie")
    renameSync(harniePath, stashPath)
  }
  const r = gitStatus(repo, ["worktree", "remove", dir])
  if (r.status !== 0) {
    if (stashPath) {
      renameSync(stashPath, harniePath)
      rmSync(stashRoot, { recursive: true, force: true })
    }
    if (archivedNow && archive && existsSync(archive.destination)) {
      mkdirSync(dirname(reviewPath), { recursive: true })
      renameSync(archive.destination, reviewPath)
    }
    throw new Error(`git worktree remove 실패(exit ${r.status}, 미커밋 변경 등 확인): ${(r.stderr || r.stdout || "").trim()}`)
  }
  if (stashRoot) rmSync(stashRoot, { recursive: true, force: true })
  if (deleteBranch) {
    const rb = gitStatus(repo, ["branch", "-d", branch])
    if (rb.status !== 0) throw new Error(`git branch -d 실패(exit ${rb.status}, 미병합 커밋 등 확인): ${(rb.stderr || rb.stdout || "").trim()}`)
  }
  return { ok: true, ...(archive ? { archive: archive.destination } : {}) }
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
  try { out(removeWorktree({ repo: flags.repo, branch: flags.branch, deleteBranch: flags["delete-branch"] === true, archiveTo: flags["archive-to"] || null })) }
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
