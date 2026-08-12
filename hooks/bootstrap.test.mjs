// bootstrap.mjs 훅 통합 테스트 — stdin 이벤트로 구동, exit code(0=ok/no-op, 2=fail-closed)와 sentinel 효과 검증.
// 설계: docs/bootstrap-adherence.md. bootstrap은 stdout JSON이 아니라 exit code로 invocation을 통과/차단한다.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { slugify, hasPendingRoute, getRouteState } from "../scripts/execution.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = join(HERE, "bootstrap.mjs")

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "harnie-bootstrap-"))
  execFileSync("git", ["-C", root, "init", "-q"])
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
const active = (root) => existsSync(join(root, ".harnie", "active.json")) ? JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")) : null

test("UserPromptSubmit /harnie:dev-full <작업> → bootstrap(run 생성·exit 0)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full add a subtract function", root)).code, 0)
  const s = active(root)
  assert.ok(s)
  assert.equal(s.track, "plan")
  assert.equal(s.slug, slugify("add a subtract function"))
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

test("PreToolUse Skill harnie:dev-full → bootstrap(run 생성·exit 0)", () => {
  const root = gitRepo()
  assert.equal(run(skill("harnie:dev-full", "add a subtract function", root)).code, 0)
  assert.equal(active(root).slug, slugify("add a subtract function"))
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

test("다른 base·미완료 active에서 새 작업 → exit 2(block, 재개 안내)", () => {
  const root = gitRepo()
  assert.equal(run(ups("/harnie:dev-full task one", root)).code, 0)
  const r = run(ups("/harnie:dev-full task two", root))
  assert.equal(r.code, 2)
  assert.ok(/미완료 run/.test(r.stderr))
})

test("같은 작업 재호출 → resume(exit 0·같은 slug)", () => {
  const root = gitRepo()
  run(ups("/harnie:dev-full same task", root))
  const before = active(root).slug
  assert.equal(run(ups("/harnie:dev-full same task", root)).code, 0)
  assert.equal(active(root).slug, before)
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

test("라우터 실패 흐름: 미완료 run 있을 때 Skill(dev-full) 실패 → pending을 failed로 전환(latch 방지, P1-1)", () => {
  const root = gitRepo()
  run(ups("/harnie:dev-full task A", root, "sessA"))     // task A active(미완료)
  run(ups("/harnie:dev task B", root, "sessB"))          // 세션 B 라우터 → pending
  assert.equal(getRouteState(root, "sessB"), "pending")
  const r = run(skill("harnie:dev-full", "task B", root, "sessB")) // 라우팅 시도 → A 미완료라 block
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
