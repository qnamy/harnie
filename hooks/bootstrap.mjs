#!/usr/bin/env node
// 진입점 bootstrap 훅 — 스킬 A0의 자체 init을 대체해 sentinel을 결정적으로 생성한다(부트스트랩 갭 제거).
// 설계: docs/bootstrap-adherence.md.
//   UserPromptSubmit(직접 slash): `/harnie:dev-full` → bootstrap. `/harnie:dev`(라우터) → pending-route 기록(P1-2).
//     `/harnie:dev-quick`·비-harnie → no-op.
//   PreToolUse(Skill): tool_input.skill === "harnie:dev-full" → bootstrap. "harnie:dev-quick" → 라우팅 해소. 기타 → no-op.
// 성공·no-op = exit 0. 실패(빈 인자·malformed payload·손상·미완료 run 충돌·예외) = exit 2 → invocation 차단(fail-closed).
import { findRoot } from "./lib.mjs"
import { bootstrapRun, slugify, writePendingRoute, clearPendingRoute, markRouteFailed } from "../scripts/execution.mjs"

function fail(msg) { process.stderr.write(`harnie bootstrap: ${msg}\n`); process.exit(2) }
function ok() { process.exit(0) }

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
  const doBootstrap = (base) => {
    try { bootstrapRun(root, { base, track: "plan", sessionId }) }
    catch (e) { const msg = e && e.message ? e.message : String(e); markRouteFailed(root, sessionId, msg); fail(msg) }
    ok()
  }

  if (event === "UserPromptSubmit") {
    const prompt = typeof p.prompt === "string" ? p.prompt : ""
    const mFull = prompt.match(/^\/harnie:dev-full(?:\s+([\s\S]*))?$/) // 정확 prefix(뒤=공백|끝); `dev-full-x` 오매치 방지
    if (mFull) {
      const base = slugify((mFull[1] || "").trim())
      if (!base) fail("작업 인자가 비어 있음 — `/harnie:dev-full <작업 설명>` 형태로 실행하세요")
      doBootstrap(base)
    }
    if (/^\/harnie:dev-quick(?:\s|$)/.test(prompt)) { clearPendingRoute(root, sessionId); ok() } // 직접 quick 진입 = 이 세션 라우팅 해소(deferred)
    const mDev = prompt.match(/^\/harnie:dev(?:\s+([\s\S]*))?$/) // 라우터(정확 prefix; dev-full/dev-quick은 위에서 처리)
    if (mDev) {
      if (!(mDev[1] || "").trim()) fail("`/harnie:dev`에 작업 설명이 필요합니다 — `/harnie:dev <작업>`") // 빈 인자 → exit 2(P1-1)
      writePendingRoute(root, sessionId); ok()                                                        // 라우터: track 미정 → pending-route 게이트
    }
    ok() // 비-harnie·미스매치
  } else if (event === "PreToolUse" && p.tool_name === "Skill") {
    const skill = p.tool_input && p.tool_input.skill
    if (skill === "harnie:dev-full") {
      const base = slugify(String((p.tool_input && p.tool_input.args) || "").trim())
      if (!base) fail("작업 인자가 비어 있음 — dev-full skill args 필요")
      doBootstrap(base)
    }
    if (skill === "harnie:dev-quick") { clearPendingRoute(root, sessionId); ok() } // quick으로 이 세션 라우팅 해소(deferred machine)
    ok() // 기타 skill
  } else {
    ok() // 미지원 이벤트
  }
} catch (e) {
  fail(e && e.message ? e.message : String(e))
}
