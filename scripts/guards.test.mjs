import { test } from "node:test"
import assert from "node:assert/strict"
import { isControlPath, decideWriteEdit, decideBash, decideTask, decideCodex, decideStop, referencesHarnie } from "./guards.mjs"

test("isControlPath: 권위 파일·route·lock 보호, 일반 산출물 허용", () => {
  for (const p of [
    ".harnie/active.json", ".harnie/plan/x/manifest.json", ".harnie/plan/x/execution.json",
    ".harnie/plan/x/review/u/ledger.json", ".harnie/plan/x/review/u/state.json",
    ".harnie/plan/x/review/u/receipt.json", ".harnie/pending-route/s.json", ".harnie/state.lock",
  ]) assert.equal(isControlPath(p), true, p)
  for (const p of [".harnie/plan/x/plan.md", ".harnie/plan/x/review/u/round-1.txt", ".harnie/plan/x/review/u/delta.patch", "src/x.ts"])
    assert.equal(isControlPath(p), false, p)
})

test("decideWriteEdit: control 직접 쓰기는 phase 무관 deny", () => {
  assert.equal(decideWriteEdit({ relPath: ".harnie/plan/x/manifest.json", phase: "executing", track: "plan", slug: "x" }).deny, true)
  assert.equal(decideWriteEdit({ relPath: ".harnie/plan/x/review/u/ledger.json", phase: "planning", track: "plan", slug: "x" }).deny, true)
})

test("decideWriteEdit: 승인 전 활성 run 밖 소스 쓰기 deny, run 산출물 허용", () => {
  for (const phase of ["planning", "awaiting-approval"])
    assert.equal(decideWriteEdit({ relPath: "src/x.ts", phase, track: "plan", slug: "x" }).deny, true)
  assert.equal(decideWriteEdit({ relPath: ".harnie/plan/x/plan.md", phase: "planning", track: "plan", slug: "x" }).deny, false)
  assert.equal(decideWriteEdit({ relPath: "src/x.ts", phase: "executing", track: "plan", slug: "x" }).deny, false)
})

test("decideWriteEdit: repo 밖 절대경로는 phase gate 제외, control은 유지", () => {
  assert.equal(decideWriteEdit({ relPath: "../notes.md", outside: true, phase: "planning", track: "plan", slug: "x" }).deny, false)
  assert.equal(decideWriteEdit({ relPath: ".harnie/active.json", outside: true, phase: "planning", track: "plan", slug: "x" }).deny, true)
})

const T = new Set(["/plugin/scripts/loop.mjs", "/plugin/scripts/execution.mjs"])
const ctx = { trustedClis: T, activeRoot: "/repo", activeSlug: "x", activeTrack: "plan" }

test("decideBash: non-sanctioned .harnie 접근은 읽기 포함 전면 deny", () => {
  for (const command of ["cat .harnie/active.json", "rm -rf .harnie", "echo x > .harnie/x"])
    assert.equal(decideBash({ command, phase: "planning", ...ctx }).deny, true, command)
  assert.equal(referencesHarnie("cat .harnie/active.json"), true)
  assert.equal(referencesHarnie("cat .HARNIE/active.json"), false)
})

test("decideBash: .harnie 밖 Bash는 승인 전후 모두 allow", () => {
  for (const command of ["git status", "printf x > src/x.ts", "node writer.mjs", "git apply p.patch"])
    for (const phase of ["planning", "awaiting-approval", "executing"])
      assert.equal(decideBash({ command, phase, ...ctx }).deny, false, `${phase}: ${command}`)
})

test("decideBash: sanctioned CLI는 bare node + 신뢰 절대 script + 활성 repo만", () => {
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal --root /repo --slug stale", ...ctx }).deny, false)
  assert.equal(decideBash({ command: "node /plugin/scripts/loop.mjs capture /repo", ...ctx }).deny, false)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal --root /other --slug x", ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: "/opt/node /plugin/scripts/execution.mjs seal --root /repo --slug x", ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: "node /tmp/execution.mjs seal --root /repo --slug x", ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs completion --root /other --root /repo", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs completion --root /repo --root /other", ...ctx }).autoAllow, false)
})

test("decideBash: sanctioned auto-allow는 4종만", () => {
  assert.equal(decideBash({ command: "node /plugin/scripts/loop.mjs capture /repo", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/loop.mjs delta /repo a --out .harnie/x", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs completion --root /repo --slug stale", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal-verify --root /repo --slug stale", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs verify --root /repo --slug stale", ...ctx }).autoAllow, false)
})

test("decideBash: sanctioned CLI 뒤 셸 메타 명령 연결은 .harnie 접근 deny", () => {
  const prefix = "node /plugin/scripts/execution.mjs completion --root /repo --slug stale"
  for (const suffix of ["&& rm -rf .harnie", "| tee .harnie/out", "\nrm -rf .harnie"])
    assert.equal(decideBash({ command: `${prefix} ${suffix}`, ...ctx }).deny, true, suffix)
  assert.equal(decideBash({ command: `${prefix} && curl x`, ...ctx }).autoAllow, false)
})

test("decideTask: 승인 전 read-only agent만 허용", () => {
  assert.equal(decideTask({ subagentType: "harnie-designer", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie:harnie-scout", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-builder", phase: "planning" }).deny, true)
})

test("decideCodex: 승인 전 read-only만", () => {
  assert.equal(decideCodex({ isReply: false, sandbox: "read-only", phase: "planning" }).deny, false)
  assert.equal(decideCodex({ isReply: false, sandbox: "workspace-write", phase: "planning" }).deny, true)
  assert.equal(decideCodex({ isReply: true, threadId: "r", readOnlyThreads: ["r"], phase: "planning" }).deny, false)
})

test("decideCodex: 승인 후 builder는 workspace-write + cwd=root + building task", () => {
  const base = { isReply: false, sandbox: "workspace-write", root: "/repo", cwd: "/repo", phase: "executing", hasBuildingUnbound: true }
  assert.equal(decideCodex(base).deny, false)
  assert.equal(decideCodex({ ...base, sandbox: "danger-full-access" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/other" }).deny, true)
  assert.equal(decideCodex({ ...base, hasBuildingUnbound: false }).deny, true)
})

test("decideStop: 완료 통과, 미완료 block, 정직 INCOMPLETE 재호출 통과", () => {
  assert.equal(decideStop({ complete: true }).block, false)
  assert.equal(decideStop({ complete: false, blockers: ["T1"] }).block, true)
  assert.equal(decideStop({ complete: false, stopHookActive: true, footer: { present: true, status: "INCOMPLETE" } }).block, false)
  assert.equal(decideStop({ complete: false, stopHookActive: true, footer: { present: true, status: "COMPLETE" } }).block, true)
})
