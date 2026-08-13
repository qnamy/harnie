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
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { findRoot, readSessionBinding, writeSessionBinding } from "./lib.mjs"
import { bootstrapRun, slugify, writePendingRoute, clearPendingRoute, markRouteFailed } from "../scripts/execution.mjs"
import { createWorktree, worktreeDirFor } from "../scripts/worktree.mjs"

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

const GIT_ONLY = (root) => `harnie는 git repo 안에서만 실행됩니다 — 현재 root: ${root}`
// root에서 git이 동작하는지(=`git -C <root> …`가 성립). execution.mjs의 verify/completion 전제 확인용.
function isGitRepo(root) {
  try { execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], { stdio: "ignore" }); return true }
  catch { return false }
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
  // bootstrap 시도 실패면 pending을 failed로 전환(P1-1): 작업은 계속 막되 Stop이 정직한 실패 보고 후 허용·정리. 성공은 bootstrapRun이 pending 해소.
  // emit(workroot): 성공 시 이벤트별 종료 방식(UserPromptSubmit=additionalContext, PreToolUse=allow+reason)으로 exit.
  const doBootstrap = (base, emit) => {
    // git 검사도 **markRouteFailed 경로 안에서** 실패해야 한다: 밖에서 바로 fail하면 이미 기록된 pending이
    // 그대로 남아 Stop이 영원히 차단(정직 보고 탈출구는 `failed` 상태에만 있음) → 세션 고착(P1).
    try {
      // git repo 밖에서는 run을 만들지 않는다: 검증·완료 재도출(execution.mjs verify/completion)이 `git -C <root>`를
      // 전제하므로, 비-git 워크스페이스(예: repo 여러 개를 담은 부모 디렉터리)에 상태만 생기고 머신이 돌 수 없다.
      if (!isGitRepo(root)) throw new Error(GIT_ONLY(root))
      // 한 세션 = 한 run(v1 고정): 이미 이 세션이 (아직 정리되지 않은) **다른** run에 바인딩돼 있으면 새 run을 만들지
      // 않는다. 같은 작업(같은 base → 같은 worktree 경로)의 재호출은 resume이므로 허용한다.
      const branch = `harnie/${base}`
      const targetPath = worktreeDirFor(root, branch)
      const existing = readSessionBinding(root, sessionId)
      if (existing && existsSync(existing.workroot) && existing.workroot !== targetPath)
        throw new Error(`이 세션은 이미 다른 run에 바인딩됨(${existing.workroot}) — 한 세션 = 한 run(v1). 다른 작업은 새 세션에서 /harnie:dev-full로 시작하세요.`)
      // worktree-per-run(DEC-001): run 상태는 main root가 아니라 이 worktree 안에 생성한다. from 생략 = 현재 HEAD에서 분기.
      const { worktreePath } = createWorktree({ repo: root, branch })
      bootstrapRun(worktreePath, { base, track: "plan", sessionId })
      // bootstrapRun 내부의 pending-route 해소는 (worktreePath, sessionId) 기준이라 항상 no-op이 된다 —
      // pending-route는 main root(세션 cwd)에 기록되므로 여기서 명시적으로 해소한다(멱등: 없으면 그냥 통과).
      clearPendingRoute(root, sessionId)
      // session_id 없는 호출(구버전 하위호환·payload 부재)은 바인딩을 기록할 키가 없다 — 이런 호출은 이후
      // resolveRoot로 자기 worktree를 못 찾아 게이트가 느슨해질 수 있음을 알고 감내한다(적대적 방어 비목표,
      // 실제 Claude Code 훅은 항상 session_id를 준다). 식별 가능한 호출만 기록한다.
      if (sessionId) writeSessionBinding(root, sessionId, worktreePath)
      emit(worktreePath)
    } catch (e) { const msg = e && e.message ? e.message : String(e); markRouteFailed(root, sessionId, msg); fail(msg) }
  }

  if (event === "UserPromptSubmit") {
    const prompt = typeof p.prompt === "string" ? p.prompt : ""
    const mFull = prompt.match(/^\/harnie:dev-full(?:\s+([\s\S]*))?$/) // 정확 prefix(뒤=공백|끝); `dev-full-x` 오매치 방지
    if (mFull) {
      const base = slugify((mFull[1] || "").trim())
      if (!base) fail("작업 인자가 비어 있음 — `/harnie:dev-full <작업 설명>` 형태로 실행하세요")
      doBootstrap(base, (wt) => okContext(workrootMessage(root, sessionId, wt)))
    }
    if (/^\/harnie:dev-quick(?:\s|$)/.test(prompt)) { clearPendingRoute(root, sessionId); ok() } // 직접 quick 진입 = 이 세션 라우팅 해소(deferred)
    const mDev = prompt.match(/^\/harnie:dev(?:\s+([\s\S]*))?$/) // 라우터(정확 prefix; dev-full/dev-quick은 위에서 처리)
    if (mDev) {
      if (!(mDev[1] || "").trim()) fail("`/harnie:dev`에 작업 설명이 필요합니다 — `/harnie:dev <작업>`") // 빈 인자 → exit 2(P1-1)
      // 라우터 단계에서 먼저 거른다: 비-git에선 어차피 bootstrap이 실패하므로, pending-route(=`.harnie/` 상태)를
      // 비-git 워크스페이스에 만들지 않고 즉시 실패. 게이트가 걸리기 前이라 latch도 남지 않는다.
      if (!isGitRepo(root)) fail(GIT_ONLY(root))
      writePendingRoute(root, sessionId); ok()                                                        // 라우터: track 미정 → pending-route 게이트
    }
    ok() // 비-harnie·미스매치
  } else if (event === "PreToolUse" && p.tool_name === "Skill") {
    const skill = p.tool_input && p.tool_input.skill
    if (skill === "harnie:dev-full") {
      const base = slugify(String((p.tool_input && p.tool_input.args) || "").trim())
      if (!base) fail("작업 인자가 비어 있음 — dev-full skill args 필요")
      doBootstrap(base, (wt) => okAllow(workrootMessage(root, sessionId, wt)))
    }
    if (skill === "harnie:dev-quick") { clearPendingRoute(root, sessionId); ok() } // quick으로 이 세션 라우팅 해소(deferred machine)
    ok() // 기타 skill
  } else {
    ok() // 미지원 이벤트
  }
} catch (e) {
  fail(e && e.message ? e.message : String(e))
}
