// worktree.mjs 테스트 — create/merge(충돌 포함)/remove, exclude 등록 멱등성.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createWorktree, mergeWorktree, removeWorktree, ensureExcludeEntries, worktreeDirFor, sanitizeBranchForDir } from "./worktree.mjs"
import { captureTree } from "./delta.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, "worktree.mjs")

function run(args) { return JSON.parse(execFileSync("node", [CLI, ...args], { encoding: "utf8" })) }
function runFail(args) {
  try { execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: "pipe" }); return null }
  catch (e) { return e }
}
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "harnie-wt-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", root, "config", "user.name", "t"])
  writeFileSync(join(root, "README.md"), "hello\n")
  execFileSync("git", ["-C", root, "add", "."])
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"])
  return root
}

test("sanitizeBranchForDir: 슬래시를 안전하게 치환", () => {
  assert.equal(sanitizeBranchForDir("harnie/foo-bar"), "harnie-foo-bar")
  assert.equal(worktreeDirFor("/repo", "harnie/x"), join("/repo", ".harnie-wt", "harnie-x"))
})

test("create: 신규 worktree 생성 + exclude 등록", () => {
  const repo = gitRepo()
  const r = createWorktree({ repo, branch: "harnie/feat-x" })
  assert.equal(r.created, true)
  assert.ok(existsSync(r.worktreePath))
  assert.ok(existsSync(join(r.worktreePath, ".git"))) // worktree gitlink 파일
  assert.ok(existsSync(join(r.worktreePath, "README.md"))) // from(HEAD) 내용 반영
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8")
  assert.match(exclude, /\.harnie-wt\//)
  assert.doesNotMatch(exclude, /^\.harnie\/$/m)
  // `.harnie/` must remain unignored: captureTree excludes it with an explicit pathspec, which fails if it is ignored.
  mkdirSync(join(r.worktreePath, ".harnie"), { recursive: true })
  writeFileSync(join(r.worktreePath, ".harnie", "active.json"), "{}\n")
  assert.match(captureTree(r.worktreePath), /^[0-9a-f]{40}$/)
  assert.match(captureTree(repo), /^[0-9a-f]{40}$/) // nested worktree container itself is ignored
})

test("create: 이미 존재하는 worktree는 attach(created:false, 멱등)", () => {
  const repo = gitRepo()
  const a = createWorktree({ repo, branch: "harnie/feat-y" })
  const b = createWorktree({ repo, branch: "harnie/feat-y" })
  assert.equal(a.worktreePath, b.worktreePath)
  assert.equal(b.created, false)
})

test("create: 다른 브랜치가 이미 그 경로를 쓰면 충돌 에러", () => {
  const repo = gitRepo()
  createWorktree({ repo, branch: "harnie/dup" })
  // 같은 sanitized 경로를 만드는 다른 브랜치명(슬래시 위치만 다름)로 재시도
  assert.throws(() => createWorktree({ repo, branch: "harnie-dup" }), /충돌/)
})

test("create: exclude 등록은 멱등(중복 라인 없음)", () => {
  const repo = gitRepo()
  const excludePath = join(repo, ".git", "info", "exclude")
  writeFileSync(excludePath, readFileSync(excludePath, "utf8") + "custom-entry\n.harnie/\n")
  ensureExcludeEntries(repo)
  ensureExcludeEntries(repo)
  const exclude = readFileSync(excludePath, "utf8")
  const wtLines = exclude.split("\n").filter((l) => l === ".harnie-wt/")
  assert.equal(wtLines.length, 1)
  assert.doesNotMatch(exclude, /^\.harnie\/$/m)
  assert.match(exclude, /^custom-entry$/m) // unrelated user entry preserved
})

test("create: --from 지정 시 그 ref에서 분기", () => {
  const repo = gitRepo()
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "other"])
  writeFileSync(join(repo, "other.txt"), "x")
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "other commit"])
  execFileSync("git", ["-C", repo, "checkout", "-q", "-"]) // 원래 브랜치로
  const r = createWorktree({ repo, branch: "harnie/from-other", from: "other" })
  assert.ok(existsSync(join(r.worktreePath, "other.txt")))
})

test("merge: 충돌 없는 병합은 --no-ff 커밋 생성", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/task-a" }).worktreePath
  writeFileSync(join(wt, "a.txt"), "a")
  execFileSync("git", ["-C", wt, "add", "."])
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "add a"])
  const baseBranch = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()
  const r = mergeWorktree({ repo, branch: "harnie/task-a", into: baseBranch })
  assert.equal(r.ok, true)
  assert.ok(existsSync(join(repo, "a.txt")))
  const log = execFileSync("git", ["-C", repo, "log", "-1", "--merges", "--pretty=%P"], { encoding: "utf8" })
  assert.ok(log.trim().split(" ").length >= 2) // 병합 커밋(부모 2개) — --no-ff 확인
})

test("merge: 충돌은 exit 3 + 충돌 파일 목록, merge 중단하지 않고 남김", () => {
  const repo = gitRepo()
  writeFileSync(join(repo, "shared.txt"), "base\n")
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "shared base"])
  const baseBranch = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()
  const wt = createWorktree({ repo, branch: "harnie/conflict" }).worktreePath
  writeFileSync(join(wt, "shared.txt"), "from task\n")
  execFileSync("git", ["-C", wt, "commit", "-q", "-am", "task change"])
  writeFileSync(join(repo, "shared.txt"), "from main\n")
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "main change"])
  const r = mergeWorktree({ repo, branch: "harnie/conflict", into: baseBranch })
  assert.equal(r.ok, false)
  assert.deepEqual(r.conflicts, ["shared.txt"])
  // merge가 중단되지 않고 남아 있어야(MERGE_HEAD 존재)
  assert.ok(existsSync(join(repo, ".git", "MERGE_HEAD")))
})

test("merge: repo가 --into 브랜치를 체크아웃하지 않았으면 에러(대상 불일치)", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/task-b" }).worktreePath
  assert.throws(() => mergeWorktree({ repo, branch: "harnie/task-b", into: "nonexistent-branch" }), /불일치/)
})

test("remove: worktree 제거 + 기본은 브랜치 유지", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/keep-me" }).worktreePath
  const r = removeWorktree({ repo, branch: "harnie/keep-me" })
  assert.equal(r.ok, true)
  assert.equal(existsSync(wt), false)
  assert.match(execFileSync("git", ["-C", repo, "branch", "--list", "harnie/keep-me"], { encoding: "utf8" }), /harnie\/keep-me/)
})

test("remove: --delete-branch면 브랜치도 함께 삭제", () => {
  const repo = gitRepo()
  createWorktree({ repo, branch: "harnie/remove-me" })
  removeWorktree({ repo, branch: "harnie/remove-me", deleteBranch: true })
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", "harnie/remove-me"], { encoding: "utf8" }).trim(), "")
})

test("remove: task worktree의 untracked .harnie 잔여는 제거 전 자동 정리", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/live-state" }).worktreePath
  mkdirSync(join(wt, ".harnie", "design"), { recursive: true })
  writeFileSync(join(wt, ".harnie", "design", "rev-1.md"), "design\n")
  assert.doesNotThrow(() => removeWorktree({ repo, branch: "harnie/live-state" }))
  assert.equal(existsSync(wt), false)
})

test("remove: active.json이 있는 run worktree의 권위 상태는 자동 정리하지 않음", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/run-state" }).worktreePath
  mkdirSync(join(wt, ".harnie"), { recursive: true })
  const active = join(wt, ".harnie", "active.json")
  writeFileSync(active, "{}\n")
  assert.throws(() => removeWorktree({ repo, branch: "harnie/run-state" }), /git worktree remove 실패/)
  assert.ok(existsSync(active))
})

test("remove: bootstrap 중 plan 상태만 있는 run worktree도 자동 정리하지 않음", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/bootstrap-state" }).worktreePath
  mkdirSync(join(wt, ".harnie", "plan", "x"), { recursive: true })
  const execution = join(wt, ".harnie", "plan", "x", "execution.json")
  writeFileSync(execution, "{}\n")
  assert.throws(() => removeWorktree({ repo, branch: "harnie/bootstrap-state" }), /git worktree remove 실패/)
  assert.ok(existsSync(execution))
})

test("remove: .harnie 밖의 untracked 파일이 있으면 상태를 보존하고 제거 거부", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/unexpected-file" }).worktreePath
  mkdirSync(join(wt, ".harnie", "review", "code"), { recursive: true })
  const ledger = join(wt, ".harnie", "review", "code", "ledger.json")
  writeFileSync(ledger, "{}\n")
  writeFileSync(join(wt, "unexpected.txt"), "unexpected\n")
  assert.throws(() => removeWorktree({ repo, branch: "harnie/unexpected-file" }), /git worktree remove 실패/)
  assert.ok(existsSync(wt))
  assert.ok(existsSync(ledger))
})

test("remove: git이 locked worktree 제거를 거부하면 임시 이동한 .harnie를 원복", () => {
  const repo = gitRepo()
  const wt = createWorktree({ repo, branch: "harnie/locked-state" }).worktreePath
  mkdirSync(join(wt, ".harnie", "review", "code"), { recursive: true })
  const ledger = join(wt, ".harnie", "review", "code", "ledger.json")
  writeFileSync(ledger, "original\n")
  execFileSync("git", ["-C", repo, "worktree", "lock", wt])
  assert.throws(() => removeWorktree({ repo, branch: "harnie/locked-state" }), /git worktree remove 실패/)
  assert.ok(existsSync(wt))
  assert.equal(readFileSync(ledger, "utf8"), "original\n")
})

test("create: branch traversal로 .harnie-wt 컨테이너를 벗어나면 거부", () => {
  const repo = gitRepo()
  assert.throws(() => createWorktree({ repo, branch: ".." }), /worktree 경로가 \.harnie-wt 컨테이너를 벗어남/)
})

test("remove: branch traversal은 main repo의 .harnie를 건드리기 전에 거부", () => {
  const repo = gitRepo()
  mkdirSync(join(repo, ".harnie"), { recursive: true })
  const marker = join(repo, ".harnie", "marker.txt")
  writeFileSync(marker, "keep\n")
  assert.throws(() => removeWorktree({ repo, branch: ".." }), /worktree 경로가 \.harnie-wt 컨테이너를 벗어남/)
  assert.equal(readFileSync(marker, "utf8"), "keep\n")
})

// ── CLI e2e ──────────────────────────────────────────────────────────────
test("CLI: create/remove 왕복", () => {
  const repo = gitRepo()
  const r = run(["create", "--repo", repo, "--branch", "harnie/cli-x"])
  assert.ok(existsSync(r.worktreePath))
  const rm = run(["remove", "--repo", repo, "--branch", "harnie/cli-x"])
  assert.equal(rm.ok, true)
})

test("CLI: 필수 인자 누락은 exit 2", () => {
  const e = runFail(["create", "--branch", "x"])
  assert.equal(e.status, 2)
})

test("CLI: merge 충돌은 exit 3", () => {
  const repo = gitRepo()
  writeFileSync(join(repo, "shared.txt"), "base\n")
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "shared base"])
  const baseBranch = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()
  const wt = run(["create", "--repo", repo, "--branch", "harnie/cli-conflict"]).worktreePath
  writeFileSync(join(wt, "shared.txt"), "from task\n")
  execFileSync("git", ["-C", wt, "commit", "-q", "-am", "task change"])
  writeFileSync(join(repo, "shared.txt"), "from main\n")
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "main change"])
  const e = runFail(["merge", "--repo", repo, "--branch", "harnie/cli-conflict", "--into", baseBranch])
  assert.equal(e.status, 3)
})
