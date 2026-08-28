// 훅 엔트리 통합/음성 테스트 — pretooluse/stop/posttooluse를 실제 stdin으로 구동(설계 §11 음성 세트).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync, realpathSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findRoot, canonicalRelPath } from "./lib.mjs"
import { slugify } from "../scripts/execution.mjs"
import { captureTree } from "../scripts/delta.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_LOOP = resolve(HERE, "..", "scripts", "loop.mjs") // 훅이 신뢰하는 실제 CLI 경로
const SCRIPTS = join(HERE, "..", "scripts")
const EXEC = join(SCRIPTS, "execution.mjs")
const PRE = join(HERE, "pretooluse.mjs")
const STOP = join(HERE, "stop.mjs")
const POST = join(HERE, "posttooluse.mjs")
const BOOT = join(HERE, "bootstrap.mjs")

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

test("Bash: 승인 전에도 .harnie 밖 명령은 allow", () => {
  const { root } = setupRepo()
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "git status\nrm -rf src" }, cwd: root }), null)
})

test("Bash: .harnie 변형 deny, 신뢰 경로 sanctioned 4종 auto-allow, 임의 경로 CLI deny", () => {
  const { root } = setupRepo()
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf .harnie/plan/feat-x/review" }, cwd: root })))
  // sanctioned 4종(capture)은 프롬프트 skip(auto-allow)
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + REAL_LOOP + " capture " + root }, cwd: root })))
  // 신뢰 경로가 아니면 sanctioned은 아니지만 .harnie 밖 Bash이므로 일반 권한 흐름
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node /tmp/scripts/loop.mjs capture " + root }, cwd: root }), null)
})

test("Bash: sanctioned auto-allow 집합 — apply/verify 등은 통과하되 프롬프트(무의견)", () => {
  const { root, dir } = setupRepo()
  const rev = join(dir, "review", "task-a")
  // completion·seal·seal-verify(execution.mjs) auto-allow
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " completion --root " + root + " --slug feat-x" }, cwd: root })))
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " seal-verify --root " + root + " --slug feat-x" }, cwd: root })))
  // apply(loop.mjs)·verify(execution.mjs)는 sanctioned지만 auto-allow 아님 → 무의견(null=프롬프트)
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + REAL_LOOP + " apply --root " + root + " --ledger " + join(rev, "ledger.json") + " --review " + join(rev, "round-1.txt") + " --ns CR --state " + join(rev, "state.json") + " --artifact " + "0".repeat(40) }, cwd: root }), null)
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " verify --root " + root + " --slug feat-x --task T1" }, cwd: root }), null)
  assert.ok(autoAllow(hook(PRE, { tool_name: "Bash", tool_input: { command: "node " + EXEC + " seal --root " + root + " --slug feat-x" }, cwd: root })))
})

test("Bash: bare node가 아닌 인터프리터는 sanctioned 아님", () => {
  const { root } = setupRepo()
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "/tmp/node " + REAL_LOOP + " capture " + root }, cwd: root }), null)
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

test("codex: executing 첫 빌더 호출은 활성 run root cwd만 allow", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const ti = { sandbox: "workspace-write", cwd: root }
  // 아직 building 표시 없음 → deny
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: ti, cwd: root })))
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: ti, cwd: root }), null)
  // run root가 아닌 cwd는 PostToolUse가 귀속할 수 없으므로 PreToolUse에서 막는다
  const sub = join(root, "src", "a")
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: sub }, cwd: root })))
  // cwd 누락이면 building-unbound라도 deny
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, cwd: root })))
})

test("codex: serial single-task run-root bootstrap을 허용하고 귀속", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  const input = { sandbox: "workspace-write", cwd: root }
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: input, cwd: root }), null)
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: input, tool_response: '{"threadId":"serial-thread"}', cwd: root })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).tasks.T1.builderThreadId, "serial-thread")
})

test("codex-reply: executing 미등록 스레드 deny", () => {
  const { root } = setupRepo()
  toExecuting(root)
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex-reply", tool_input: { threadId: "unknown" }, cwd: root })))
})

test("codex-reply: 빌더 워치독 예산 초과면 deny, 여유 있으면 통과", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  const tid = "019facda-aaaa-bbbb-cccc-ddddeeeeffff"
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, tool_response: `{"threadId":"${tid}"}`, cwd: root })
  const execPath = join(dir, "execution.json")
  const ex = JSON.parse(readFileSync(execPath, "utf8"))
  ex.tasks.T1.codexCalls = 15
  writeFileSync(execPath, JSON.stringify(ex))
  const blocked = hook(PRE, { tool_name: "mcp__codex__codex-reply", tool_input: { threadId: tid }, cwd: root })
  assert.ok(deny(blocked))
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /watchdog-extend/)
  ex.tasks.T1.codexCalls = 5
  writeFileSync(execPath, JSON.stringify(ex))
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex-reply", tool_input: { threadId: tid }, cwd: root }), null)
})

test("PostToolUse: 빌더 호출이 80%에 닿으면 워치독 additionalContext 경고", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  const tid = "019facda-aaaa-bbbb-cccc-ddddeeeeffff"
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, tool_response: `{"threadId":"${tid}"}`, cwd: root })
  const execPath = join(dir, "execution.json")
  const ex = JSON.parse(readFileSync(execPath, "utf8"))
  ex.tasks.T1.codexCalls = 11
  writeFileSync(execPath, JSON.stringify(ex))
  const warned = hook(POST, { tool_name: "mcp__codex__codex-reply", tool_input: { threadId: tid }, cwd: root })
  assert.match(warned.hookSpecificOutput.additionalContext, /예산 80% 소진/)
  assert.match(warned.hookSpecificOutput.additionalContext, /빌더 호출 12\/15/)
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

test("rebind marker: run-root 호출만 지정 task에 원자 재바인딩하고 marker를 소거", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root }, tool_response: '{"threadId":"old-thread"}', cwd: root })
  exec(["rebind-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--reason", "finding:final-review:CR-001"])
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root }, cwd: root }), null)
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root }, tool_response: '{"threadId":"new-thread"}', cwd: root })
  const ex = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"))
  assert.equal(ex.tasks.T1.builderThreadId, "new-thread")
  assert.equal(ex.pendingRunRootBootstrap, undefined)
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

test("승인 바인딩: arm 후 첫 관찰 질문은 텍스트 대조 없이 일회성 소비", () => {
  const { root, dir } = setupRepo()
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  // arm과 다른 질문이어도 첫 AskUserQuestion을 tool_use_id로 바인딩한다.
  hook(PRE, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_input: { questions: [{ question: "배포 승인?", options: [{ label: "승인" }] }] }, cwd: root })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { "배포 승인?": "승인" } }), cwd: root })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
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

test("baseline: control 파일 raw 변경 차단 — Write canonical·Bash 단순 literal", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-hooks-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  const ctrl = join(root, ".harnie", "active.json")
  // Write는 canonical containment로 견고하게 차단(active 없어도)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: ctrl }, cwd: root, session_id: "other" })))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "plan", "x", "manifest.json") }, cwd: root, session_id: "other" })))
  // 단순 `.harnie` 정규식으로 literal 접근을 차단한다.
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm " + ctrl }, cwd: root, session_id: "other" })))
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: 'rm .har""nie/active.json' }, cwd: root, session_id: "other" }), null)
})

test("active run 없으면 작업 도구 통과(과잉 차단 감시)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-hooks-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "x.js") }, cwd: root }), null)
})

// ── 과잉 차단(overreach) 제거: root 탐색 경계·비-git bootstrap·repo 밖 쓰기 ──
// git worktree add가 HEAD를 요구하므로(unborn HEAD면 실패) 최초 커밋을 남긴다.
const gitRepo = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  execFileSync("git", ["-C", d, "init", "-q"])
  execFileSync("git", ["-C", d, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", d, "config", "user.name", "t"])
  writeFileSync(join(d, "README.md"), "x\n")
  execFileSync("git", ["-C", d, "add", "."])
  execFileSync("git", ["-C", d, "commit", "-q", "-m", "init"])
  return d
}
const real = (p) => realpathSync(p)
// 사용자·orca가 만든 워크스페이스를 흉내낸다 — harnie는 더 이상 worktree를 만들지 않지만, 세션이 그 안에서
// 시작하는 것은 오히려 권장 경로다(설계 §2).
function addWorktree(repo, branch) {
  const dir = join(mkdtempSync(join(tmpdir(), "harnie-user-wt-")), "wt")
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, dir])
  return dir
}

test("findRoot: 부모에만 .harnie/active.json이 있어도 현재 git repo가 root(상향 탈출 차단)", () => {
  const parent = mkdtempSync(join(tmpdir(), "harnie-parent-")) // 비-git 부모 워크스페이스
  mkdirSync(join(parent, ".harnie"), { recursive: true })
  writeFileSync(join(parent, ".harnie", "active.json"), JSON.stringify({ track: "plan", slug: "other-repo-run" }))
  const child = join(parent, "repo")
  mkdirSync(child)
  execFileSync("git", ["-C", child, "init", "-q"])
  assert.equal(real(findRoot(child)), real(child))                       // .git 경계에서 중단
  assert.equal(real(findRoot(join(child, "src", "deep"))), real(child))  // 미존재 하위 경로에서도 동일
  assert.equal(real(findRoot(parent)), real(parent))                     // 부모 자신은 그대로(회귀 없음)
})

test("findRoot: 중첩 git repo는 부모 repo의 active run에 바인딩되지 않음(승인 前 소스 Write allow)", () => {
  const { root } = setupRepo() // 부모 = planning phase active run
  const child = join(root, "vendor-repo")
  mkdirSync(child)
  execFileSync("git", ["-C", child, "init", "-q"])
  // 부모 run에 바인딩됐다면 planning 게이트로 deny였을 것
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(child, "src", "x.js") }, cwd: child }), null)
  // 부모 repo에서의 판정은 그대로 deny(회귀 없음)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root })))
})

// ── 0.14 D1: root 해석은 findRoot 하나다(세션 바인딩·worktree 레지스트리 삭제) ──
test("findRoot: 사용자 워크스페이스(worktree) 안에서 시작한 세션은 그 워크스페이스가 root(중첩 .git 파일)", () => {
  const repo = gitRepo("harnie-wt-findroot-")
  const wt = addWorktree(repo, "user/ws")
  assert.ok(existsSync(join(wt, ".git"))) // worktree의 .git은 디렉터리가 아니라 gitdir 파일
  assert.equal(real(findRoot(wt)), real(wt))                      // worktree 자신의 .git(파일)에서 중단
  assert.equal(real(findRoot(join(wt, "src", "deep"))), real(wt)) // 미존재 하위 경로도 동일
  assert.equal(real(findRoot(repo)), real(repo))                  // main repo에서 시작하면 여전히 main repo
})

// U1 카드 3 회귀: 0.13까지 findRoot은 `.harnie/active.json`을 `.git`보다 먼저 봤다. run root가 사용자 트리인
// 0.14에서 그 순서를 두면 하위 디렉터리에 남은 stale `.harnie/`가 git root를 이겨 run root가 엉뚱한 곳으로 간다.
test("findRoot: 하위 디렉터리의 stale `.harnie/`보다 git root가 우선", () => {
  const repo = gitRepo("harnie-findroot-order-")
  const stale = join(repo, "packages", "app")
  mkdirSync(join(stale, ".harnie"), { recursive: true })
  writeFileSync(join(stale, ".harnie", "active.json"), JSON.stringify({ track: "plan", slug: "stale-run" }))
  assert.equal(real(findRoot(stale)), real(repo))
  assert.equal(real(findRoot(join(stale, "src"))), real(repo))
  // repo root 자신의 `.harnie/`는 그대로 이 repo의 run이다(회귀 없음)
  mkdirSync(join(repo, ".harnie"), { recursive: true })
  writeFileSync(join(repo, ".harnie", "active.json"), JSON.stringify({ track: "plan", slug: "real-run" }))
  assert.equal(real(findRoot(repo)), real(repo))
})

function bootstrap(payload) {
  const r = spawnSync("node", [BOOT], { input: JSON.stringify(payload), encoding: "utf8" })
  return { status: r.status, stderr: r.stderr }
}
test("bootstrap: 비-git root면 exit 2 + 상태 미생성(verify/completion이 git 전제)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-nogit-"))
  const r = bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: "s1" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(existsSync(join(root, ".harnie")), false)
})

test("bootstrap: git root면 그 root에 run 상태를 만든다(0.14 — worktree 생성 없음)", () => {
  const root = gitRepo("harnie-boot-")
  const r = bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: "s1" })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(root, ".harnie", "active.json")))
})

// 0.14 D4: 게이트 조건에서 세션 소유 여부가 빠졌다. 활성 run이 있는 트리의 **모든** Claude 세션이 승인 前
// 게이트 대상이고, 나가는 길은 abandon 하나다(DEC-1). 아래 두 단정이 D4의 회귀 감시다.
test("세션 무관 게이트 e2e: bootstrap 세션도 진입한 적 없는 세션도 승인 前 소스 쓰기가 막힌다", () => {
  const root = gitRepo("harnie-session-agnostic-")
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: "owner-s" }).status, 0)
  const src = join(root, "src.js")
  for (const sid of ["owner-s", "never-entered", undefined])
    assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: sid })), String(sid))
  // 권위 파일 보호·.harnie 변형 차단은 그대로
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "active.json") }, cwd: root, session_id: "never-entered" })))
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf .harnie" }, cwd: root, session_id: "never-entered" })))
  // 게이트 밖(진짜 repo 밖 절대경로)은 여전히 통과 — 과잉 차단 아님
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(mkdtempSync(join(tmpdir(), "harnie-outside-")), "notes.md") }, cwd: root, session_id: "never-entered" }), null)
})

// CR-001 회귀: T1의 단순 Bash gate는 phase를 보지 않는다. run root 안의 평범한 git·test·read는
// blanket-deny되지 않고 정상 권한 흐름(null)으로 가야 한다. 반대로 `.harnie` 접근은 읽기여도 예외 없이 막힌다
// (설계 §8 — run root가 사용자 트리라 이 마찰이 상시가 되지만 완화하지 않는다).
test("run root 안 Bash는 자유롭고 `.harnie` 접근만 차단된다", () => {
  const root = gitRepo("harnie-cr001-")
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: "owner-s" }).status, 0)
  const own = { cwd: root, session_id: "owner-s", tool_name: "Bash" }
  for (const cmd of [`git -C ${root} status`, `node --test ${root}/x.test.mjs`, `cat ${root}/README.md`])
    assert.equal(hook(PRE, { ...own, tool_input: { command: cmd } }), null, cmd)
  for (const cmd of ["rm -rf .harnie", "cat .harnie/active.json", `cat ${root}/.harnie/active.json`, "find .harnie -delete"])
    assert.ok(deny(hook(PRE, { ...own, tool_input: { command: cmd } })), cmd)
})

// DEC-1: D4의 잠금은 출구와 한 몸으로만 성립한다. deny 문구가 slug와 출구를 담고, 그 출구가 실제로 Bash
// 게이트를 통과하며, 실행하면 잠금이 풀리는 것까지가 한 계약이다.
test("잠긴 트리의 출구: deny 문구의 abandon이 통과하고 실행하면 소스 쓰기가 풀린다", () => {
  const { root } = setupRepo() // planning phase active run(slug=feat-x)
  const src = join(root, "src", "a", "x.js")
  const bystander = { cwd: root, session_id: "bystander" }
  const blocked = hook(PRE, { ...bystander, tool_name: "Write", tool_input: { file_path: src } })
  assert.ok(deny(blocked))
  const why = blocked.hookSpecificOutput.permissionDecisionReason
  assert.match(why, /feat-x/)      // 어느 run이 잠갔는지
  assert.match(why, /abandon/)     // 나가는 길
  const cmd = `node ${EXEC} abandon --root ${root} --slug feat-x --confirm feat-x`
  assert.equal(hook(PRE, { ...bystander, tool_name: "Bash", tool_input: { command: cmd } }), null) // 신뢰 CLI로 통과
  assert.equal(exec(["abandon", "--root", root, "--slug", "feat-x", "--confirm", "feat-x"]).wasActive, true)
  assert.equal(hook(PRE, { ...bystander, tool_name: "Write", tool_input: { file_path: src } }), null)
})

test("Stop: 완료 후에도 트리가 바뀌면 같은 run이 다시 미완료로 잡힌다(완료 바인딩)", () => {
  const root = gitRepo("harnie-complete-rebind-")
  const task = "completion binds the tree"
  const sid = "owner-complete"
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: `/harnie:dev ${task}`, cwd: root, session_id: sid }).status, 0)
  const wt = root
  const slug = slugify(task)
  const dir = join(wt, ".harnie", "plan", slug)
  mkdirSync(join(wt, "src", "a"), { recursive: true })
  writeFileSync(join(wt, "src", "a", "x.js"), "x")
  writeFileSync(join(dir, "plan.md"), "# Plan\n\n```harnie-manifest\n" + JSON.stringify(MANIFEST, null, 2) + "\n```\n")

  exec(["arm-approval", "--root", wt, "--slug", slug, "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("complete-q"), cwd: root, session_id: sid })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "complete-q", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), cwd: root, session_id: sid })
  const postSHA = JSON.parse(execFileSync("node", [REAL_LOOP, "capture", wt], { encoding: "utf8" })).baselineSHA
  const taskDir = join(dir, "review", "task-a")
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(join(taskDir, "ledger.json"), "{}")
  writeFileSync(join(taskDir, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  exec(["verify", "--root", wt, "--slug", slug, "--task", "T1"])
  for (const unit of ["final-coverage", "final-quality", "final-runtime", "final-scope"]) {
    const gateDir = join(dir, "review", unit)
    mkdirSync(gateDir, { recursive: true })
    writeFileSync(join(gateDir, "ledger.json"), "{}")
    writeFileSync(join(gateDir, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: postSHA }))
  }
  assert.equal(exec(["completion", "--root", wt, "--slug", slug]).complete, true)

  assert.equal(hook(STOP, { cwd: root, session_id: sid, stop_hook_active: false, last_assistant_message: "HARNIE_STATUS: COMPLETE" }), null)
  writeFileSync(join(wt, "src", "a", "x.js"), "changed after complete")
  const blocked = hook(STOP, { cwd: root, session_id: sid, stop_hook_active: false, last_assistant_message: "HARNIE_STATUS: COMPLETE" })
  assert.equal(blocked.decision, "block")
  // 0.14 DEC-4: 차단만으로는 모델이 무엇을 재시도해야 할지 모른다. 문구가 변경 파일 목록, 판단 주체가
  // 사용자라는 사실, 그리고 판단 뒤의 유일한 진행 경로(rebind-tree)를 함께 담는다.
  assert.match(blocked.reason, /src\/a\/x\.js/)
  assert.match(blocked.reason, /사용자에게 물어라/)
  assert.match(blocked.reason, /rebind-tree/)
})

// 0.14: resume은 run을 이어갈 뿐 게이트 범위를 바꾸지 않는다(세션 소유 개념 삭제).
test("resume: 같은 작업 재호출은 같은 run을 잇고, 그 트리의 모든 세션이 계속 게이트 대상", () => {
  const root = gitRepo("harnie-resume-")
  const prompt = "/harnie:dev 합계 함수 추가"
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root, session_id: "sid-a" }).status, 0)
  const slug = JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).slug
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root, session_id: "sid-b" }).status, 0)
  assert.equal(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).slug, slug) // 같은 run
  const src = join(root, "src.js")
  for (const sid of ["sid-a", "sid-b", "never-entered"])
    assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: sid })), sid)
})

test("Stop: executing·미완료 run이 있으면 진입한 적 없는 세션도 완료 강제 대상(D4)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  for (const sid of ["owner-sid", "never-entered", undefined])
    assert.equal(hook(STOP, { cwd: root, session_id: sid, stop_hook_active: false, last_assistant_message: "작업 중" }).decision, "block", String(sid))
})

test("PostToolUse: 세션 무관하게 codex 스레드를 등록한다(D4 — 관찰도 세션을 보지 않는다)", () => {
  const { root } = setupRepo()
  const tid = "019facda-9999-8888-7777-666655554444"
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, tool_response: `{"threadId":"${tid}"}`, cwd: root, session_id: "never-entered" })
  assert.ok(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).readOnlyThreads.includes(tid))
})

test("bootstrap: 비-git에서 /harnie:dev는 exit 2 + 상태 미생성", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-nogit-"))
  const r = bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: "s1" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(existsSync(join(root, ".harnie")), false) // 비-git 워크스페이스에 상태 안 남김
})

test("bootstrap 0.12.2: /harnie:dev는 즉시 부트스트랩, non-git Skill 호출은 실패", () => {
  const root = gitRepo("harnie-latch-")
  const SID = "s-latch"
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: SID }).status, 0)
  assert.ok(existsSync(join(root, ".harnie", "active.json")))
  // Skill 채널도 비-git·비-워크스페이스에서는 fail-closed하고 상태를 남기지 않는다.
  const root2 = gitRepo("harnie-latch2-")
  renameSync(join(root2, ".git"), join(root2, ".git-off")) // 비-git·비-워크스페이스 → bootstrap 실패
  const r = bootstrap({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "harnie:dev", args: "합계 함수 추가" }, cwd: root2, session_id: SID })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(existsSync(join(root2, ".harnie")), false)
})

test("canonicalRelPath: outside(밖 절대경로) vs escapes(symlink·상대 traversal) 구분", () => {
  const root = gitRepo("harnie-canon-")
  const outside = mkdtempSync(join(tmpdir(), "harnie-outside-"))
  symlinkSync(outside, join(root, "escape"))
  const a = canonicalRelPath(root, join(outside, "notes.md"))
  assert.deepEqual([a.outside, a.escapes], [true, false])
  const b = canonicalRelPath(root, join(root, "escape", "x.js"))
  assert.deepEqual([b.outside, b.escapes], [false, true])
  const c = canonicalRelPath(root, join(root, "src", "x.js"))
  assert.deepEqual([c.outside, c.escapes], [false, false])
  // 상대경로 `../` traversal은 run root 기준 해석 → outside 아님(escapes 유지). outside로 분류되면 phase 게이트 우회가 된다.
  const d = canonicalRelPath(root, "../outside/x.js")
  assert.deepEqual([d.outside, d.escapes], [false, true])
  const e = canonicalRelPath(root, "src/../../outside/x.js")
  assert.deepEqual([e.outside, e.escapes], [false, true])
})

test("Write: 상대경로 traversal은 phase·owner 무관 deny(outside 오분류 회귀 방지)", () => {
  const { root } = setupRepo()
  toExecuting(root) // 소스 쓰기가 열린 phase에서도
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: "../evil.js" }, cwd: root })))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: "src/../../evil.js" }, cwd: root })))
})

test("Write: repo 밖이라도 다른 harnie run의 control 파일은 deny(권위 보호)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const foreign = gitRepo("harnie-foreign-")
  mkdirSync(join(foreign, ".harnie", "plan", "other"), { recursive: true })
  for (const f of [join(foreign, ".harnie", "active.json"), join(foreign, ".harnie", "plan", "other", "manifest.json")])
    assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: f }, cwd: root })), f)
  // 같은 외부 repo의 일반 소스는 그대로 allow(과잉 차단 없음)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(foreign, "src", "x.js") }, cwd: root }), null)
})

test("Write: repo 밖 절대경로는 allow(비활성·executing) — symlink 탈출 deny는 유지", () => {
  const target = join(mkdtempSync(join(tmpdir(), "harnie-outside-")), "notes.md")
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: target }, cwd: gitRepo("harnie-plain-") }), null)
  const { root } = setupRepo()
  toExecuting(root)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: target }, cwd: root }), null)
  // 승인 前(planning) repo 밖 쓰기는 guards.decideWriteEdit의 `outside` 파라미터가 붙으면 allow가 된다(세션 1 소유).
  // 훅은 outside를 전달하는 데까지가 책임이라 여기선 단정하지 않는다.
})

test("진입한 적 없는 세션도 승인 前 phase 게이트 대상(D4 — 이전의 비-owner 면제 폐지)", () => {
  const { root } = setupRepo() // planning
  const pl = (o) => ({ ...o, cwd: root, session_id: "unrelated-sid" })
  assert.ok(deny(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Task", tool_input: { subagent_type: "harnie-builder" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" } }))))
  // `.harnie` 밖 Bash는 phase를 보지 않으므로 그대로 통과(과잉 차단 아님)
  assert.equal(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "git fetch origin" } })), null)
  assert.equal(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "az repos pr list --status active" } })), null)
})

test("control/route 파일 Write·.harnie 변형 Bash는 세션 무관 deny", () => {
  const { root, dir } = setupRepo()
  const pl = (o) => ({ ...o, cwd: root, session_id: "unrelated-sid" })
  assert.ok(deny(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(dir, "manifest.json") } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "active.json") } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "rm -rf .harnie/plan/feat-x/review" } }))))
})

test(".harnie Bash 접근은 읽기 포함 deny", () => {
  const { root } = setupRepo()
  const pl = (o) => ({ ...o, cwd: root, session_id: "unrelated-sid" })
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "cat .harnie/active.json" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "jq .phase .harnie/plan/feat-x/execution.json" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "ls -la .harnie/plan/feat-x" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "echo x > .harnie/active.json" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "find .harnie -delete" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "rg x {--pre,/bin/rm} .harnie/active.json" } }))))
})

test("active run 없음: .harnie Bash 접근은 읽기 포함 deny", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-noact-read-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  const pl = (o) => ({ ...o, cwd: root, session_id: "s-any" })
  // active run 없음을 확정: 승인 前 게이트 대상인 소스 Write가 통과해야 한다(있다면 deny였을 것)
  assert.equal(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(root, "src.js") } })), null)
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "cat .harnie/active.json" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "rm -rf .harnie" } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "node -e \"require('fs').rmSync('.harnie/active.json')\"" } }))))
})

test("Stop: 활성 run 없는 트리는 통과(과잉 차단 감시)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-nostop-"))
  execFileSync("git", ["-C", root, "init", "-q"])
  assert.equal(hook(STOP, { cwd: root, session_id: "any", stop_hook_active: false, last_assistant_message: "끝" }), null)
})

test("PostToolUse: 승인 바인딩·빌더 등록 흐름은 세션 무관하게 동작", () => {
  const { root, dir } = setupRepo()
  const own = { cwd: root, session_id: "owner-sid" }
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("q-1"), ...own })
  // arm은 owner-sid가 걸었지만 다른 세션의 답이 그대로 소비된다(D4 — 관찰이 세션을 보지 않는다)
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), cwd: root, session_id: "other-sid" })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
  const tid = "019facda-aaaa-bbbb-cccc-ddddeeee0001"
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, tool_response: `{"threadId":"${tid}"}`, cwd: root, session_id: "other-sid" })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).tasks.T1.builderThreadId, tid)
})

// ── 0.11 S mode: 훅 면제(유효 phase=executing)와 Stop 완료 푸터 ─────────────
test("S mode: 승인 전 소스 쓰기 차단 면제 — sizing은 차단 유지, control 보호는 S에서도 불변", () => {
  const { root } = setupRepo() // mode=sizing
  const write = () => hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root })
  const d1 = write()
  assert.equal(d1.hookSpecificOutput.permissionDecision, "deny") // sizing = 승인 전 차단(보수 기본값)
  exec(["set-mode", "--root", root, "--slug", "feat-x", "--mode", "S"])
  assert.equal(write(), null) // S = 면제(allow)
  const ctrl = hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "plan", "feat-x", ".arm-rebind.json") }, cwd: root })
  assert.equal(ctrl.hookSpecificOutput.permissionDecision, "deny") // 신규 rebind arm 파일도 control 보호(CR-003)
  // S에서 write 서브에이전트·workspace-write codex(단일 building-unbound t1) 게이트도 열림
  assert.equal(hook(PRE, { tool_name: "Task", tool_input: { subagent_type: "harnie-builder" }, cwd: root }), null)
})

test("S mode Stop: APPROVED+트리 일치여도 COMPLETE 푸터 없으면 차단(CR-002), 푸터 갖추면 통과", () => {
  const { root } = setupRepo()
  exec(["set-mode", "--root", root, "--slug", "feat-x", "--mode", "S"])
  // 미완료(리뷰 유닛 없음): footer 없이 완료 주장 → 차단
  const blocked = hook(STOP, { cwd: root, last_assistant_message: "다 했습니다" })
  assert.equal(blocked.decision, "block")
  // canonical 유닛 APPROVED + 현재 트리 바인딩
  const unitDir = join(root, ".harnie", "plan", "feat-x", "review", "code")
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(join(unitDir, "state.json"), JSON.stringify({ round: 1, stagnation: 0, machineState: "APPROVED", reviewedPostSHA: captureTree(root) }))
  const noFooter = hook(STOP, { cwd: root, last_assistant_message: "다 했습니다" })
  assert.equal(noFooter.decision, "block") // 완료 판정이어도 푸터 없으면 false-completion 차단
  assert.match(noFooter.reason, /HARNIE_STATUS/)
  assert.equal(hook(STOP, { cwd: root, last_assistant_message: "완료.\nHARNIE_STATUS: COMPLETE" }), null)
  // 리뷰 후 트리 변경 → 다시 미완료
  writeFileSync(join(root, "src", "a", "x.js"), "changed")
  const drifted = hook(STOP, { cwd: root, last_assistant_message: "완료.\nHARNIE_STATUS: COMPLETE" })
  assert.equal(drifted.decision, "block")
})
