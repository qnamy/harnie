#!/usr/bin/env node
// 진입점 bootstrap 훅 — 스킬 A0의 자체 init을 대체해 sentinel을 결정적으로 생성한다(부트스트랩 갭 제거).
// 설계: docs/bootstrap-adherence.md.
//   UserPromptSubmit(직접 slash): `/harnie:dev-full` → worktree 생성 + bootstrap(T2 DEC-001). `/harnie:dev`(라우터)
//     → pending-route 기록(P1-2). `/harnie:dev-quick`·비-harnie → no-op.
//   PreToolUse(Skill): tool_input.skill === "harnie:dev-full" → worktree 생성 + bootstrap. "harnie:dev-quick" →
//     라우팅 해소. 기타 → no-op.
// 성공·no-op = exit 0. 실패(빈 인자·malformed payload·손상·미완료 run 충돌·이미 바인딩된 세션·예외) = exit 2 → invocation 차단(fail-closed).
//
// worktree-per-run(T2): dev-full은 매 run마다 `<mainRoot>/.harnie-wt/harnie-<slug>` worktree를 만들고 run 상태
// (`.harnie/`)를 그 worktree 안에 둔다. 세션 cwd는 계속 main 작업트리이므로, 이 훅은 성공 시 워크루트 절대경로를
// 오케스트레이터에게 알려준다(additionalContext/permissionDecisionReason) — 그 뒤 모든 execution.mjs·loop.mjs
// `--root`와 codex builder `cwd`는 이 워크루트여야 한다(main root 아님).
//
// 워크스페이스 run(멀티레포, v0.4.0): root가 git repo가 아니어도 직속 하위에 git repo가 있으면(예: ~/Tradlinx)
// dev-full을 허용한다 — run root는 `<workspace>/.harnie-wt/harnie-<slug>/` **평범한 디렉터리**이고 sentinel에
// workspaceRoot·repos가 실린다. 멤버 repo worktree는 이후 `execution.mjs repo-add`가 만든다. 워크스페이스 root
// 자체에는 active.json을 만들지 않아(세션 바인딩·pending-route만) 다른 세션·작업은 게이트에 걸리지 않는다.
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { findRoot, readSessionBinding, writeSessionBinding } from "./lib.mjs"
import { bootstrapRun, slugify, clearPendingRoute } from "../scripts/execution.mjs"
import { createWorktree, worktreeDirFor } from "../scripts/worktree.mjs"

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts")

function fail(msg) { process.stderr.write(`harnie bootstrap: ${msg}\n`); process.exit(2) }
function ok() { process.exit(0) }
// UserPromptSubmit 성공 경로: 워크루트를 오케스트레이터 컨텍스트에 주입(직접 `/harnie:dev-full` 진입).
function okContext(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) + "\n")
  process.exit(0)
}
// PreToolUse(Skill) 성공 경로: additionalContext 지원 여부가 불확실하므로 permissionDecisionReason도 함께 채운다
// (라우터 `/harnie:dev` → Skill(harnie:dev-full) 경로).
function okAllow(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: text, additionalContext: text } }) + "\n")
  process.exit(0)
}
function workrootMessage(mainRoot, sessionId, workroot) {
  return `harnie run workroot: ${workroot}\n` +
    `This run's state lives in a dedicated git worktree, not "${mainRoot}". Use "${workroot}" as --root for every ` +
    `execution.mjs/loop.mjs call and as cwd for Codex builder calls in this run. If this message becomes unavailable ` +
    `later, recover it by reading "workroot" from ${mainRoot}/.harnie/sessions/${sessionId}.json.`
}
function workspaceWorkrootMessage(workspaceRoot, sessionId, runRoot) {
  return `harnie WORKSPACE run workroot: ${runRoot}\n` +
    `This is a multi-repo workspace run. Run state lives in "${runRoot}" (a plain directory — not a git worktree); ` +
    `the workspace root is "${workspaceRoot}". Rules for this run:\n` +
    `- Use "${runRoot}" as --root for every execution.mjs call and for loop.mjs apply / loop.mjs capture of Final Wave gates.\n` +
    `- BEFORE the approval gate, register every repo this task will modify: ` +
    `node ${join(SCRIPTS_DIR, "execution.mjs")} repo-add --root ${runRoot} --repo <absolute repo path under the workspace>. ` +
    `Each call creates that repo's dedicated worktree (<repo>/.harnie-wt/harnie-<slug>) and prints its key + workroot.\n` +
    `- Every manifest task must carry "repo": "<key>" (from repo-add output). Task scope paths, verification cwd, ` +
    `Codex builder cwd, and loop.mjs capture/delta for that task all use that repo's workroot, not "${runRoot}".\n` +
    `- If this message becomes unavailable later, recover the workroot from ${workspaceRoot}/.harnie/sessions/${sessionId}.json.`
}

const NOT_RUNNABLE = (root) => `harnie는 git repo 안 또는 git repo들을 담은 워크스페이스 디렉터리에서만 실행됩니다 — 현재 root(${root})는 git repo도 아니고 직속 하위에 git repo도 없음`
// repo 모드 판정: root 자체가 git 작업트리인가(디렉터리 .git 또는 worktree의 .git 파일).
function isGitRoot(root) { return existsSync(join(root, ".git")) }
// 워크스페이스 판정(실수-안전): 직속 하위(depth 1)에 git repo가 하나라도 있으면 워크스페이스로 본다.
// 홈 디렉터리 같은 엉뚱한 곳에서의 오발동을 막는 최소 확인 — repo-add가 등록 시점에 다시 엄격 검증한다.
function isWorkspaceRoot(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .some((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(root, e.name, ".git")))
  } catch { return false }
}

// strict stdin read: malformed/빈 payload는 fail-closed(P2-4). lib.readStdin은 파싱오류를 {}로 삼켜 fail-open이라 쓰지 않는다.
function readPayload() {
  return new Promise((res) => {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => (buf += d))
    process.stdin.on("end", () => res(buf))
    if (process.stdin.isTTY) res("")
  })
}

const raw = await readPayload()
let p
try {
  if (!raw || !raw.trim()) fail("빈 hook payload — fail-closed")
  p = JSON.parse(raw)
} catch (e) {
  fail(`hook payload 파싱 실패 — fail-closed: ${e && e.message ? e.message : e}`)
}

try {
  const event = p.hook_event_name || ""
  const root = findRoot(p.cwd)
  const sessionId = p.session_id // pending-route는 session-scoped(P1-3): 다른 세션이 해제하지 못하게
  // bootstrap 실패면 pending-route를 지우고 호출을 fail-closed한다. 성공은 emit이 그 이벤트에 맞는 방식으로 exit.
  const doBootstrap = (base, emit) => {
    try {
      // 실행 가능 root 판정: ① root 자체가 git repo → repo 모드(worktree-per-run) ② 비-git이지만 직속 하위에
      // git repo가 있는 워크스페이스 → workspace 모드(멀티레포 run) ③ 그 외 → fail-closed(검증·완료 재도출이
      // git을 전제하므로 상태만 생기고 머신이 돌 수 없는 곳에 run을 만들지 않는다).
      const workspaceMode = !isGitRoot(root)
      if (workspaceMode && !isWorkspaceRoot(root)) throw new Error(NOT_RUNNABLE(root))
      // 한 세션 = 한 run(v1 고정): 이미 이 세션이 (아직 정리되지 않은) **다른** run에 바인딩돼 있으면 새 run을 만들지
      // 않는다. 같은 작업(같은 base → 같은 worktree 경로)의 재호출은 resume이므로 허용한다.
      const branch = `harnie/${base}`
      const targetPath = worktreeDirFor(root, branch) // 두 모드 모두 <root>/.harnie-wt/harnie-<base>
      const existing = readSessionBinding(root, sessionId)
      if (existing && existsSync(existing.workroot) && existing.workroot !== targetPath)
        throw new Error(`이 세션은 이미 다른 run에 바인딩됨(${existing.workroot}) — 한 세션 = 한 run(v1). 다른 작업은 새 세션에서 /harnie:dev-full로 시작하세요.`)
      let workroot
      if (workspaceMode) {
        // workspace run: run root는 git worktree가 아니라 평범한 디렉터리. 멤버 repo worktree는 나중에
        // execution.mjs repo-add가 만든다. 워크스페이스 root(W) 자체에는 active.json을 절대 만들지 않으므로
        // W에서 도는 다른 세션·작업은 어떤 게이트에도 걸리지 않는다.
        mkdirSync(targetPath, { recursive: true })
        bootstrapRun(targetPath, { base, track: "plan", sessionId, workspaceRoot: root })
        workroot = targetPath
      } else {
        // worktree-per-run(DEC-001): run 상태는 main root가 아니라 이 worktree 안에 생성한다. from 생략 = 현재 HEAD에서 분기.
        const { worktreePath } = createWorktree({ repo: root, branch })
        bootstrapRun(worktreePath, { base, track: "plan", sessionId })
        workroot = worktreePath
      }
      // bootstrapRun 내부의 pending-route 해소는 (workroot, sessionId) 기준이라 항상 no-op이 된다 —
      // pending-route는 main root(세션 cwd)에 기록되므로 여기서 명시적으로 해소한다(멱등: 없으면 그냥 통과).
      clearPendingRoute(root, sessionId)
      // session_id 없는 호출(구버전 하위호환·payload 부재)은 바인딩을 기록할 키가 없다 — 이런 호출은 이후
      // resolveRoot로 자기 worktree를 못 찾아 게이트가 느슨해질 수 있음을 알고 감내한다(적대적 방어 비목표,
      // 실제 Claude Code 훅은 항상 session_id를 준다). 식별 가능한 호출만 기록한다.
      if (sessionId) writeSessionBinding(root, sessionId, workroot)
      emit(workroot, workspaceMode)
    } catch (e) { const msg = e && e.message ? e.message : String(e); clearPendingRoute(root, sessionId); fail(msg) }
  }
  const runMessage = (wt, workspaceMode) =>
    workspaceMode ? workspaceWorkrootMessage(root, sessionId, wt) : workrootMessage(root, sessionId, wt)

  if (event === "UserPromptSubmit") {
    const prompt = typeof p.prompt === "string" ? p.prompt : ""
    const mFull = prompt.match(/^\/harnie:dev-full(?:\s+([\s\S]*))?$/) // 정확 prefix(뒤=공백|끝); `dev-full-x` 오매치 방지
    if (mFull) {
      const base = slugify((mFull[1] || "").trim())
      if (!base) fail("작업 인자가 비어 있음 — `/harnie:dev-full <작업 설명>` 형태로 실행하세요")
      doBootstrap(base, (wt, wsMode) => okContext(runMessage(wt, wsMode)))
    }
    if (/^\/harnie:dev-quick(?:\s|$)/.test(prompt)) { clearPendingRoute(root, sessionId); ok() } // 0.11: alias — 본문이 harnie:dev 스킬로 체이닝하면 Skill 훅이 부트스트랩
    const mDev = prompt.match(/^\/harnie:dev(?:\s+([\s\S]*))?$/) // 0.11 단일 파이프라인 진입(정확 prefix; dev-full/dev-quick은 위에서 처리)
    if (mDev) {
      const base = slugify((mDev[1] || "").trim())
      if (!base) fail("`/harnie:dev`에 작업 설명이 필요합니다 — `/harnie:dev <작업>`") // 빈 인자 → exit 2(P1-1)
      // 0.11: 라우터 폐지 — /harnie:dev가 곧 파이프라인 진입이므로 pending-route 없이 즉시 부트스트랩한다
      // (mode는 sizing으로 시작하고 오케스트레이터가 set-mode로 확정한다).
      doBootstrap(base, (wt, wsMode) => okContext(runMessage(wt, wsMode)))
    }
    ok() // 비-harnie·미스매치
  } else if (event === "PreToolUse" && p.tool_name === "Skill") {
    const skill = p.tool_input && p.tool_input.skill
    if (skill === "harnie:dev-full" || skill === "harnie:dev") {
      const base = slugify(String((p.tool_input && p.tool_input.args) || "").trim())
      if (!base) fail(`작업 인자가 비어 있음 — ${skill} skill args 필요`)
      doBootstrap(base, (wt, wsMode) => okAllow(runMessage(wt, wsMode)))
    }
    if (skill === "harnie:dev-quick") { clearPendingRoute(root, sessionId); ok() } // 0.11 alias: 본문이 harnie:dev로 체이닝
    ok() // 기타 skill
  } else {
    ok() // 미지원 이벤트
  }
} catch (e) {
  fail(e && e.message ? e.message : String(e))
}
