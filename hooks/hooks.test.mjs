// 훅 엔트리 통합/음성 테스트 — pretooluse/stop/posttooluse를 실제 stdin으로 구동(설계 §11 음성 세트).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync, realpathSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findRoot, canonicalRelPath, resolveRoot, readSessionBinding, writeSessionBinding, clearSessionBinding } from "./lib.mjs"
import { slugify } from "../scripts/execution.mjs"
import { worktreeDirFor, createWorktree } from "../scripts/worktree.mjs"

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
  assert.ok(deny(hook(PRE, { tool_name: "Edit", tool_input: { file_path: join(dir, "design", "errata.md") }, cwd: root })))
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

test("codex: executing 첫 빌더 호출은 building task 자신의 worktree cwd만 allow", () => {
  const { root } = setupRepo()
  toExecuting(root)
  const taskWt = join(root, ".harnie-wt", "harnie-feat-x-tT1")
  mkdirSync(taskWt, { recursive: true })
  const ti = { sandbox: "workspace-write", cwd: taskWt }
  // 아직 building 표시 없음 → deny
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: ti, cwd: root })))
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: ti, cwd: root }), null)
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root }, cwd: root })))
  // cwd 누락이면 building-unbound라도 deny
  assert.ok(deny(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, cwd: root })))
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

test("PostToolUse: 복수 building을 tool_input.cwd의 task worktree로 각각 귀속하고 lookalike는 거부", () => {
  const { root, dir } = setupRepo()
  const manifest = { ...MANIFEST, tasks: [...MANIFEST.tasks, { id: "T2", deps: [], reviewUnit: "task-b", scope: ["src/b/"], verification: MANIFEST.tasks[0].verification }] }
  writeFileSync(join(dir, "plan.md"), "# Plan\n\n```harnie-manifest\n" + JSON.stringify(manifest, null, 2) + "\n```\n")
  toExecuting(root)
  for (const id of ["T1", "T2"]) exec(["set-task", "--root", root, "--slug", "feat-x", "--task", id, "--run-status", "building"])
  const wt1 = join(root, ".harnie-wt", "harnie-feat-x-tT1")
  const wt2 = join(root, ".harnie-wt", "harnie-feat-x-tT2")
  const lookalike = join(root, ".harnie-wt", "harnie-feat-x-tT1-copy")
  for (const p of [wt1, wt2, lookalike]) mkdirSync(p, { recursive: true })
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: lookalike }, tool_response: '{"threadId":"lookalike"}', cwd: root })
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: wt2 }, tool_response: '{"threadId":"thread-2"}', cwd: root })
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: wt1 }, tool_response: '{"threadId":"thread-1"}', cwd: root })
  const ex = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"))
  assert.equal(ex.tasks.T1.builderThreadId, "thread-1")
  assert.equal(ex.tasks.T2.builderThreadId, "thread-2")
  assert.ok(!Object.values(ex.tasks).some((t) => t.builderThreadId === "lookalike"))
})

test("rebind marker: run-root 호출만 지정 task에 원자 재바인딩하고 marker를 소거", () => {
  const { root, dir } = setupRepo()
  toExecuting(root)
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  const firstWt = join(root, ".harnie-wt", "harnie-feat-x-tT1"); mkdirSync(firstWt, { recursive: true })
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: firstWt }, tool_response: '{"threadId":"old-thread"}', cwd: root })
  exec(["rebind-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--reason", "correction:E-001"])
  assert.equal(hook(PRE, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root }, cwd: root }), null)
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root }, tool_response: '{"threadId":"new-thread"}', cwd: root })
  const ex = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"))
  assert.equal(ex.tasks.T1.builderThreadId, "new-thread")
  assert.equal(ex.pendingRunRootBootstrap, undefined)
})

test("errata-arm: 다음 AskUserQuestion 승인만 disposition+correction을 기록", () => {
  const { root, dir } = setupRepo()
  exec(["errata-add", "--root", root, "--slug", "feat-x", "--severity", "blocker", "--design-ref", "rev-1.md §D3", "--defect", "설계 오류"])
  exec(["errata-arm", "--root", root, "--slug", "feat-x", "--id", "E-001", "--disposition", "approved-workaround", "--correction", "정정 기준"])
  hook(PRE, { ...askPayload("errata-q"), cwd: root })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "errata-q", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), cwd: root })
  const text = readFileSync(join(dir, "design", "errata.md"), "utf8")
  assert.match(text, /disposition: approved-workaround \(user approved/)
  assert.match(text, /correction: 정정 기준/)
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

test("baseline: control/route 파일 raw 변경 차단 — Write canonical·Bash 단순 literal", () => {
  const root = pendingRepo("s1")
  // Write는 canonical containment로 견고하게 차단(active 없어도)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: routeFilePath(root, "s1") }, cwd: root, session_id: "other" })))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "active.json") }, cwd: root, session_id: "other" })))
  // 단순 `.harnie` 정규식으로 literal 접근을 차단한다.
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm " + routeFilePath(root, "s1") }, cwd: root, session_id: "other" })))
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: 'rm .har""nie/pending-route/s1.json' }, cwd: root, session_id: "other" }), null)
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

// ── 과잉 차단(overreach) 제거: root 탐색 경계·비-git bootstrap·repo 밖 쓰기·owner 스코프 ──
// worktree add(T2)가 HEAD를 요구하므로(unborn HEAD면 실패) 최초 커밋을 남긴다.
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
// dev-full의 run 상태는 root가 아니라 그 worktree 안에 있다(T2 DEC-001) — task 텍스트로 결정적 경로 계산.
const wtFor = (root, task) => worktreeDirFor(root, `harnie/${slugify(task)}`)

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

// ── worktree-per-run(T2): findRoot이 worktree의 nested `.git` 파일에서 올바로 멈추는지, resolveRoot·세션
// 바인딩 해석 순서(①cwd 상향 findRoot ②세션 바인딩)가 계약대로 동작하는지 ──
test("findRoot: worktree 안에서 시작한 세션은 그 worktree가 root(중첩 .git 파일 케이스)", () => {
  const repo = gitRepo("harnie-wt-findroot-")
  const wt = createWorktree({ repo, branch: "harnie/wt-root-test" }).worktreePath
  assert.ok(existsSync(join(wt, ".git"))) // worktree의 .git은 디렉터리가 아니라 gitdir 파일
  assert.equal(real(findRoot(wt)), real(wt))                      // worktree 자신의 .git(파일)에서 중단
  assert.equal(real(findRoot(join(wt, "src", "deep"))), real(wt)) // 미존재 하위 경로도 동일
  assert.equal(real(findRoot(repo)), real(repo))                  // main repo에서 시작하면 여전히 main repo
})

test("resolveRoot: 세션 바인딩 없으면 findRoot과 동일(하위호환)", () => {
  const root = gitRepo("harnie-resolve-1-")
  assert.equal(resolveRoot(root, "any-sid"), findRoot(root))
  assert.equal(resolveRoot(root, null), findRoot(root))
})

test("resolveRoot: 세션 바인딩이 cwdRoot 자신의 (무관한) active.json보다 항상 우선(CR-003 회귀)", () => {
  const { root } = setupRepo() // root 자신에 이 세션과 무관한 run의 active.json 존재(예: 다른 세션·quick 잔재)
  const wt = mkdtempSync(join(tmpdir(), "harnie-real-wt-"))
  execFileSync("git", ["-C", wt, "init", "-q"])
  writeSessionBinding(root, "sid-x", wt)
  // 바인딩된 세션은 root 자신의 active.json에 가려지지 않고 자기 worktree로 해석된다.
  assert.equal(resolveRoot(join(root, "src"), "sid-x"), wt)
  // 바인딩 없는(무관한) 세션은 여전히 root 자신의 active.json으로(하위호환).
  assert.equal(resolveRoot(join(root, "src"), "other-sid"), root)
})

test("resolveRoot: 세션이 이미 worktree 안에서 시작했으면(cwd 자체가 그 worktree) findRoot이 그대로 자기 root를 준다", () => {
  const repo = gitRepo("harnie-resolve-startin-")
  const wt = createWorktree({ repo, branch: "harnie/start-in-wt" }).worktreePath
  // 이 세션의 바인딩은 main repo(=repo)에 없다 — 그래도 cwd가 이미 그 worktree 안이면 findRoot이 그 .git에서 멈춘다.
  assert.equal(resolveRoot(join(wt, "src"), "no-binding-sid"), wt)
})

test("세션 바인딩: write/read/resolveRoot가 그걸 따라가고, clear 후엔 findRoot로 폴백(②)", () => {
  const root = gitRepo("harnie-resolve-2-")
  const wt = mkdtempSync(join(tmpdir(), "harnie-fake-wt-"))
  execFileSync("git", ["-C", wt, "init", "-q"])
  writeSessionBinding(root, "sid-y", wt)
  assert.deepEqual(readSessionBinding(root, "sid-y"), { workroot: wt })
  assert.equal(resolveRoot(root, "sid-y"), wt)
  assert.equal(resolveRoot(root, "other-sid"), root) // 다른 세션은 미적용
  clearSessionBinding(root, "sid-y")
  assert.equal(readSessionBinding(root, "sid-y"), null)
  assert.equal(resolveRoot(root, "sid-y"), root) // 정리 후엔 findRoot로 폴백
})

test("세션 바인딩: workroot가 사라졌으면(정리·이동 등) resolveRoot가 findRoot로 폴백", () => {
  const root = gitRepo("harnie-resolve-3-")
  writeSessionBinding(root, "sid-z", join(root, "nonexistent-wt"))
  assert.equal(resolveRoot(root, "sid-z"), root)
})

test("세션 바인딩 파일은 control path로 보호(다른 세션이 raw로 못 지움·못 씀)", () => {
  const root = gitRepo("harnie-resolve-4-")
  writeSessionBinding(root, "sid-w", "/tmp/whatever")
  const bindingPath = join(root, ".harnie", "sessions", "sid-w.json")
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: bindingPath }, cwd: root, session_id: "other" })))
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: `printf x > ${bindingPath}` }, cwd: root, session_id: "other" })))
})

function bootstrap(payload) {
  const r = spawnSync("node", [BOOT], { input: JSON.stringify(payload), encoding: "utf8" })
  return { status: r.status, stderr: r.stderr }
}
test("bootstrap: 비-git root면 exit 2 + 상태 미생성(verify/completion이 git 전제)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-nogit-"))
  const r = bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev-full 합계 함수 추가", cwd: root, session_id: "s1" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(existsSync(join(root, ".harnie")), false)
})

test("bootstrap: git root면 정상 생성(worktree 안에, 회귀 방지)", () => {
  const root = gitRepo("harnie-boot-")
  const r = bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev-full 합계 함수 추가", cwd: root, session_id: "s1" })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(wtFor(root, "합계 함수 추가"), ".harnie", "active.json")))
  assert.equal(existsSync(join(root, ".harnie", "active.json")), false) // main root에는 run 상태를 두지 않음(T2)
})

// owner 스코프 활성화 e2e: bootstrap이 sentinel에 소유자를 기록하므로 owner/비-owner 분리가 실제로 발동한다.
// (기록이 없던 동안 isOwnerSession은 항상 true를 반환해 스코프가 inert였다 — 아래 두 단정이 그 회귀 감시.)
// 세션 cwd는 계속 main root(worktree 밖)이지만, 게이트 대상 파일은 그 run의 worktree 안이어야 한다(T2) —
// main root 자신의 다른 파일은 이제 이 run 기준으로 "밖"이라 phase 게이트 대상이 아니다(§outside 규칙 그대로).
test("owner 스코프 e2e: bootstrap 세션은 승인 前 게이트 적용, 무관한 세션은 미적용", () => {
  const root = gitRepo("harnie-owner-e2e-")
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev-full 합계 함수 추가", cwd: root, session_id: "owner-s" }).status, 0)
  const wt = wtFor(root, "합계 함수 추가")
  const src = join(wt, "src.js")
  // owner 세션: planning phase 게이트 적용 → worktree 안 소스 Write deny(cwd는 main root 그대로)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "owner-s" })))
  // 무관한 세션: run 단위 게이트 미적용 → 통과(실측 피해였던 PR 리뷰 루틴 케이스)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "unrelated-s" }), null)
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: "git fetch origin" }, cwd: root, session_id: "unrelated-s" }), null)
  // 비-owner여도 권위 파일 보호·.harnie 변형 차단은 유지 — main root 자신의 .harnie(세션 바인딩)와
  // worktree(nested) 안의 .harnie 둘 다(worktree는 root 트리 안에 있으므로 이 fix가 핵심 회귀 감시).
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(wt, ".harnie", "active.json") }, cwd: root, session_id: "unrelated-s" })))
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf .harnie" }, cwd: root, session_id: "unrelated-s" })))
})

// CR-001/CR-002 회귀(Opus 리뷰): worktree 안에서 Bash 빌드/테스트/git이 실제로 되는지 + main root 쓰기는
// 여전히 승인 前 게이트 대상인지, 둘 다 실제 bootstrap+PRE 훅으로.
test("worktree 안 Bash는 자유롭고(CR-001), main root 소스 쓰기는 여전히 승인 前 게이트 대상(CR-002)", () => {
  const root = gitRepo("harnie-cr001-002-")
  const task = "합계 함수 추가"
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: `/harnie:dev-full ${task}`, cwd: root, session_id: "owner-s" }).status, 0)
  const wt = wtFor(root, task)
  const own = { cwd: root, session_id: "owner-s" }
  // CR-001: T1의 단순 Bash gate는 phase를 보지 않는다. 실제 worktree 안의 git·test·plain read는
  // `.harnie-wt` 컨테이너명 때문에 blanket-deny되지 않고 정상 권한 흐름(null)으로 간다.
  for (const cmd of [`git -C ${wt} status`, `node --test ${wt}/x.test.mjs`, `cat ${wt}/README.md`])
    assert.equal(hook(PRE, { ...own, tool_name: "Bash", tool_input: { command: cmd } }), null, cmd)
  // 컨테이너 자체·nested/direct .harnie 접근은 읽기여도 예외 없이 차단한다. trailing
  // slash·glob도(CR-004 회귀 — 셸 탭완성·정리 명령이 흔히 만드는 형태, 놓치면 이 세션의 run뿐 아니라 같은
  // repo의 다른 세션 run들의 권위 상태까지 한 번에 지워진다).
  for (const cmd of ["rm -rf .harnie-wt", "rm -rf .harnie-wt/", "rm -rf .harnie-wt/*", "find .harnie-wt/ -name active.json -delete"])
    assert.ok(deny(hook(PRE, { ...own, tool_name: "Bash", tool_input: { command: cmd } })), cmd)
  for (const cmd of ["rm -rf .harnie", "cat .harnie/active.json", ".harnie/pending-route/x.json", `cat ${wt}/.harnie/active.json`])
    assert.ok(deny(hook(PRE, { ...own, tool_name: "Bash", tool_input: { command: cmd } })), cmd)
  // CR-002: main root(=this run의 worktree 밖, 그러나 같은 repo 안)에 쓰는 건 여전히 승인 前 deny — outside로
  // 오분류돼 게이트를 빠져나가면 안 된다(고쳐지기 前엔 이 assert가 실패했다).
  assert.ok(deny(hook(PRE, { ...own, tool_name: "Write", tool_input: { file_path: join(root, "src.js") } })))
  // 진짜 repo 밖 절대경로(스크래치패드 등)는 그대로 allow(과잉 차단 아님, 회귀 없음).
  const outside = mkdtempSync(join(tmpdir(), "harnie-outside-"))
  assert.equal(hook(PRE, { ...own, tool_name: "Write", tool_input: { file_path: join(outside, "notes.md") } }), null)
})

test("Stop: complete 후에도 세션 바인딩이 살아 후속 변경을 같은 workroot에서 재검증(CR-002)", () => {
  const root = gitRepo("harnie-binding-complete-")
  const task = "binding survives completion"
  const sid = "owner-complete"
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: `/harnie:dev-full ${task}`, cwd: root, session_id: sid }).status, 0)
  const wt = wtFor(root, task)
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
  assert.equal(readSessionBinding(root, sid).workroot, wt)
  assert.equal(resolveRoot(root, sid), wt)
  writeFileSync(join(wt, "src", "a", "x.js"), "changed after complete")
  assert.equal(hook(STOP, { cwd: root, session_id: sid, stop_hook_active: false, last_assistant_message: "HARNIE_STATUS: COMPLETE" }).decision, "block")
})

test("owner 스코프 e2e: resume은 소유자를 **추가**한다 — 이전 세션 보호 유지 + 재개 세션도 강제(양방향 fail-open 회귀)", () => {
  const root = gitRepo("harnie-owner-resume-")
  const task = "합계 함수 추가"
  const prompt = `/harnie:dev-full ${task}`
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root, session_id: "sid-a" }).status, 0)
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root, session_id: "sid-b" }).status, 0) // resume(같은 worktree에 attach)
  const wt = wtFor(root, task)
  const src = join(wt, "src.js")
  // 재개 세션에 강제 적용(추가 안 하면 fail-open)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "sid-b" })))
  // **아직 작업 중인 이전 소유 세션도 계속 보호**(교체하면 여기가 뚫린다 — 리뷰 P1)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "sid-a" })))
  // 진입하지 않은 무관한 세션은 여전히 미적용
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "never-entered" }), null)
  const s = JSON.parse(readFileSync(join(wt, ".harnie", "active.json"), "utf8"))
  assert.deepEqual(s.sessionIds, ["sid-a", "sid-b"])
})

// 소유자 집합을 직접 심는다(bootstrap 없이 executing 상태의 H2·PostToolUse를 검사하기 위해).
function setOwners(root, sids) {
  const f = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(f, "utf8"))
  s.sessionIds = sids
  delete s.sessionId
  writeFileSync(f, JSON.stringify(s))
}
test("owner 스코프: 동시 활성 이전 소유자도 H1·H2·PostToolUse 보호를 계속 받는다(리뷰 P1 회귀)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  setOwners(root, ["sid-a", "sid-b"]) // sid-a가 진입, sid-b가 resume한 상태
  // H1: 두 소유자 모두 .harnie 변형 차단(권위 보호) — executing이라 소스 쓰기는 정상 허용
  for (const sid of ["sid-a", "sid-b"])
    assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf .harnie" }, cwd: root, session_id: sid })), sid)
  // H2: 두 소유자 모두 미완료 Stop이 block(교체 방식이면 sid-a가 그냥 통과했다)
  for (const sid of ["sid-a", "sid-b"])
    assert.equal(hook(STOP, { cwd: root, session_id: sid, stop_hook_active: false, last_assistant_message: "작업 중" }).decision, "block", sid)
  // 진입하지 않은 세션은 Stop 강제 미적용(과잉 차단 제거 유지)
  assert.equal(hook(STOP, { cwd: root, session_id: "never-entered", stop_hook_active: false, last_assistant_message: "작업 중" }), null)
  // PostToolUse: 이전 소유자의 codex 관찰도 계속 등록된다
  const tid = "019facda-9999-8888-7777-666655554444"
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, tool_response: `{"threadId":"${tid}"}`, cwd: root, session_id: "sid-a" })
  assert.ok(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).readOnlyThreads.includes(tid))
})

test("owner 스코프 e2e: sid-a → 식별자 없는 resume → sid-b resume 순서에서도 sid-a 보호 유지(리뷰 P1 회귀)", () => {
  const root = gitRepo("harnie-owner-noid-")
  const task = "합계 함수 추가"
  const prompt = `/harnie:dev-full ${task}`
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root, session_id: "sid-a" }).status, 0)
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root }).status, 0)                    // session_id 없는 resume(바인딩 기록 불가·no-op)
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt, cwd: root, session_id: "sid-b" }).status, 0)
  const wt = wtFor(root, task)
  assert.deepEqual(JSON.parse(readFileSync(join(wt, ".harnie", "active.json"), "utf8")).sessionIds, ["sid-a", "sid-b"])
  const src = join(wt, "src.js")
  // H1: 두 참여 세션 모두 승인 前 Write deny(비웠다면 sid-a가 통과했다)
  for (const sid of ["sid-a", "sid-b"])
    assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: sid })), sid)
  // (H2·PostToolUse는 executing 상태가 필요하므로 아래 테스트에서 검사한다 — planning엔 완료 강제가 없다.)
  // 진입하지 않은 세션은 여전히 미적용
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "never-entered" }), null)
})

test("owner 스코프: 식별자 없는 resume 후에도 이전 소유자가 H2·PostToolUse 대상(executing 상태, 리뷰 P1)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  setOwners(root, ["sid-a"])
  // 식별자 없는 resume → sid-b resume 을 상태 수준에서 재현(bootstrap 없이 executing을 유지하기 위해)
  const f = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(f, "utf8")); s.sessionIds = ["sid-a", "sid-b"]; writeFileSync(f, JSON.stringify(s))
  for (const sid of ["sid-a", "sid-b"])
    assert.equal(hook(STOP, { cwd: root, session_id: sid, stop_hook_active: false, last_assistant_message: "작업 중" }).decision, "block", sid)
  const tid = "019facda-5555-4444-3333-222211110000"
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, tool_response: `{"threadId":"${tid}"}`, cwd: root, session_id: "sid-a" })
  assert.ok(JSON.parse(readFileSync(f, "utf8")).readOnlyThreads.includes(tid))
})

test("owner 스코프: H1 승인 前 소스 Write도 두 소유자 모두에게 적용", () => {
  const { root } = setupRepo() // planning
  setOwners(root, ["sid-a", "sid-b"])
  const src = join(root, "src", "a", "x.js")
  for (const sid of ["sid-a", "sid-b"])
    assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: sid })), sid)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: src }, cwd: root, session_id: "never-entered" }), null)
})

test("bootstrap 라우터: 비-git에서 /harnie:dev는 exit 2 + pending-route 미생성(latch 방지)", () => {
  const root = mkdtempSync(join(tmpdir(), "harnie-nogit-"))
  const r = bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: "s1" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(existsSync(join(root, ".harnie")), false) // 비-git 워크스페이스에 상태 안 남김
})

test("bootstrap 라우터 전체 흐름: dev(pending) → dev-full 실패 시 route 삭제", () => {
  const root = gitRepo("harnie-latch-")
  const SID = "s-latch"
  assert.equal(bootstrap({ hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev 합계 함수 추가", cwd: root, session_id: SID }).status, 0)
  assert.equal(JSON.parse(readFileSync(routeFilePath(root, SID), "utf8")).state, "pending")
  renameSync(join(root, ".git"), join(root, ".git-off")) // dev-full 시점엔 root가 비-git(비-git 워크스페이스 진입 시뮬)
  const r = bootstrap({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "harnie:dev-full", args: "합계 함수 추가" }, cwd: root, session_id: SID })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /git repo/)
  assert.equal(existsSync(routeFilePath(root, SID)), false)
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

// owner 세션 스코프: sentinel.sessionId는 세션 3이 createRun에서 기록(계약). 테스트는 그 계약을 직접 심는다.
function setOwner(root, sid) {
  const f = join(root, ".harnie", "active.json")
  const s = JSON.parse(readFileSync(f, "utf8"))
  s.sessionId = sid
  writeFileSync(f, JSON.stringify(s))
}
test("비-owner 세션: 승인 前 phase 게이트 미적용(소스 Write·비-read-only Bash·write 에이전트 allow)", () => {
  const { root } = setupRepo() // planning
  setOwner(root, "owner-sid")
  const pl = (o) => ({ ...o, cwd: root, session_id: "unrelated-sid" })
  assert.equal(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") } })), null)
  assert.equal(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "git fetch origin" } })), null)          // 실측 피해: PR 리뷰 루틴의 git
  assert.equal(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "az repos pr list --status active" } })), null)
  assert.equal(hook(PRE, pl({ tool_name: "Task", tool_input: { subagent_type: "harnie-builder" } })), null)
  assert.equal(hook(PRE, pl({ tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" } })), null)
})

test("비-owner 세션: control/route 파일 Write·.harnie 변형 Bash는 계속 deny", () => {
  const { root, dir } = setupRepo()
  setOwner(root, "owner-sid")
  const pl = (o) => ({ ...o, cwd: root, session_id: "unrelated-sid" })
  assert.ok(deny(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(dir, "manifest.json") } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Write", tool_input: { file_path: join(root, ".harnie", "active.json") } }))))
  assert.ok(deny(hook(PRE, pl({ tool_name: "Bash", tool_input: { command: "rm -rf .harnie/plan/feat-x/review" } }))))
})

test("비-owner 세션: .harnie Bash 접근은 읽기 포함 deny", () => {
  const { root } = setupRepo()
  setOwner(root, "owner-sid")
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

test("비-owner 세션이라도 자기 pending-route가 있으면 차단(게이트 독립, P1-2)", () => {
  const { root } = setupRepo()
  setOwner(root, "owner-sid")
  mkdirSync(join(root, ".harnie", "pending-route"), { recursive: true })
  writeFileSync(join(root, ".harnie", "pending-route", "unrelated-sid.json"), JSON.stringify({ state: "pending", at: new Date().toISOString() }))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root, session_id: "unrelated-sid" })))
})

test("owner 세션: 승인 前 소스 Write deny(회귀 방지)", () => {
  const { root } = setupRepo()
  setOwner(root, "owner-sid")
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root, session_id: "owner-sid" })))
})

test("Stop: 비-owner 세션은 owner run이 executing·미완료여도 통과(H1과 대칭, #5)", () => {
  const { root } = setupRepo()
  toExecuting(root) // owner run = executing·미완료
  setOwner(root, "owner-sid")
  assert.equal(hook(STOP, { cwd: root, session_id: "unrelated-sid", stop_hook_active: false, last_assistant_message: "무관한 작업 끝" }), null)
})

test("Stop: owner 세션은 기존대로 차단(회귀 방지)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  setOwner(root, "owner-sid")
  const r = hook(STOP, { cwd: root, session_id: "owner-sid", stop_hook_active: false, last_assistant_message: "작업 중" })
  assert.equal(r.decision, "block")
})

test("Stop: 비-owner라도 자기 pending-route가 있으면 계속 차단(순서 — route 먼저, owner 판정 나중)", () => {
  const { root } = setupRepo()
  toExecuting(root)
  setOwner(root, "owner-sid")
  mkdirSync(join(root, ".harnie", "pending-route"), { recursive: true })
  writeFileSync(routeFilePath(root, "unrelated-sid"), JSON.stringify({ state: "pending", at: new Date().toISOString() }))
  const r = hook(STOP, { cwd: root, session_id: "unrelated-sid", stop_hook_active: false, last_assistant_message: "끝" })
  assert.equal(r.decision, "block")
})

test("PostToolUse: 비-owner는 threadId 등록·승인 바인딩 안 함(owner run 상태 오염 방지)", () => {
  const { root, dir } = setupRepo()
  setOwner(root, "owner-sid")
  const other = { cwd: root, session_id: "unrelated-sid" }
  // ① read-only codex → readOnlyThreads 미등록
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, tool_response: '{"threadId":"019facda-1111-2222-3333-44445555dead"}', ...other })
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).readOnlyThreads, [])
  // ② 승인 바인딩: pending은 owner가 기록했더라도 비-owner의 답은 소비되면 안 됨
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("q-1"), cwd: root, session_id: "owner-sid" })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), ...other })
  assert.notEqual(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
  // ③ workspace-write codex → building-unbound task에 빌더 미등록
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), cwd: root, session_id: "owner-sid" }) // owner가 승인 → executing
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, tool_response: '{"threadId":"019facda-aaaa-bbbb-cccc-dddd5555beef"}', ...other })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).tasks.T1.builderThreadId, null)
})

test("PostToolUse: owner(sessionId 일치)의 등록·승인 흐름은 그대로 유지", () => {
  const { root, dir } = setupRepo()
  setOwner(root, "owner-sid")
  const own = { cwd: root, session_id: "owner-sid" }
  exec(["arm-approval", "--root", root, "--slug", "feat-x", "--question", AQ, "--approve-option", "승인"])
  hook(PRE, { ...askPayload("q-1"), ...own })
  hook(POST, { tool_name: "AskUserQuestion", tool_use_id: "q-1", tool_response: JSON.stringify({ answers: { [AQ]: "승인" } }), ...own })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).phase, "executing")
  const tid = "019facda-aaaa-bbbb-cccc-ddddeeee0001"
  exec(["set-task", "--root", root, "--slug", "feat-x", "--task", "T1", "--run-status", "building"])
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write" }, tool_response: `{"threadId":"${tid}"}`, ...own })
  assert.equal(JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).tasks.T1.builderThreadId, tid)
  const rid = "019facda-1111-2222-3333-444455550002"
  hook(POST, { tool_name: "mcp__codex__codex", tool_input: { sandbox: "read-only" }, tool_response: `{"threadId":"${rid}"}`, ...own })
  assert.ok(JSON.parse(readFileSync(join(root, ".harnie", "active.json"), "utf8")).readOnlyThreads.includes(rid))
})

// ── 워크스페이스 run 통합(멀티레포) ──────────────────────────────────────
test("워크스페이스 run: 오너 세션 승인 전 멤버 repo 쓰기 deny·run 상태 쓰기 allow, 타 세션은 워크스페이스에서 게이트 없음", () => {
  const w = mkdtempSync(join(tmpdir(), "harnie-hooks-ws-"))
  const repoA = join(w, "repoA")
  execFileSync("git", ["init", "-q", repoA])
  execFileSync("git", ["-C", repoA, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", repoA, "config", "user.name", "t"])
  mkdirSync(join(repoA, "src"), { recursive: true }); writeFileSync(join(repoA, "src", "x.js"), "x")
  execFileSync("git", ["-C", repoA, "add", "."])
  execFileSync("git", ["-C", repoA, "commit", "-q", "-m", "init"])
  const own = { cwd: w, session_id: "s-ws" }
  // 실제 bootstrap 훅으로 workspace run 생성(세션 바인딩 포함)
  hook(BOOT, { hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev-full ws hook task", ...own })
  const slug = slugify("ws hook task")
  const runRoot = worktreeDirFor(w, `harnie/${slug}`)
  assert.ok(existsSync(join(runRoot, ".harnie", "active.json")))
  const added = exec(["repo-add", "--root", runRoot, "--repo", repoA])
  assert.equal(added.key, "repoA")
  // 오너 세션: 승인 전 멤버 workroot 소스 쓰기 deny(워크스페이스 안은 전부 승인-전 게이트)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(added.workroot, "src", "n.js") }, ...own })))
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(w, "somewhere.txt") }, ...own })))
  // 오너 세션: run 상태 산출물(plan.md)은 allow
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(runRoot, ".harnie", "plan", slug, "plan.md") }, ...own }), null)
  // 다른 세션: 같은 워크스페이스 아무 데나 써도 게이트 없음(W에 active.json이 없으므로 비활성)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(w, "other-session.txt") }, cwd: w, session_id: "s-other" }), null)
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(repoA, "src", "x.js") }, cwd: repoA, session_id: "s-other" }), null)
})

// 실측 회귀(관측 ④): 세션 id 교체(재개·컴팩션)로 비-owner가 된 세션이 run root에서 신뢰 CLI를 부르면,
// 저하 분기가 멤버 workroot 문맥을 안 넘겨 `loop.mjs delta <멤버 repo>`가 세션 중반부터 일제히 차단됐다.
test("워크스페이스 run: 비-owner 세션도 멤버 repo 대상 신뢰 CLI(delta)는 차단하지 않음", () => {
  const w = mkdtempSync(join(tmpdir(), "harnie-hooks-ws-nonowner-"))
  const repoA = join(w, "repoA")
  execFileSync("git", ["init", "-q", repoA])
  execFileSync("git", ["-C", repoA, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", repoA, "config", "user.name", "t"])
  writeFileSync(join(repoA, "x.js"), "x")
  execFileSync("git", ["-C", repoA, "add", "."])
  execFileSync("git", ["-C", repoA, "commit", "-q", "-m", "init"])
  hook(BOOT, { hook_event_name: "UserPromptSubmit", prompt: "/harnie:dev-full ws nonowner task", cwd: w, session_id: "s-ws-owner" })
  const runRoot = worktreeDirFor(w, `harnie/${slugify("ws nonowner task")}`)
  const added = exec(["repo-add", "--root", runRoot, "--repo", repoA])
  const mid = { cwd: runRoot, session_id: "s-ws-midswap" } // owner 아님, cwd는 run root
  const cmd = `node ${REAL_LOOP} delta ${added.workroot} 0123456789abcdef0123456789abcdef01234567 --out ${join(added.workroot, ".harnie", "review", "u", "delta.patch")}`
  assert.equal(hook(PRE, { tool_name: "Bash", tool_input: { command: cmd }, ...mid }), null)
  // 신뢰 CLI가 아닌 .harnie 접근은 비-owner에게도 계속 차단 + 신뢰 CLI 형태의 인자 오류엔 진단이 실린다
  assert.ok(deny(hook(PRE, { tool_name: "Bash", tool_input: { command: `cat ${join(runRoot, ".harnie", "active.json")}` }, ...mid })))
  const bad = hook(PRE, { tool_name: "Bash", tool_input: { command: cmd.replace(added.workroot, join(w, "unregistered")) }, ...mid })
  assert.ok(deny(bad))
  assert.match(bad.hookSpecificOutput.permissionDecisionReason, /승인 실패/)
})

test("owner 미기록 sentinel(구버전·stale): 식별된 세션은 잠그지 않고, session_id 부재 payload만 fail-closed", () => {
  const { root } = setupRepo() // sentinel에 owner 기록 없음(구버전 스키마/stale run)
  // 실측 사고 회귀 감시: harnie를 실행한 적 없는 세션이 "빈 목록 = 전원 owner" 폴백으로
  // 워크스페이스 전체 소스 쓰기가 잠겼다 — 식별된 세션은 이제 게이트 미적용.
  assert.equal(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root, session_id: "anyone" }), null)
  // 식별 불가 호출은 구분할 수 없으므로 여전히 보수적으로 적용(하위호환 fail-closed)
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root })))
  setOwner(root, "owner-sid") // owner 기록됐지만 payload에 session_id 없음 → 동일하게 보수적 적용
  assert.ok(deny(hook(PRE, { tool_name: "Write", tool_input: { file_path: join(root, "src", "a", "x.js") }, cwd: root })))
})
