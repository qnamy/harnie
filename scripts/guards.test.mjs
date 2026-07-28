// guards.mjs 테스트 — 강제 훅 순수 결정 함수(H1 Write/Bash/Task/Codex, H2 Stop).
import { test } from "node:test"
import assert from "node:assert/strict"
import { isControlPath, decideWriteEdit, decideBash, decideTask, decideCodex, decideStop } from "./guards.mjs"

test("isControlPath: 권위(authority) 파일만 control — receipt·round·delta는 구분", () => {
  // 권위 JSON → control(직접 쓰기 금지)
  assert.equal(isControlPath(".harnie/plan/x/manifest.json"), true)
  assert.equal(isControlPath(".harnie/plan/x/execution.json"), true)
  assert.equal(isControlPath(".harnie/active.json"), true)
  assert.equal(isControlPath(".harnie/plan/x/review/task-a/ledger.json"), true)
  assert.equal(isControlPath(".harnie/plan/x/review/task-a/state.json"), true)
  assert.equal(isControlPath(".harnie/plan/x/review/task-a/receipt.json"), true)
  assert.equal(isControlPath(".harnie/plan/x/.seal.json"), true)
  assert.equal(isControlPath(".harnie/plan/x/.arm-approval.json"), true)
  // 비-control: 오케스트레이터/loop의 정당한 산출물 — round-N.txt·delta.patch·design.md·plan.md·notepad
  assert.equal(isControlPath(".harnie/plan/x/review/task-a/round-1.txt"), false)
  assert.equal(isControlPath(".harnie/plan/x/review/task-a/delta.patch"), false)
  assert.equal(isControlPath(".harnie/quick/x/review/design/design.md"), false)
  assert.equal(isControlPath(".harnie/plan/x/plan.md"), false)
  assert.equal(isControlPath(".harnie/plan/x/notepad.md"), false)
  assert.equal(isControlPath("src/foo.ts"), false)
})

test("decideWriteEdit: control 직접 쓰기 phase 무관 deny", () => {
  assert.equal(decideWriteEdit({ relPath: ".harnie/plan/x/manifest.json", phase: "executing", track: "plan", slug: "x" }).deny, true)
  assert.equal(decideWriteEdit({ relPath: ".harnie/plan/x/review/u/ledger.json", phase: "executing", track: "plan", slug: "x" }).deny, true)
})

test("decideWriteEdit: 승인 前 소스 쓰기 deny, plan.md는 허용", () => {
  assert.equal(decideWriteEdit({ relPath: "src/foo.ts", phase: "planning", track: "plan", slug: "x" }).deny, true)
  assert.equal(decideWriteEdit({ relPath: "src/foo.ts", phase: "awaiting-approval", track: "plan", slug: "x" }).deny, true)
  assert.equal(decideWriteEdit({ relPath: ".harnie/plan/x/plan.md", phase: "planning", track: "plan", slug: "x" }).deny, false)
})

test("decideWriteEdit: executing 소스 쓰기 허용", () => {
  assert.equal(decideWriteEdit({ relPath: "src/foo.ts", phase: "executing", track: "plan", slug: "x" }).deny, false)
})

const T = new Set(["/p/scripts/loop.mjs", "/p/scripts/execution.mjs"])
test("decideBash: 신뢰 경로 sanctioned CLI만 허용, 임의 경로·셸연산자 위장 deny", () => {
  assert.equal(decideBash({ command: "node /p/scripts/loop.mjs delta /repo abc --out .harnie/plan/x/review/u/delta.patch", trustedClis: T }).deny, false)
  assert.equal(decideBash({ command: "node /p/scripts/execution.mjs seal --root /repo --slug x", trustedClis: T }).deny, false)
  // 신뢰 경로 아닌 위치 → sanctioned 아님(planning 기본 deny)
  assert.equal(decideBash({ command: "node /tmp/scripts/loop.mjs capture /repo", phase: "planning", trustedClis: T }).deny, true)
  // 셸 연산자 섞인 sanctioned 위장 → deny
  assert.equal(decideBash({ command: "node /p/scripts/loop.mjs delta /repo abc; rm -rf .harnie", trustedClis: T }).deny, true)
  // 직접 .harnie 변형
  assert.equal(decideBash({ command: "rm -rf .harnie/plan/x/review" }).deny, true)
  assert.equal(decideBash({ command: "echo '{}' > .harnie/plan/x/manifest.json" }).deny, true)
  assert.equal(decideBash({ command: "sed -i s/x/y/ .harnie/active.json" }).deny, true)
  // 무관한 read-only 명령 허용(post-approval)
  assert.equal(decideBash({ command: "git status" }).deny, false)
  assert.equal(decideBash({ command: "cat src/foo.ts" }).deny, false)
})

test("decideBash: 개행·프로세스치환으로 명령 밀반입 deny", () => {
  assert.equal(decideBash({ command: "git status\nrm src/app.js", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "cat <(rm src/app.js)", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "grep x src > src/out", phase: "planning" }).deny, true) // 리다이렉트
})

test("decideBash: 비-sanctioned Bash의 .harnie 접근은 phase 무관 deny(승인 후 포함)", () => {
  assert.equal(decideBash({ command: "find .harnie -delete" }).deny, true)
  assert.equal(decideBash({ command: "git clean -fd .harnie" }).deny, true)
  assert.equal(decideBash({ command: "node -e \"require('fs').rmSync('.harnie/plan/x/manifest.json')\"" }).deny, true)
  assert.equal(decideBash({ command: "cat .harnie/plan/x/manifest.json" }).deny, true)
})

test("decideBash: sanctioned CLI는 active root·slug·positional repo에 바인딩", () => {
  const AR = "/repo", TT = new Set(["/repo/scripts/loop.mjs", "/repo/scripts/execution.mjs"])
  const ctx = { phase: "planning", trustedClis: TT, activeRoot: AR, activeSlug: "feat-x", activeTrack: "plan" }
  // 올바른 바인딩 → 허용
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs seal --root /repo --slug feat-x", ...ctx }).deny, false)
  assert.equal(decideBash({ command: "node /repo/scripts/loop.mjs delta /repo abc --out .harnie/plan/feat-x/review/u/d.patch", ...ctx }).deny, false)
  // stale slug verify → 승인 前 과거 manifest executable 실행 시도 → deny
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs verify --root /repo --slug old --task T1", ...ctx }).deny, true)
  // --root가 다른 repo → deny
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs set-phase --root /other --slug feat-x --phase closed", ...ctx }).deny, true)
  // loop positional repo가 다른 repo → deny
  assert.equal(decideBash({ command: "node /repo/scripts/loop.mjs capture /other", ...ctx }).deny, true)
  // 출력이 active .harnie 밖 → deny
  assert.equal(decideBash({ command: "node /repo/scripts/loop.mjs apply --root /repo --ledger /other/.harnie/l.json --state /other/.harnie/s.json --ns CR --review r --artifact a", ...ctx }).deny, true)
})

test("decideBash: 승인 前 read-only allowlist — 쓰기 옵션 있는 명령 deny", () => {
  assert.equal(decideBash({ command: "find src -delete", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "sort -o src/out.txt input.txt", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "yq -i .x=1 config.yml", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "git diff --output=src/diff.txt", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "grep -o pattern src/f", phase: "planning" }).deny, false) // grep -o는 stdout(read-only)
})

test("decideBash: 승인 前 파일쓰기·임의실행 deny(핵심 우회 차단)", () => {
  // planning: 리다이렉트로 소스 쓰기
  assert.equal(decideBash({ command: "printf 'x' > src/app.js", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "python -c \"open('src/a.py','w').write('x')\"", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "mkdir -p src/new", phase: "awaiting-approval" }).deny, true)
  // planning read-only는 허용
  assert.equal(decideBash({ command: "git status", phase: "planning" }).deny, false)
  assert.equal(decideBash({ command: "cat src/app.js", phase: "planning" }).deny, false)
  // executing에선 소스 쓰기 Bash 허용(.harnie만 계속 차단)
  assert.equal(decideBash({ command: "printf 'x' > src/app.js", phase: "executing" }).deny, false)
})

test("decideBash: 승인 前 allowlist — git apply·npm·writer 스크립트 deny, read-only 파이프 allow", () => {
  assert.equal(decideBash({ command: "git apply patch.diff", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "git checkout -- src/x", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "npm run build", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "node writer.mjs", phase: "planning" }).deny, true) // 임의 스크립트 실행
  // read-only 명령·파이프는 허용
  assert.equal(decideBash({ command: "git log --oneline | head -20", phase: "planning" }).deny, false)
  assert.equal(decideBash({ command: "grep -r foo src | wc -l", phase: "planning" }).deny, false)
  assert.equal(decideBash({ command: "git diff HEAD", phase: "planning" }).deny, false)
})

test("decideTask: designer는 read-only라 planning 허용, builder deny", () => {
  assert.equal(decideTask({ subagentType: "harnie-designer", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-builder", phase: "planning" }).deny, true)
  assert.equal(decideTask({ subagentType: "harnie-scout", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-reviewer", phase: "awaiting-approval" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-builder", phase: "executing" }).deny, false)
})

test("decideCodex: executing 빌더는 정확히 workspace-write + cwd=root만", () => {
  // danger-full-access 차단
  assert.equal(decideCodex({ isReply: false, sandbox: "danger-full-access", phase: "executing", hasBuildingUnbound: true }).deny, true)
  // sandbox 미지정 차단
  assert.equal(decideCodex({ isReply: false, sandbox: undefined, phase: "executing", hasBuildingUnbound: true }).deny, true)
  // cwd가 root 아니면 차단
  assert.equal(decideCodex({ isReply: false, sandbox: "workspace-write", cwd: "/other", root: "/repo", phase: "executing", hasBuildingUnbound: true }).deny, true)
  // 정확히 workspace-write + cwd=root + building-unbound → 허용
  assert.equal(decideCodex({ isReply: false, sandbox: "workspace-write", cwd: "/repo", root: "/repo", phase: "executing", hasBuildingUnbound: true }).deny, false)
})

test("decideCodex: planning은 read-only만", () => {
  assert.equal(decideCodex({ isReply: false, sandbox: "read-only", phase: "planning" }).deny, false)
  assert.equal(decideCodex({ isReply: false, sandbox: "workspace-write", phase: "planning" }).deny, true)
  assert.equal(decideCodex({ isReply: true, threadId: "t1", phase: "planning", readOnlyThreads: ["t1"] }).deny, false)
  assert.equal(decideCodex({ isReply: true, threadId: "t2", phase: "planning", readOnlyThreads: ["t1"] }).deny, true)
})

test("decideCodex: executing 빌더 부트스트랩은 building-unbound task가 있을 때만", () => {
  const wb = { isReply: false, sandbox: "workspace-write", cwd: "/repo", root: "/repo", phase: "executing" }
  // building-unbound 없으면 workspace-write 차단
  assert.equal(decideCodex({ ...wb, hasBuildingUnbound: false }).deny, true)
  // 있으면 허용(cwd=root)
  assert.equal(decideCodex({ ...wb, hasBuildingUnbound: true }).deny, false)
  // read-only 리뷰는 항상 허용
  assert.equal(decideCodex({ isReply: false, sandbox: "read-only", phase: "executing" }).deny, false)
  // reply는 등록 스레드만
  assert.equal(decideCodex({ isReply: true, threadId: "b1", phase: "executing", builderThreads: ["b1"] }).deny, false)
  assert.equal(decideCodex({ isReply: true, threadId: "ro", phase: "executing", readOnlyThreads: ["ro"] }).deny, false)
  assert.equal(decideCodex({ isReply: true, threadId: "x", phase: "executing", builderThreads: ["b1"] }).deny, true)
})

test("decideStop: 완료면 통과, 미완료 첫 호출 block", () => {
  assert.equal(decideStop({ complete: true }).block, false)
  const b = decideStop({ complete: false, blockers: ["task T1: open blocking 1"], stopHookActive: false })
  assert.equal(b.block, true)
  assert.ok(/T1/.test(b.reason))
})

test("decideStop: 재호출 — COMPLETE 주장/footer 부재는 계속 block, INCOMPLETE 정직보고는 통과", () => {
  // 권위 미완료인데 footer COMPLETE → 계속 block
  assert.equal(decideStop({ complete: false, blockers: ["x"], stopHookActive: true, footer: { present: true, status: "COMPLETE" } }).block, true)
  // footer 부재 → 계속 block
  assert.equal(decideStop({ complete: false, blockers: ["x"], stopHookActive: true, footer: { present: false } }).block, true)
  // 정직한 INCOMPLETE 보고 → 통과
  assert.equal(decideStop({ complete: false, blockers: ["x"], stopHookActive: true, footer: { present: true, status: "INCOMPLETE" } }).block, false)
})
