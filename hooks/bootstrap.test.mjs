// bootstrap.mjs 훅 통합 테스트 — stdin 이벤트로 구동, exit code(0=ok/no-op, 2=fail-closed)와 sentinel 효과 검증.
// 설계: docs/bootstrap-adherence.md + T2(worktree-per-run, docs/plans/parallel-dev/design.md DEC-001).
// bootstrap은 stdout JSON이 아니라 exit code로 invocation을 통과/차단한다. dev-full의 run 상태는 이제 main
// root가 아니라 `<root>/.harnie-wt/harnie-<slug>` worktree 안에 산다 — active()는 그 경로를 봐야 한다.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { slugify, hasPendingRoute, getRouteState } from "../scripts/execution.mjs"
import { worktreeDirFor } from "../scripts/worktree.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(HERE, "bootstrap.mjs")

// worktree add가 HEAD를 필요로 하므로(unborn HEAD면 실패) 최초 커밋을 남긴다.
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
// stdin payload로 bootstrap 구동. 반환 {code, stderr}.
function run(payload) {
  try {
    execFileSync("node", [BOOTSTRAP], { input: JSON.stringify(payload), encoding: "utf8", stdio: "pipe" })
    return { code: 0, stderr: "" }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, stderr: String(e.stderr || "") }
  }
}
// 원문 stdin(비-JSON 등) 구동 — malformed payload fail-closed 검증용.
function runRaw(raw) {
  try {
    execFileSync("node", [BOOTSTRAP], { input: raw, encoding: "utf8", stdio: "pipe" })
    return { code: 0, stderr: "" }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, stderr: String(e.stderr || "") }
  }
}
const SID = "sess-test"
const pending = (root, sid = SID) => hasPendingRoute(root, sid)
const ups = (prompt, cwd, sid = SID) => ({ hook_event_name: "UserPromptSubmit", prompt, cwd, session_id: sid })
const skill = (name, args, cwd, sid = SID) => ({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: name, args }, cwd, session_id: sid })
// dev-full의 run 상태는 root가 아니라 그 worktree 안에 있다(T2 DEC-001) — task 텍스트로 결정적 경로를 계산.
const wtFor = (root, task) => worktreeDirFor(root, `harnie/${slugify(task)}`)
const active = (dir) => existsSync(join(dir, ".harnie", "active.json")) ? JSON.parse(readFileSync(join(dir, ".harnie", "active.json"), "utf8")) : null

test("UserPromptSubmit /harnie:dev-full <작업> → worktree 생성 + bootstrap(run 생성·exit 0)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full add a subtract function", root)).code, 0)
  const wt = wtFor(root, "add a subtract function")
  const s = active(wt)
  assert.ok(s)
  assert.equal(s.track, "plan")
  assert.equal(s.slug, slugify("add a subtract function"))
  assert.equal(active(root), null) // main root에는 run 상태를 두지 않음(T2)
})

test("UserPromptSubmit /harnie:dev-full (인자 없음) → exit 2·run 미생성", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full", root)).code, 2)
  assert.equal(active(root), null)
})

test("UserPromptSubmit /harnie:dev-full-x → no-op exit 0(경계 오매치 방지)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full-x whatever", root)).code, 0)
  assert.equal(active(root), null)
})

test("UserPromptSubmit /harnie:dev-quick → no-op exit 0(quick 이연)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-quick fix bug", root)).code, 0)
  assert.equal(active(root), null)
})

test("UserPromptSubmit 라우터 /harnie:dev → pending-route 기록·exit 0(P1-2)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev add a thing", root)).code, 0)
  assert.equal(active(root), null) // 아직 active run 없음
  assert.ok(pending(root))         // pending-route 게이트 활성
})

test("UserPromptSubmit 비-harnie prompt → no-op exit 0", () => {
  const root = gitRepo()
  assert.equal(run(ups("just a normal question", root)).code, 0)
  assert.equal(active(root), null)
})

test("PreToolUse Skill harnie:dev-full → worktree 생성 + bootstrap(run 생성·exit 0)", () => {
  const root = gitRepo()
  assert.equal(run(skill("harnie:dev-full", "add a subtract function", root)).code, 0)
  assert.equal(active(wtFor(root, "add a subtract function")).slug, slugify("add a subtract function"))
})

test("PreToolUse Skill harnie:dev-quick → no-op exit 0(quick 이연)", () => {
  const root = gitRepo()
  assert.equal(run(skill("harnie:dev-quick", "fix", root)).code, 0)
  assert.equal(active(root), null)
})

test("PreToolUse Skill 기타 skill → no-op exit 0", () => {
  const root = gitRepo()
  assert.equal(run(skill("harnie:pr-review", "x", root)).code, 0)
  assert.equal(active(root), null)
})

// worktree-per-run의 핵심 목표(FR-001): 같은 세션이 아니면 다른 base도 동시 활성 가능 — 예전 "미완료 run 충돌" block은
// 없다(그건 repo당 run 1개 싱글턴 시절의 제약). 대신 **같은 세션**이 다른 작업을 요청하면 한 세션=한 run(v1)으로 막는다.
test("다른 세션·다른 base는 동시에 각자 worktree run(동시성, DEC-001)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full task one", root, "sessA")).code, 0)
  assert.equal(run(ups("/harnie:dev-full task two", root, "sessB")).code, 0)
  assert.ok(active(wtFor(root, "task one")))
  assert.ok(active(wtFor(root, "task two")))
  assert.notEqual(wtFor(root, "task one"), wtFor(root, "task two"))
})

test("같은 세션이 이미 바인딩된 상태에서 다른 작업 요청 → exit 2(한 세션=한 run, 재개 안내)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full task one", root, "sessA")).code, 0)
  const r = run(ups("/harnie:dev-full task two", root, "sessA"))
  assert.equal(r.code, 2)
  assert.match(r.stderr, /한 세션 = 한 run/)
  assert.equal(active(wtFor(root, "task two")), null) // 두 번째 worktree는 만들어지지 않음
})

test("같은 작업 재호출 → resume(exit 0·같은 worktree·같은 slug)", () => {
  const root = gitRepo()
  run(ups("/harnie:dev-full same task", root))
  const wt = wtFor(root, "same task")
  const before = active(wt).slug
  assert.equal(run(ups("/harnie:dev-full same task", root)).code, 0)
  assert.equal(active(wt).slug, before)
})

test("malformed stdin(비-JSON) → exit 2(fail-closed, P2-4)", () => {
  assert.equal(runRaw("not json at all").code, 2)
})

test("빈 stdin → exit 2(fail-closed, P2-4)", () => {
  assert.equal(runRaw("").code, 2)
})

test("PreToolUse Skill harnie:dev-quick → pending-route 해소·exit 0", () => {
  const root = gitRepo()
  run(ups("/harnie:dev route me", root))
  assert.ok(pending(root))
  assert.equal(run(skill("harnie:dev-quick", "route me", root)).code, 0)
  assert.equal(pending(root), false) // quick으로 라우팅 해소
})

test("dev-full bootstrap이 pending-route 해소", () => {
  const root = gitRepo()
  run(ups("/harnie:dev something", root))
  assert.ok(pending(root))
  assert.equal(run(skill("harnie:dev-full", "something", root)).code, 0)
  assert.equal(pending(root), false)
})

test("pending-route는 session-scoped — 다른 세션이 해제 못 함(P1-3)", () => {
  const root = gitRepo()
  run(ups("/harnie:dev task A", root, "sessA")) // 세션 A pending
  assert.ok(pending(root, "sessA"))
  run(skill("harnie:dev-quick", "task B", root, "sessB")) // 세션 B가 dev-quick 해소 시도
  assert.ok(pending(root, "sessA")) // A의 pending은 그대로(B가 못 지움)
  assert.equal(pending(root, "sessB"), false)
})

test("UserPromptSubmit /harnie:dev(빈 인자) → exit 2·pending 미생성(P1-1)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev", root)).code, 2)
  assert.equal(pending(root), false)
})

test("라우터 실패 흐름: 이미 다른 run에 바인딩된 세션이 라우팅 시도 → pending을 failed로 전환(latch 방지, P1-1)", () => {
  const root = gitRepo()
  run(ups("/harnie:dev-full task A", root, "sessB"))     // sessB가 이미 task A run에 바인딩
  run(ups("/harnie:dev task B", root, "sessB"))          // 같은 세션이 다른 작업으로 라우터 진입 → pending
  assert.equal(getRouteState(root, "sessB"), "pending")
  const r = run(skill("harnie:dev-full", "task B", root, "sessB")) // 라우팅 시도 → 이미 다른 run에 바인딩돼 block
  assert.equal(r.code, 2)
  assert.equal(getRouteState(root, "sessB"), "failed")   // pending → failed(영구 latch 아님)
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
