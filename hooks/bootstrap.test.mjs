// bootstrap.mjs 훅 통합 테스트 — stdin 이벤트로 구동, exit code(0=ok/no-op, 2=fail-closed)와 sentinel 효과 검증.
// 설계: docs/bootstrap-adherence.md + docs/design-0.14-user-tree-handoff.md.
// bootstrap은 stdout JSON과 exit code로 invocation을 안내/통과/차단한다. 0.14부터 run 상태는 세션 cwd의
// git repo root 자신(`<root>/.harnie/`)에 산다 — harnie는 worktree를 만들지 않는다.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"


const HERE = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(HERE, "bootstrap.mjs")

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "harnie-bootstrap-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", root, "config", "user.name", "t"])
  writeFileSync(join(root, "README.md"), "x\n")
  execFileSync("git", ["-C", root, "add", "."])
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"])
  return root
}
// stdin payload로 bootstrap 구동. 반환 {code, stdout, stderr}.
function run(payload) {
  try {
    const stdout = execFileSync("node", [BOOTSTRAP], { input: JSON.stringify(payload), encoding: "utf8", stdio: "pipe" })
    return { code: 0, stdout, stderr: "" }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }
  }
}
// 원문 stdin(비-JSON 등) 구동 — malformed payload fail-closed 검증용.
function runRaw(raw) {
  try {
    const stdout = execFileSync("node", [BOOTSTRAP], { input: raw, encoding: "utf8", stdio: "pipe" })
    return { code: 0, stdout, stderr: "" }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }
  }
}
const SID = "sess-test"
const ups = (prompt, cwd, sid = SID) => ({ hook_event_name: "UserPromptSubmit", prompt, cwd, session_id: sid })
const skill = (name, args, cwd, sid = SID) => ({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: name, args }, cwd, session_id: sid })
const active = (dir) => existsSync(join(dir, ".harnie", "active.json")) ? JSON.parse(readFileSync(join(dir, ".harnie", "active.json"), "utf8")) : null

test("UserPromptSubmit /harnie:dev-full <작업> → 폐기 안내·상태 불변·exit 0", () => {
  const root = gitRepo()
  const r = run(ups("/harnie:dev-full add a subtract function", root))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /0\.12\.2/)
  assert.match(r.stdout, /\/harnie:dev/)
  assert.equal(existsSync(join(root, ".harnie")), false)
})

test("UserPromptSubmit /harnie:dev-full (인자 없음) → 폐기 안내·exit 0·run 미생성", () => {
  const root = gitRepo()
  const r = run(ups("/harnie:dev-full", root))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /0\.12\.2/)
  assert.match(r.stdout, /\/harnie:dev/)
  assert.equal(active(root), null)
})

test("UserPromptSubmit /harnie:dev-full-x → no-op exit 0(경계 오매치 방지)", () => {
  const root = gitRepo()
  const r = run(ups("/harnie:dev-full-x whatever", root))
  assert.equal(r.code, 0)
  assert.equal(r.stdout, "")
  assert.equal(active(root), null)
})

test("UserPromptSubmit /harnie:dev-quick → 폐기 안내·exit 0", () => {
  const root = gitRepo()
  const r = run(ups("/harnie:dev-quick fix bug", root))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /0\.12\.2/)
  assert.match(r.stdout, /\/harnie:dev/)
  assert.equal(active(root), null)
})

test("UserPromptSubmit /harnie:dev → 즉시 부트스트랩(0.11 단일 파이프라인 — 라우터·pending-route 폐지), mode=sizing", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev add a thing", root)).code, 0)
  const s = active(root)                           // 0.14: run 상태는 repo root 자신에
  assert.ok(s)
  assert.equal(s.track, "plan")
  assert.equal(s.mode, "sizing")                   // 크기 확정 전 보수 기본값
})

test("UserPromptSubmit 비-harnie prompt → no-op exit 0", () => {
  const root = gitRepo()
  assert.equal(run(ups("just a normal question", root)).code, 0)
  assert.equal(active(root), null)
})

test("PreToolUse Skill harnie:dev-full → 폐기 안내·run 미생성·exit 0", () => {
  const root = gitRepo()
  const r = run(skill("harnie:dev-full", "add a subtract function", root))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /0\.12\.2/)
  assert.match(r.stdout, /\/harnie:dev/)
  assert.equal(active(root), null)
})

test("PreToolUse Skill harnie:dev-quick → 폐기 안내·exit 0", () => {
  const root = gitRepo()
  const r = run(skill("harnie:dev-quick", "fix", root))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /0\.12\.2/)
  assert.match(r.stdout, /\/harnie:dev/)
  assert.equal(active(root), null)
})

test("PreToolUse Skill 기타 skill → no-op exit 0", () => {
  const root = gitRepo()
  assert.equal(run(skill("harnie:pr-review", "x", root)).code, 0)
  assert.equal(active(root), null)
})

// 0.14 D1: run root = 트리 하나이므로 그 트리의 활성 미완료 run도 하나다. 다른 작업을 동시에 돌리려면
// 워크스페이스를 따로 만드는 것이 답이고, 그것은 orca 소유다(설계 §9).
test("같은 트리의 다른 작업 요청 → exit 2(미완료 run 충돌·출구 셋 안내)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev task one", root, "sessA")).code, 0)
  const r = run(ups("/harnie:dev task two", root, "sessB"))
  assert.equal(r.code, 2)
  assert.match(r.stderr, /미완료 run/)
  assert.match(r.stderr, /abandon/)          // 폐기 출구가 문구에 실린다(DEC-1)
  assert.match(active(root).base, /^task-one-/)   // 첫 run은 그대로 활성
})

test("같은 작업 재호출 → resume(exit 0·같은 slug)", () => {
  const root = gitRepo()
  run(ups("/harnie:dev same task", root))
  const before = active(root).slug
  assert.equal(run(ups("/harnie:dev same task", root)).code, 0)
  assert.equal(active(root).slug, before)
})

test("bootstrap: `.harnie/`를 info/exclude에 등록한다(git add -A가 run 상태를 커밋하지 않게)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev exclude check", root)).code, 0)
  const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8")
  assert.ok(exclude.split("\n").includes(".harnie/"), exclude)
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })
  assert.doesNotMatch(status, /harnie/)
})

test("bootstrap: 기본 브랜치에서 시작하면 경고를 emit에 담되 차단하지 않는다", () => {
  const root = gitRepo()  // git init 기본 브랜치
  execFileSync("git", ["-C", root, "checkout", "-q", "-B", "main"])
  const r = run(ups("/harnie:dev on default branch", root))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /WARNING/)
  assert.match(r.stdout, /main/)
  assert.ok(active(root))
  // 기능 브랜치에서는 경고가 없다
  const other = gitRepo()
  execFileSync("git", ["-C", other, "checkout", "-q", "-b", "feat/x"])
  const r2 = run(ups("/harnie:dev on feature branch", other))
  assert.equal(r2.code, 0)
  assert.doesNotMatch(r2.stdout, /WARNING/)
})

// ── 비-git root 거부 ─────────────────────────────────────────────────────
// 0.13: 워크스페이스(멀티레포) 모드 삭제 — 하위에 git repo가 있어도 root 자체가 git repo가 아니면 run을 만들지 않는다.
function dirWithChildRepo() {
  const w = mkdtempSync(join(tmpdir(), "harnie-ws-"))
  const repo = join(w, "repoA")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", repo, "config", "user.name", "t"])
  writeFileSync(join(repo, "a.txt"), "a\n")
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"])
  return { w, repo }
}

test("비-git 디렉터리는 하위 repo 유무와 무관하게 exit 2(run 미생성)", () => {
  const empty = mkdtempSync(join(tmpdir(), "harnie-empty-"))
  const r = run(ups("/harnie:dev some task", empty))
  assert.equal(r.code, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(active(empty), null)
  // 0.13: 하위에 git repo가 있는 워크스페이스도 더 이상 진입점이 아니다
  const { w } = dirWithChildRepo()
  const r2 = run(ups("/harnie:dev cross repo task", w))
  assert.equal(r2.code, 2)
  assert.equal(active(w), null)
})

test("malformed stdin(비-JSON) → exit 2(fail-closed, P2-4)", () => {
  assert.equal(runRaw("not json at all").code, 2)
})

test("빈 stdin → exit 2(fail-closed, P2-4)", () => {
  assert.equal(runRaw("").code, 2)
})

test("Skill harnie:dev → run 생성", () => {
  const root = gitRepo()
  assert.equal(run(skill("harnie:dev", "something", root)).code, 0)
  assert.ok(active(root))
})

test("UserPromptSubmit /harnie:dev(빈 인자) → 활성 run 없으면 exit 2", () => {
  const root = gitRepo()
  const r = run(ups("/harnie:dev", root))
  assert.equal(r.code, 2)
  assert.match(r.stderr, /재개할 활성 run도 없습니다/)
})

// 0.14 D7: 인자 없는 진입은 재개다. `resumeRun`이 요구하는 정확 일치를 사람이 원 프롬프트를 글자 그대로
// 재현해 충족할 필요가 없도록, sentinel의 base를 그대로 되쓴다.
test("UserPromptSubmit /harnie:dev(빈 인자) → 활성 run이 있으면 그 run으로 재개", () => {
  const root = gitRepo()
  run(ups("/harnie:dev add a subtract function", root))
  const slug = active(root).slug
  const r = run(ups("/harnie:dev", root))
  assert.equal(r.code, 0)
  assert.equal(active(root).slug, slug) // 새 run을 만들지 않는다
  assert.match(r.stdout, new RegExp(slug))
})

// U1c 카나리아가 관측한 것: Skill 도구 경로는 빈 args에서 sentinel을 보기도 전에 실패했다. 슬래시 커맨드만
// 고치면 재개 동선이 절반만 열린다 — 두 진입 경로 모두에 같은 규칙이 걸려야 한다.
test("PreToolUse(Skill) harnie:dev(빈 args) → 활성 run이 있으면 재개, 없으면 exit 2", () => {
  const empty = gitRepo()
  const noRun = run(skill("harnie:dev", "", empty))
  assert.equal(noRun.code, 2)
  assert.match(noRun.stderr, /재개할 활성 run도 없습니다/)

  const root = gitRepo()
  run(ups("/harnie:dev add a subtract function", root))
  const slug = active(root).slug
  for (const args of ["", "   ", undefined]) {
    const r = run(skill("harnie:dev", args, root))
    assert.equal(r.code, 0, JSON.stringify(args))
    assert.equal(active(root).slug, slug)
    assert.match(r.stdout, new RegExp(slug))
  }
})

test("Skill 채널에서도 미완료 run 충돌은 exit 2", () => {
  const root = gitRepo()
  run(ups("/harnie:dev task A", root, "sessB"))
  const r = run(skill("harnie:dev", "task B", root, "sessB"))
  assert.equal(r.code, 2)
})

// ── hooks.json 배선 검증 (dispatcher 레벨 — matcher가 bootstrap.mjs로 실제 발화하는가; 라운드 11 P0 교훈) ──
const HOOKS = JSON.parse(readFileSync(join(HERE, "hooks.json"), "utf8")).hooks
function matcherMatches(matcher, name) {
  if (matcher == null) return true // matcher 없음 = 전부 매치(UserPromptSubmit)
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(name) // exact-name 목록
  return new RegExp(matcher).test(name) // 정규식
}
const routesToBootstrap = (entries, name) => (entries || []).some((e) => matcherMatches(e.matcher, name) && (e.hooks || []).some((h) => /bootstrap\.mjs/.test(h.command)))

test("hooks.json 배선: UserPromptSubmit·PreToolUse(Skill)가 bootstrap.mjs로 발화, 그 외는 아님", () => {
  assert.ok(routesToBootstrap(HOOKS.UserPromptSubmit, "AnyPrompt"), "UserPromptSubmit → bootstrap")
  assert.ok(routesToBootstrap(HOOKS.PreToolUse, "Skill"), "PreToolUse Skill → bootstrap")
  assert.ok(!routesToBootstrap(HOOKS.PreToolUse, "Write"), "Write는 bootstrap로 발화하지 않아야")
  assert.ok(!routesToBootstrap(HOOKS.PreToolUse, "Bash"), "Bash는 bootstrap로 발화하지 않아야")
})
