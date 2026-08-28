#!/usr/bin/env node
// 진입점 bootstrap 훅 — 스킬 A0의 자체 init을 대체해 sentinel을 결정적으로 생성한다(부트스트랩 갭 제거).
// 설계: docs/bootstrap-adherence.md.
//   UserPromptSubmit(직접 slash): `/harnie:dev`만 즉시 bootstrap(mode는 sizing으로 시작). 0.12.2에서 제거된
//     `/harnie:dev-full`·`/harnie:dev-quick` 호환 라우트는 부트스트랩하지 않고 안내만 반환한다. 비-harnie → no-op.
//   PreToolUse(Skill): tool_input.skill === "harnie:dev"만 즉시 bootstrap. 제거된 두 호환 라우트 이름이
//     payload로 직접 전달되면 같은 안내만 반환한다. 기타 → no-op.
// 성공·no-op = exit 0. 실패(빈 인자·malformed payload·손상·미완료 run 충돌·예외) = exit 2 → invocation 차단(fail-closed).
//
// 0.14 D1: run root = 세션 cwd의 git repo root다(main 브랜치 포함). harnie는 worktree를 만들지도 지우지도
// 않는다 — 격리는 사용자와 orca가 만든 워크스페이스가 제공한다. 그래서 이 훅이 하는 일은 셋뿐이다:
// git repo 확인, `.harnie/`의 info/exclude 등록, bootstrapRun.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { findRoot, ensureExcludeEntries } from "./lib.mjs"
import { bootstrapRun, slugify } from "../scripts/execution.mjs"

const RETIRED_ROUTE_MSG =
  "harnie: `/harnie:dev-full`·`/harnie:dev-quick`는 0.12.2에서 제거된 호환 라우트입니다(스킬 본문은 0.12.0에서 이미 삭제됨) — " +
  "부트스트랩하지 않았습니다. 대신 `/harnie:dev <작업 설명>`으로 시작하세요(크기 S/M은 파이프라인이 판정)."

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
const NOT_RUNNABLE = (root) => `harnie는 git repo 안에서만 실행됩니다 — 현재 root(${root})는 git repo가 아님`
// repo 모드 판정: root 자체가 git 작업트리인가(디렉터리 .git 또는 worktree의 .git 파일).
function isGitRoot(root) { return existsSync(join(root, ".git")) }
// 기본 브랜치 경고(차단 아님, 설계 §8). D1이 차단을 배제했으므로 통지만 한다.
function defaultBranchWarning(root) {
  let branch = null
  try { branch = execFileSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim() } catch { return "" }
  if (branch !== "main" && branch !== "master") return ""
  return `\nWARNING: 이 run은 기본 브랜치(${branch})에서 시작합니다. 격리가 필요하면 워크스페이스(orca worktree)를 먼저 만들고 거기서 다시 시작하세요.`
}
function runMessage(root, slug, warning) {
  return `harnie run root: ${root} (slug ${slug})\n` +
    `이 run의 상태는 ${root}/.harnie/ 에 있습니다. 모든 execution.mjs/loop.mjs 호출의 --root와 codex builder cwd로 ` +
    `이 경로를 쓰세요.${warning}`
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
  const sessionId = p.session_id
  // bootstrap 성공은 emit이 이벤트에 맞는 방식으로 exit하고, 실패는 호출을 fail-closed한다.
  const doBootstrap = (base, emit) => {
    try {
      // 실행 가능 root 판정: root 자체가 git repo여야 한다. 그 외는 fail-closed — 검증·완료 재도출이 git을
      // 전제하므로 상태만 생기고 머신이 돌 수 없는 곳에 run을 만들지 않는다.
      if (!isGitRoot(root)) throw new Error(NOT_RUNNABLE(root))
      ensureExcludeEntries(root, ".harnie/")
      const result = bootstrapRun(root, { base, track: "plan", sessionId })
      emit(runMessage(root, result.slug, defaultBranchWarning(root)))
    } catch (e) { const msg = e && e.message ? e.message : String(e); fail(msg) }
  }

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
      doBootstrap(base, okContext)
    }
    ok() // 비-harnie·미스매치
  } else if (event === "PreToolUse" && p.tool_name === "Skill") {
    const skill = p.tool_input && p.tool_input.skill
    if (skill === "harnie:dev-full" || skill === "harnie:dev-quick") okAllow(RETIRED_ROUTE_MSG)
    if (skill === "harnie:dev") {
      const base = slugify(String((p.tool_input && p.tool_input.args) || "").trim())
      if (!base) fail(`작업 인자가 비어 있음 — ${skill} skill args 필요`)
      doBootstrap(base, okAllow)
    }
    ok() // 기타 skill
  } else {
    ok() // 미지원 이벤트
  }
} catch (e) {
  fail(e && e.message ? e.message : String(e))
}
