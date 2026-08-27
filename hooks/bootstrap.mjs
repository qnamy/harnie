#!/usr/bin/env node
// 진입점 bootstrap 훅 — 스킬 A0의 자체 init을 대체해 sentinel을 결정적으로 생성한다(부트스트랩 갭 제거).
// 설계: docs/bootstrap-adherence.md.
//   UserPromptSubmit(직접 slash): `/harnie:dev`만 즉시 worktree 생성 + bootstrap(T2 DEC-001; mode는
//     sizing으로 시작). 0.12.2에서 제거된 `/harnie:dev-full`·`/harnie:dev-quick` 호환 라우트는
//     부트스트랩하지 않고 `/harnie:dev` 사용 안내만 반환한다. 비-harnie → no-op.
//   PreToolUse(Skill): tool_input.skill === "harnie:dev"만 즉시 worktree 생성 + bootstrap. 제거된 두 호환
//     라우트 이름이 payload로 직접 전달되면 같은 안내만 반환한다. 기타 → no-op.
// 성공·no-op = exit 0. 실패(빈 인자·malformed payload·손상·미완료 run 충돌·이미 바인딩된 세션·예외) = exit 2 → invocation 차단(fail-closed).
//
// worktree-per-run(T2): `/harnie:dev` run은 매번 `<mainRoot>/.harnie-wt/harnie-<slug>` worktree를 만들고 run 상태
// (`.harnie/`)를 그 worktree 안에 둔다. 세션 cwd는 계속 main 작업트리이므로, 이 훅은 성공 시 워크루트 절대경로를
// 오케스트레이터에게 알려준다(additionalContext/permissionDecisionReason) — 그 뒤 모든 execution.mjs·loop.mjs
// `--root`와 codex builder `cwd`는 이 워크루트여야 한다(main root 아님).
import { existsSync } from "node:fs"
import { join } from "node:path"
import { findRoot, readSessionBinding, writeSessionBinding } from "./lib.mjs"
import { bootstrapRun, slugify } from "../scripts/execution.mjs"
import { createWorktree, worktreeDirFor } from "../scripts/worktree.mjs"

const RETIRED_ROUTE_MSG =
  "harnie: `/harnie:dev-full`·`/harnie:dev-quick`는 0.12.2에서 제거된 호환 라우트입니다(스킬 본문은 0.12.0에서 이미 삭제됨) — " +
  "부트스트랩하지 않았습니다. 대신 `/harnie:dev <작업 설명>`으로 시작하세요(크기 S/M/L은 파이프라인이 판정)."

function fail(msg) { process.stderr.write(`harnie bootstrap: ${msg}\n`); process.exit(2) }
function ok() { process.exit(0) }
// UserPromptSubmit 성공 경로: `/harnie:dev` UPS 결과를 오케스트레이터 컨텍스트에 주입한다.
function okContext(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) + "\n")
  process.exit(0)
}
// PreToolUse(Skill) 성공 경로: additionalContext 지원 여부가 불확실하므로 permissionDecisionReason도 함께 채운다
// (`harnie:dev` Skill 성공 경로).
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
const NOT_RUNNABLE = (root) => `harnie는 git repo 안에서만 실행됩니다 — 현재 root(${root})는 git repo가 아님`
// repo 모드 판정: root 자체가 git 작업트리인가(디렉터리 .git 또는 worktree의 .git 파일).
function isGitRoot(root) { return existsSync(join(root, ".git")) }

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
  const sessionId = p.session_id // 세션→run 바인딩에 사용한다.
  // bootstrap 성공은 emit이 이벤트에 맞는 방식으로 exit하고, 실패는 호출을 fail-closed한다.
  const doBootstrap = (base, emit) => {
    try {
      // 실행 가능 root 판정: root 자체가 git repo여야 한다(worktree-per-run). 그 외는 fail-closed —
      // 검증·완료 재도출이 git을 전제하므로 상태만 생기고 머신이 돌 수 없는 곳에 run을 만들지 않는다.
      // 0.13: 비-git 워크스페이스(멀티레포) 모드는 삭제됐다(L 소멸로 진입 경로 없음).
      if (!isGitRoot(root)) throw new Error(NOT_RUNNABLE(root))
      // 한 세션 = 한 run(v1 고정): 이미 이 세션이 (아직 정리되지 않은) **다른** run에 바인딩돼 있으면 새 run을 만들지
      // 않는다. 같은 작업(같은 base → 같은 worktree 경로)의 재호출은 resume이므로 허용한다.
      const branch = `harnie/${base}`
      const targetPath = worktreeDirFor(root, branch) // <root>/.harnie-wt/harnie-<base>
      const existing = readSessionBinding(root, sessionId)
      if (existing && existsSync(existing.workroot) && existing.workroot !== targetPath)
        throw new Error(`이 세션은 이미 다른 run에 바인딩됨(${existing.workroot}) — 한 세션 = 한 run(v1). 다른 작업은 새 세션에서 /harnie:dev로 시작하세요.`)
      // worktree-per-run(DEC-001): run 상태는 main root가 아니라 이 worktree 안에 생성한다. from 생략 = 현재 HEAD에서 분기.
      const { worktreePath: workroot } = createWorktree({ repo: root, branch })
      bootstrapRun(workroot, { base, track: "plan", sessionId })
      // session_id 없는 호출(구버전 하위호환·payload 부재)은 바인딩을 기록할 키가 없다 — 이런 호출은 이후
      // resolveRoot로 자기 worktree를 못 찾아 게이트가 느슨해질 수 있음을 알고 감내한다(적대적 방어 비목표,
      // 실제 Claude Code 훅은 항상 session_id를 준다). 식별 가능한 호출만 기록한다.
      if (sessionId) writeSessionBinding(root, sessionId, workroot)
      emit(workroot)
    } catch (e) { const msg = e && e.message ? e.message : String(e); fail(msg) }
  }
  const runMessage = (wt) => workrootMessage(root, sessionId, wt)

  if (event === "UserPromptSubmit") {
    const prompt = typeof p.prompt === "string" ? p.prompt : ""
    // 0.12.2에서 제거된 호환 라우트는 정확한 경계로만 안내한다(`dev-full-x`는 완전한 no-op).
    const mFull = prompt.match(/^\/harnie:dev-full(?:\s+([\s\S]*))?$/) // 정확 prefix(뒤=공백|끝); `dev-full-x` 오매치 방지
    if (mFull) okContext(RETIRED_ROUTE_MSG)
    if (/^\/harnie:dev-quick(?:\s|$)/.test(prompt)) okContext(RETIRED_ROUTE_MSG)
    const mDev = prompt.match(/^\/harnie:dev(?:\s+([\s\S]*))?$/) // 0.11 단일 파이프라인 진입(정확 prefix; dev-full/dev-quick은 위에서 처리)
    if (mDev) {
      const base = slugify((mDev[1] || "").trim())
      if (!base) fail("`/harnie:dev`에 작업 설명이 필요합니다 — `/harnie:dev <작업>`") // 빈 인자 → exit 2(P1-1)
      // `/harnie:dev`는 유일한 라이브 진입점이며 즉시 부트스트랩한다(mode는 sizing으로 시작).
      doBootstrap(base, (wt) => okContext(runMessage(wt)))
    }
    ok() // 비-harnie·미스매치
  } else if (event === "PreToolUse" && p.tool_name === "Skill") {
    const skill = p.tool_input && p.tool_input.skill
    if (skill === "harnie:dev-full" || skill === "harnie:dev-quick") okAllow(RETIRED_ROUTE_MSG)
    if (skill === "harnie:dev") {
      const base = slugify(String((p.tool_input && p.tool_input.args) || "").trim())
      if (!base) fail(`작업 인자가 비어 있음 — ${skill} skill args 필요`)
      doBootstrap(base, (wt) => okAllow(runMessage(wt)))
    }
    ok() // 기타 skill
  } else {
    ok() // 미지원 이벤트
  }
} catch (e) {
  fail(e && e.message ? e.message : String(e))
}
