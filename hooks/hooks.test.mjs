// 훅 엔트리 통합/음성 테스트 — pretooluse/stop/posttooluse를 실제 stdin으로 구동(설계 §11 음성 세트).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_LOOP = resolve(HERE, "..", "scripts", "loop.mjs") // 훅이 신뢰하는 실제 CLI 경로
const SCRIPTS = join(HERE, "..", "scripts")
const EXEC = join(SCRIPTS, "execution.mjs")
const PRE = join(HERE, "pretooluse.mjs")
const STOP = join(HERE, "stop.mjs")
const POST = join(HERE, "posttooluse.mjs")

// ── hooks.json matcher 배선 검증 (dispatcher 레벨 — 훅 스크립트 직접 실행이 아니라 matcher 자체) ──
// Claude Code 규약: matcher가 [A-Za-z0-9_|]만이면 **exact-name 목록**(| split 후 정확 일치), 그 외엔 **정규식**.
// 과거 버그: `…|codex` 는 exact-list라 `mcp__codex__codex`와 매치 안 돼 codex 훅이 발화하지 않았다.
function matcherMatches(matcher, name) {
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(name) // exact-name 목록
  return new RegExp(matcher).test(name) // 정규식(부분 일치)
}
const HOOKS = JSON.parse(readFileSync(join(HERE, "hooks.json"), "utf8")).hooks
const anyMatch = (entries, name) => (entries || []).some((e) => matcherMatches(e.matcher, name))
const CODEX_TOOLS = ["mcp__codex__codex", "mcp__codex__codex-reply", "mcp__plugin_harnie_codex__codex", "mcp__plugin_harnie_codex__codex-reply"]

test("hooks.json matcher: codex MCP 툴명이 PreToolUse·PostToolUse에 매치(발화 보장)", () => {
  for (const t of CODEX_TOOLS) {
    assert.ok(anyMatch(HOOKS.PreToolUse, t), `PreToolUse가 ${t}에 매치해야 함`)
    assert.ok(anyMatch(HOOKS.PostToolUse, t), `PostToolUse가 ${t}에 매치해야 함`)
  }
})

test("hooks.json matcher: native 게이트 툴 + AskUserQuestion 매치", () => {
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent", "AskUserQuestion"])
    assert.ok(anyMatch(HOOKS.PreToolUse, t), `PreToolUse가 ${t}에 매치해야 함`)
  assert.ok(anyMatch(HOOKS.PostToolUse, "AskUserQuestion"), "PostToolUse가 AskUserQuestion에 매치해야 함")
})

test("hooks.json matcher: 다른 namespace·접두/접미 붙은 codex 이름은 매치 안 됨(앵커링)", () => {
  const evil = [
    "mcp__evil_mcp__codex__codex", // 다른 서버 namespace
    "mcp__codex__codex__extra",    // 접미
    "mcp__codex__codexx",          // 접미 오염
    "xmcp__codex__codex",          // 접두
    "mcp__notcodex__codex",        // 유사 namespace
  ]
  for (const t of evil) {
    assert.equal(anyMatch(HOOKS.PreToolUse, t), false, `PreToolUse가 ${t}에 매치되면 안 됨`)
    assert.equal(anyMatch(HOOKS.PostToolUse, t), false, `PostToolUse가 ${t}에 매치되면 안 됨`)
  }
})

test("hooks.json matcher: 회귀 — bare `codex` exact-list는 MCP 툴명과 매치 안 됨(과거 버그)", () => {
  assert.equal(matcherMatches("Write|Edit|codex", "mcp__codex__codex"), false)
  // 현재 codex matcher는 정규식이라 4개 툴명 모두 매치
  const preHasCodexRegex = HOOKS.PreToolUse.some((e) => !/^[A-Za-z0-9_|]+$/.test(e.matcher) && CODEX_TOOLS.every((t) => new RegExp(e.matcher).test(t)))
  assert.ok(preHasCodexRegex, "PreToolUse에 codex 4툴을 모두 잡는 정규식 matcher가 있어야 함")
})

const MANIFEST = {
  tasks: [{ id: "T1", deps: [], reviewUnit: "task-a", scope: ["src/a/"], verification: [{ executable: "node", args: ["--version"], cwd: ".", timeout: 30000 }] }],
  gates: [
    { name: "coverage", reviewUnit: "final-coverage" }, { name: "quality", reviewUnit: "final-quality" },
    { name: "runtime", reviewUnit: "final-runtime" }, { name: "scope", reviewUnit: "final-scope" },
  ],
}

function exec(args) { return JSON.parse(execFileSync("node", [EXEC, ...args], { encoding: "utf8" })) }
function hook(script, payload) {
  const outStr = execFileSync("node", [script], { input: JSON.stringify(payload), encoding: "utf8" })
  return outStr.trim() ? JSON.parse(outStr) : null
}
function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "harnie-hooks-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", root, "config", "user.name", "t"])
  mkdirSync(join(root, "src", "a"), { recursive: true }); writeFileSync(join(root, "src", "a", "x.js"), "x")
  const dir = join(root, ".harnie", "plan", "feat-x")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "plan.md"), "# Plan\n\n```harnie-manifest\n" + JSON.stringify(MANIFEST, null, 2) + "\n```\n")
  exec(["init", "--root", root, "--slug", "feat-x"])
  exec(["trial", "--root", root, "--slug", "feat-x"]) // h1 등록 게이트: verification의 실제 실행 영수증 확보(없으면 arm-approval 거부)
  return { root, dir }
}
// 승인·pending은 CLI가 아니라 훅이 in-process로 수행 → 실제 훅 경로로 executing 진입.
const AQ = "이 계획을 실행할까요?"
const askPayload = (tuid) => ({ tool_name: "AskUserQuestion", tool_use_id: tuid, tool_input: { questions: [{ question: AQ, options: [{ label: "승인" }, { label: "거절·수정" }] }] } })
function toExecuting(root) {
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("tu-1"), cwd: root })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "tu-1", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), cwd: root })
}
const deny = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === "deny"
const autoAllow = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === "allow"

// ── PreToolUse H1 ────────────────────────────────────────────────────────
test("비활성 repo: 훅 통과(no output)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-noact-"))
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "a.txt") }, cwd: root }), null)
})

test("planning: 소스 Write deny, plan.md Write allow", () => {
  const { root, dir } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root })))
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(dir, "plan.md") }, cwd: root }), null) // allow
})

test("control·review-state 직접 Write는 phase 무관 deny", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(dir, "manifest.json") }, cwd: root })))
  assert.ok(deny(hook(PRE, { tool_name: "Edit", tool_input: { file_path: join(dir, "review", "task-a", "ledger.json") }, cwd: root })))
})

test("executing: 소스 Write allow", () => {
  const { root } = setupRepo()
  toExecuting(root)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "y.js") }, cwd: root }), null)
})

test("Write: symlink으로 repo 밖 탈출 시도 deny", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const outside = mkdtempSync(join(tmpdir(), "harnie-outside-"))
  symlinkSync(outside, join(root, "escape")) // repo/escape → 외부 디렉터리
  // executing에서 소스 쓰기는 원래 allow지만, symlink로 repo 밖을 가리키면 deny
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "escape", "x.js") }, cwd: root })))
})

test("Bash: 개행으로 밀반입한 소스 쓰기 deny(planning)", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "git status\nrm -rf src" }, cwd: root })))
})

test("Bash: .harnie 변형 deny, 신뢰 경로 sanctioned 4종 auto-allow, 임의 경로 CLI deny", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf .harnie/plan/feat-x/review" }, cwd: root })))
  // sanctioned 4종(capture)은 프롬프트 skip(auto-allow)
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + REAL_LOOP + " capture " + root }, cwd: root })))
  // 위장 경로 CLI는 planning에서 deny
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "node /tmp/scripts/loop.mjs capture " + root }, cwd: root })))
})

test("Bash: sanctioned auto-allow는 4종만 — apply/verify/seal 등은 통과하되 프롬프트(무의견)", () => {
  const { root, dir } = setupRepo()
  const rev = join(dir, "review", "task-a")
  // completion·seal-verify(execution.mjs) auto-allow
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " completion --root " + root + " --slug feat-x" }, cwd: root })))
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " seal-verify --root " + root + " --slug feat-x" }, cwd: root })))
  // apply(loop.mjs)·verify/seal(execution.mjs)는 sanctioned지만 auto-allow 아님 → 무의견(null=프롬프트)
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + REAL_LOOP + " apply --root " + root + " --ledger " + join(rev, "ledger.json") + " --review " + join(rev, "round-1.txt") + " --ns CR --state " + join(rev, "state.json") + " --artifact " + "0".repeat(40) }, cwd: root }), null)
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " verify --root " + root + " --slug feat-x --task T1" }, cwd: root }), null)
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " seal --root " + root + " --slug feat-x" }, cwd: root }), null)
})

test("Bash: 위장 인터프리터 /tmp/node <신뢰 스크립트>는 sanctioned 아님 → planning deny(DR-004)", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "/tmp/node " + REAL_LOOP + " capture " + root }, cwd: root })))
})

test("Task: planning은 write 에이전트 deny, read-only allow", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Task", tool_input: { subagent_type: "harnie-builder" }, cwd: root })))
  assert.equal(hook(PRE, { tool_name: "Task", tool_input: { subagent_type: "harnie-scout" }, cwd: root }), null)
})

test("codex: planning workspace-write deny, read-only allow", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, cwd: root })))
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, cwd: root }), null)
})

test("codex: executing 빌더 부트스트랩은 building-unbound task가 있어야 allow(cwd=root 필수)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const ti = { sandbox: "workspace-write", cwd: root }
  // 아직 building 표시 없음 → deny
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: ti, cwd: root })))
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: ti, cwd: root }), null)
  // cwd 누락이면 building-unbound라도 deny
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, cwd: root })))
})

test("codex-reply: executing 미등록 스레드 deny", () => {
  const { root } = setupRepo()
  toExecuting(root)
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex-reply", tool_input: { threadId: "unknown" }, cwd: root })))
})

// ── PostToolUse 등록·승인 관찰 ─────────────────────────────────────────────
test("PostToolUse: read-only codex 성공 → readOnlyThreads 등록", () => {
  const { root } = setupRepo()
  const tid = "019facda-1111-2222-3333-444455556666"
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, tool_response: `{"threadId":"${tid}"}`, cwd: root })
  const sentinel = JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8"))
  assert.ok(sentinel.readOnlyThreads.includes(tid))
})

test("PostToolUse: workspace-write codex 성공 → 유일 building-unbound task에 빌더 등록", () => {
  const { root } = setupRepo()
  toExecuting(root)
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  const tid = "019facda-aaaa-bbbb-cccc-ddddeeeeffff"
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, tool_response: `{"threadId":"${tid}"}`, cwd: root })
  const ex = JSON.parse(readFileSync(join(root, ".harnie", "plan", "feat-x", "execution.json"), "utf8"))
  assert.equal(ex.tasks.T1.builderThreadId, tid)
})

test("승인 바인딩 e2e: arm(A5) → Pre(pending) → Post(승인 답) → executing", () => {
  const { root, dir } = setupRepo()
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("q-1"), cwd: root }) // pending 기록(armed·질문 일치)
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), cwd: root })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
})

test("승인 바인딩: 선택 값이 거절이면 executing 안 됨(질문 텍스트 오탐 방지)", () => {
  const { root, dir } = setupRepo()
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("q-1"), cwd: root })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { [AQ]: "거절·수정" } }), cwd: root })
  assert.notEqual(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
})

test("승인 바인딩: 실제 질문이 arm과 다르면 pending 미기록(오-바인딩 차단)", () => {
  const { root, dir } = setupRepo()
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  // arm과 다른 질문으로 물음 → PRE가 pending 기록 안 함
  hook(PRE, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_input: { questions: [{ question: "배포 승인?", options: [{ label: "승인" }] }] }, cwd: root })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { "배포 승인?": "승인" } }), cwd: root })
  assert.notEqual(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
})

// ── Stop H2 ──────────────────────────────────────────────────────────────
test("Stop: executing 미완료 첫 호출 block", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const r = hook(STOP, { cwd: root, stop_hook_active: false, last_assistant_message: "작업 중" })
  assert.equal(r.decision, "block")
})

test("Stop: 재호출 — COMPLETE 주장(권위 미완료)은 계속 block, INCOMPLETE 정직보고는 통과", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const blocked = hook(STOP, { cwd: root, stop_hook_active: true, last_assistant_message: "끝.\nHARNIE_STATUS: COMPLETE" })
  assert.equal(blocked.decision, "block")
  const passed = hook(STOP, { cwd: root, stop_hook_active: true, last_assistant_message: "보고.\nHARNIE_STATUS: INCOMPLETE — task T1 미완료" })
  assert.equal(passed, null) // 통과
})

test("Stop: planning phase는 완료 강제 없음(통과)", () => {
  const { root } = setupRepo()
  assert.equal(hook(STOP, { cwd: root, stop_hook_active: false, last_assistant_message: "계획 중" }), null)
})

test("Stop: execution.json phase를 closed로 위조해도 승인+미완료면 계속 block(phase 무관 권위 재도출)", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  // advisory execution.json phase를 closed로 직접 위조(set-phase 우회 시뮬)
  const exPath = join(dir, "execution.json")
  const ex = JSON.parse(readFileSync(exPath, "utf8")); ex.phase = "closed"
  writeFileSync(exPath, JSON.stringify(ex))
  const r = hook(STOP, { cwd: root, stop_hook_active: false, last_assistant_message: "끝" })
  assert.equal(r.decision, "block") // 승인된 active run → phase 무관 완료 재도출 → 미완료 block
})

test("Stop: 승인 후 plan.md 변조 + closed 위조 → approvalEvidence로 phase 무관 block", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  // 승인 후 plan.md 변조 → authorityApproved=false, 하지만 manifest 존재(approvalEvidence)
  writeFileSync(join(dir, "plan.md"), readFileSync(join(dir, "plan.md"), "utf8") + "\n변조\n")
  // execution.json phase를 closed로 위조
  const exPath = join(dir, "execution.json")
  const ex = JSON.parse(readFileSync(exPath, "utf8")); ex.phase = "closed"; writeFileSync(exPath, JSON.stringify(ex))
  const r = hook(STOP, { cwd: root, stop_hook_active: false, last_assistant_message: "끝" })
  assert.equal(r.decision, "block") // approved=false + approvalEvidence → 변조 의심 block
})

// ── pending-route 게이트(§3.9): per-session 파일, active 무관, Bash 전면 차단, control-path 보호, honesty(P1-1/2/3/4) ──
function routeFilePath(root, sid) { return join(root, ".harnie", "pending-route", sid + ".json") }
function pendingRepo(sid, entry = { state: "pending", at: new Date().toISOString() }) {
  const root = mkdtempSync(join(tmpdir(), "harnie-hooks-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  mkdirSync(join(root, ".harnie", "pending-route"), { recursive: true })
  writeFileSync(routeFilePath(root, sid), JSON.stringify(entry))
  return root
}
test("pending-route 게이트: 라우팅 미완료 시 작업 도구·Bash 전면 차단, 다른 세션은 미적용", () => {
  const SID = "s1"
  const root = pendingRepo(SID)
  const pl = (o) => ({ ...o, cwd: root, session_id: SID })
  assert.ok(deny(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(root, "src", "x.js") } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "ls -la" } })))) // Bash 전면 차단(P1-4: rg --pre 등 우회 방지)
  assert.ok(deny(hook(PRE, pl({ tool_name: "Task", tool_input: { subagent_type: "harnie-builder" } }))))
  // 다른 세션(SID 불일치, pending 없음)은 일반 작업 미적용
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "x.js") }, cwd: root, session_id: "other" }), null)
})

test("baseline: control/route 파일 raw 변경 차단 — Write(견고)·literal/quote Bash(best-effort)", () => {
  const root = pendingRepo("s1")
  // Write는 canonical containment로 견고하게 차단(active 없어도)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: routeFilePath(root, "s1") }, cwd: root, session_id: "other" })))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "active.json") }, cwd: root, session_id: "other" })))
  // Bash는 literal/quote까지 best-effort 차단(§0.1 실수 방지). glob/변수 셸 우회는 적대적이라 비목표.
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm " + routeFilePath(root, "s1") }, cwd: root, session_id: "other" })))
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: 'rm .har""nie/pending-route/s1.json' }, cwd: root, session_id: "other" }))) // quote 우회 차단
})

test("라우팅 세션 자신의 Bash는 pending 게이트가 막음(자기 route 파일 self-tamper 불가, P1)", () => {
  const root = pendingRepo("s1")
  // s1은 pending이 있으므로 자기 Bash(glob 포함)가 전면 차단 → 자기 gate를 Bash로 우회 불가
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm .har?ie/pending-route/s1.json" }, cwd: root, session_id: "s1" })))
})

test("pending-route 게이트: 활성 run이 있어도 pending이면 차단(active 무관 우선, P1-2)", () => {
  const { root } = setupRepo() // active run 존재
  mkdirSync(join(root, ".harnie", "pending-route"), { recursive: true })
  writeFileSync(routeFilePath(root, "s2"), JSON.stringify({ state: "pending", at: new Date().toISOString() }))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root, session_id: "s2" })))
})

test("Stop: 이 세션 pending-route(pending)면 종료 차단(P1-1)", () => {
  const root = pendingRepo("s3")
  const r = hook(STOP, { cwd: root, session_id: "s3", stop_hook_active: false, last_assistant_message: "done" })
  assert.equal(r.decision, "block")
})

test("Stop: failed + 첫 Stop은 차단(정직 보고 유도, P1-4)", () => {
  const root = pendingRepo("s4a", { state: "failed", reason: "x", at: new Date().toISOString() })
  const r = hook(STOP, { cwd: root, session_id: "s4a", stop_hook_active: false, last_assistant_message: "라우팅 실패" })
  assert.equal(r.decision, "block")
  assert.ok(existsSync(routeFilePath(root, "s4a"))) // 아직 미정리
})

test("Stop: failed + 재호출 + 정직한 INCOMPLETE 보고 → 정리 후 통과(P1-1/P1-4)", () => {
  const root = pendingRepo("s4", { state: "failed", reason: "미완료 run 충돌", at: new Date().toISOString() })
  const r = hook(STOP, { cwd: root, session_id: "s4", stop_hook_active: true, last_assistant_message: "라우팅 실패.\nHARNIE_STATUS: INCOMPLETE — B 시작 못함" })
  assert.equal(r, null) // 통과
  assert.equal(existsSync(routeFilePath(root, "s4")), false) // 정리됨
})

test("Stop: failed + 재호출인데 거짓 COMPLETE 보고 → 계속 차단·미정리(P1-4)", () => {
  const root = pendingRepo("s5", { state: "failed", reason: "x", at: new Date().toISOString() })
  const r = hook(STOP, { cwd: root, session_id: "s5", stop_hook_active: true, last_assistant_message: "끝.\nHARNIE_STATUS: COMPLETE" })
  assert.equal(r.decision, "block") // 거짓 완료 주장 → 차단
  assert.ok(existsSync(routeFilePath(root, "s5"))) // latch 유지(미정리)
})

test("Stop: failed + INCOMPLETE인데 blocker 없음 → 계속 차단·미정리(P2)", () => {
  const root = pendingRepo("s6", { state: "failed", reason: "x", at: new Date().toISOString() })
  const r = hook(STOP, { cwd: root, session_id: "s6", stop_hook_active: true, last_assistant_message: "HARNIE_STATUS: INCOMPLETE" })
  assert.equal(r.decision, "block") // blocker 미명시 → 차단(빈 INCOMPLETE 우회 방지)
  assert.ok(existsSync(routeFilePath(root, "s6"))) // 미정리
})

test("Stop: 손상된 route(알 수 없는 state)면 fail-closed 차단(P1 — 우회 방지)", () => {
  // 유효 JSON이지만 state가 pending/failed가 아님 → 예전엔 Stop이 두 분기 모두 건너뛰고 통과(fail-open). 이제 차단.
  const root = pendingRepo("s7", { state: "unexpected", at: new Date().toISOString() })
  const r = hook(STOP, { cwd: root, session_id: "s7", stop_hook_active: false, last_assistant_message: "done" })
  assert.equal(r.decision, "block")
})

test("PreToolUse: 손상된 route(알 수 없는 state)면 작업 도구 fail-closed deny(P1)", () => {
  const root = pendingRepo("s8", { state: "unexpected", at: new Date().toISOString() })
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "x.js") }, cwd: root, session_id: "s8" })))
})

test("pending-route 없으면 active run 없을 때 통과(게이트 미적용)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-hooks-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "x.js") }, cwd: root }), null)
})
