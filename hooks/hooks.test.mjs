// 훅 엔트리 통합/음성 테스트 — pretooluse/stop/posttooluse를 실제 stdin으로 구동(설계 §11 음성 세트).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
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

test("Bash: .harnie 변형 deny, 신뢰 경로 sanctioned CLI allow, 임의 경로 CLI deny", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf .harnie/plan/feat-x/review" }, cwd: root })))
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + REAL_LOOP + " capture " + root }, cwd: root }), null)
  // 위장 경로 CLI는 planning에서 deny
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "node /tmp/scripts/loop.mjs capture " + root }, cwd: root })))
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
