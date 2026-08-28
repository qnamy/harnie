import { test } from "node:test"
import assert from "node:assert/strict"
import { isControlPath, decideWriteEdit, decideBash, decideTask, decideCodex, decideStop, decideWatchdog, referencesHarnie } from "./guards.mjs"

test("isControlPath: 권위 파일·세션·lock 보호, 일반 산출물 허용", () => {
  for (const p of [
    ".harnie/active.json", ".harnie/plan/x/manifest.json", ".harnie/plan/x/execution.json",
    ".harnie/plan/x/review/u/ledger.json", ".harnie/plan/x/review/u/state.json",
    ".harnie/plan/x/review/u/receipt.json", ".harnie/state.lock",
  ]) assert.equal(isControlPath(p), true, p)
  for (const p of [".harnie/pending-route/s.json", ".harnie/plan/x/plan.md", ".harnie/plan/x/review/u/round-1.txt", ".harnie/plan/x/review/u/delta.patch", "src/x.ts"])
    assert.equal(isControlPath(p), false, p)
})

// 0.14: `.harnie-wt` 컨테이너가 사라져 판정은 `.harnie` 하나다. `(?![\w-])` 경계는 남는다 —
// `.harnie`로 시작하는 다른 이름까지 blanket deny로 끌어들이지 않기 위해서다.
test("referencesHarnie: 상태 디렉터리만 매치하고 이름이 이어지는 형태는 매치 안 됨", () => {
  assert.equal(referencesHarnie("rm -rf .harnie"), true)
  assert.equal(referencesHarnie("cat .harnie/active.json"), true)
  assert.equal(referencesHarnie("cat .harnie/abandoned/x/execution.json"), true)
  assert.equal(referencesHarnie("cat ./.harnie/active.json"), true)
  assert.equal(referencesHarnie("cat .HARNIE/active.json"), false)
  assert.equal(referencesHarnie("cat .harnie-notes/x.md"), false)
  assert.equal(referencesHarnie("git status"), false)
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

// DEC-1의 성립 조건: 출구가 실제로 열려 있어야 한다. `isSanctionedCli`의 execution.mjs 분기는 `--root`만
// 보므로 활성 slug 대상이든 이미 비활성인 slug 대상이든 둘 다 통과해야 한다 — 후자가 막히면 소급 미완료된
// 과거 run을 폐기할 방법이 없다.
test("decideBash: abandon은 활성 slug·비활성 slug 대상 모두 통과(잠긴 트리의 출구)", () => {
  const cmd = (slug) => `node /plugin/scripts/execution.mjs abandon --root /repo --slug ${slug} --confirm ${slug}`
  assert.equal(decideBash({ command: cmd("x"), ...ctx }).deny, false)        // 활성 slug
  assert.equal(decideBash({ command: cmd("stale-run"), ...ctx }).deny, false) // 비활성 slug
  assert.equal(decideBash({ command: cmd("x"), ...ctx }).autoAllow, false)   // 자동 허용은 아님 — 사용자 프롬프트를 거친다
})

// 0.14: run root 하나뿐 — loop CLI도 run root 인자만 받는다(태스크별 worktree 소멸).
test("decideBash: loop CLI는 run root 인자만 sanctioned", () => {
  assert.equal(decideBash({ command: "node /plugin/scripts/loop.mjs capture /repo", ...ctx }).deny, false)
  const wt = "/repo/sub"
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs capture ${wt}`, ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs delta ${wt} a --out ${wt}/.harnie/review/code/delta.patch`, ...ctx }).deny, true)
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs apply --root ${wt} --ledger ${wt}/.harnie/review/code/ledger.json --review ${wt}/.harnie/review/code/round-1.txt --ns CR --state ${wt}/.harnie/review/code/state.json --artifact a`, ...ctx }).deny, true)
})

test("decideBash: sanctioned auto-allow 집합", () => {
  assert.equal(decideBash({ command: "node /plugin/scripts/loop.mjs capture /repo", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/loop.mjs delta /repo a --out .harnie/x", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs completion --root /repo --slug stale", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal-verify --root /repo --slug stale", ...ctx }).autoAllow, true)
  // seal은 멱등·조건부(미검증 seal 위 오염 재-seal 거부)가 된 뒤 auto-allow 대상 — DR-005 해소
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal --root /repo --slug stale", ...ctx }).autoAllow, true)
  // 단, 오염 흡수 차단을 해제하는 --after-mismatch 는 사용자 프롬프트로 되돌린다
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal --root /repo --slug stale --after-mismatch", ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: "node /plugin/scripts/execution.mjs seal --root /repo --slug stale --after-mismatch", ...ctx }).deny, false)
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

test("decideCodex: 승인 후 builder는 workspace-write + 활성 cwd + building task", () => {
  const base = { isReply: false, sandbox: "workspace-write", root: "/repo", slug: "x", cwd: "/repo", phase: "executing", buildingUnboundTasks: ["1"], pendingRunRootBootstrap: "1", taskRepoWorkroots: { "1": "/repo" } }
  assert.equal(decideCodex(base).deny, false)
  // 빌더 cwd는 run root 정확히 하나다 — 하위 디렉터리도 PostToolUse가 귀속할 수 없으므로 막는다
  assert.equal(decideCodex({ ...base, cwd: "/repo/src" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/repo/" }).deny, true)
  assert.equal(decideCodex({ ...base, sandbox: "danger-full-access" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/other" }).deny, true)
  assert.equal(decideCodex({ ...base, buildingUnboundTasks: [] }).deny, true)
  // marker 없는 run-root 호출은 별도 테스트(단일 building-unbound serial 예외)가 다룬다
  assert.equal(decideCodex({ ...base, pendingRunRootBootstrap: null, buildingUnboundTasks: ["1", "2"], taskRepoWorkroots: { "1": "/repo", "2": "/repo" } }).deny, true)
})

test("decideCodex: marker 없는 root cwd는 단일 building-unbound일 때만 허용", () => {
  const base = { isReply: false, sandbox: "workspace-write", root: "/repo", slug: "x", cwd: "/repo", phase: "executing", buildingUnboundTasks: ["1"], taskRepoWorkroots: { "1": "/repo" } }
  assert.equal(decideCodex(base).deny, false)
  assert.equal(decideCodex({ ...base, buildingUnboundTasks: ["1", "2"], taskRepoWorkroots: { "1": "/repo", "2": "/repo" } }).deny, true)
  assert.equal(decideCodex({ ...base, taskRepoWorkroots: { "1": "/other" } }).deny, true)
})

test("decideStop: 완료 통과, 미완료 block, 정직 INCOMPLETE 재호출 통과", () => {
  assert.equal(decideStop({ complete: true }).block, false)
  assert.equal(decideStop({ complete: false, blockers: ["T1"] }).block, true)
  assert.equal(decideStop({ complete: false, stopHookActive: true, footer: { present: true, status: "INCOMPLETE" } }).block, false)
  assert.equal(decideStop({ complete: false, stopHookActive: true, footer: { present: true, status: "COMPLETE" } }).block, true)
})

test("decideWatchdog: 예산 내·80% 경고·100% 차단", () => {
  const startedAt = "2026-08-18T00:00:00.000Z"
  const now = Date.parse(startedAt) + 10 * 60_000
  assert.deepEqual(decideWatchdog({ startedAt, codexCalls: 5, now }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 5, now }).warn, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 12, now }).warn, true)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 15, now }).deny, true)
})

test("decideWatchdog: 시간 예산·누락 시간·비정수 호출은 advisory로 판정", () => {
  const startedAt = "2026-08-18T00:00:00.000Z"
  const base = Date.parse(startedAt)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 30 * 60_000 + 1 }).deny, true) // wall은 `>` 경계(0.11)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 25 * 60_000 }).warn, true)
  const missing = decideWatchdog({ codexCalls: 12, now: base })
  assert.equal(missing.elapsedMs, null)
  assert.equal(missing.warn, true)
  const invalidCalls = decideWatchdog({ codexCalls: 4.5, now: base })
  assert.equal(invalidCalls.calls, 0)
  assert.equal(invalidCalls.deny, false)
})

test("decideWatchdog: difficulty 티어 — hard는 60분/25콜, 미지·미지정은 기본 티어", () => {
  const startedAt = "2026-08-18T00:00:00.000Z"
  const base = Date.parse(startedAt)
  // 기본(30분/15콜)이면 deny인 지점이 hard에선 예산 내
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 45 * 60_000 }).deny, true)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 45 * 60_000, difficulty: "hard" }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 20, now: base, difficulty: "hard" }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 25, now: base, difficulty: "hard" }).deny, true)
  // easy/medium/미지 값은 기본 티어
  assert.equal(decideWatchdog({ startedAt, codexCalls: 15, now: base, difficulty: "medium" }).deny, true)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 15, now: base, difficulty: "nonsense" }).deny, true)
  // 결과에 유효 예산이 실린다(훅 메시지용)
  const r = decideWatchdog({ startedAt, codexCalls: 0, now: base, difficulty: "hard" })
  assert.equal(r.wallClockBudgetMs, 60 * 60_000)
  assert.equal(r.maxCodexCalls, 25)
})

test("decideWatchdog: very-hard는 hard와 동일 예산 재사용(신규 수치 없음, 의도된 기본값)", () => {
  const startedAt = "2026-08-18T00:00:00.000Z"
  const base = Date.parse(startedAt)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 45 * 60_000, difficulty: "very-hard" }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 20, now: base, difficulty: "very-hard" }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 25, now: base, difficulty: "very-hard" }).deny, true)
  const r = decideWatchdog({ startedAt, codexCalls: 0, now: base, difficulty: "very-hard" })
  assert.equal(r.wallClockBudgetMs, 60 * 60_000)
  assert.equal(r.maxCodexCalls, 25)
})

test("decideWatchdog(0.11): 연장 산식 effective=base×(1+ext), pre-call >= 경계, builderBoundAt 기산·startedAt 폴백", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z")
  const startedAt = new Date(base).toISOString()
  // 연장 1회 = 호출 상한 30: 29는 통과, 30은 deny(>= 경계 — base 15의 15번째 사용 후 16번째 호출 거부와 동일 계약)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 15, now: base }).deny, true)                     // ext 0: 15 >= 15
  assert.equal(decideWatchdog({ startedAt, codexCalls: 15, now: base, extensions: 1 }).deny, false)     // ext 1: 15 < 30
  assert.equal(decideWatchdog({ startedAt, codexCalls: 29, now: base, extensions: 1 }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 30, now: base, extensions: 1 }).deny, true)
  // wall도 확대: ext 1 = 60분 — 경계 계약은 wall `>`(정확한 경계 시각 허용, +1ms부터 deny) / call `>=`
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 45 * 60_000, extensions: 1 }).deny, false)
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 60 * 60_000, extensions: 1 }).deny, false)      // 정확 경계 = 허용
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 60 * 60_000 + 1, extensions: 1 }).deny, true)   // 경계 +1ms = deny
  // 기산점 = builderBoundAt(설계·그라운딩 단계는 예산 밖): startedAt이 오래돼도 boundAt 기준으로 판정
  const boundAt = new Date(base + 40 * 60_000).toISOString()
  assert.equal(decideWatchdog({ startedAt, builderBoundAt: boundAt, codexCalls: 0, now: base + 50 * 60_000 }).deny, false)     // bound 후 10분
  assert.equal(decideWatchdog({ startedAt, builderBoundAt: boundAt, codexCalls: 0, now: base + 70 * 60_000 + 1 }).deny, true)  // bound 후 30분+1ms
  // 구 상태(builderBoundAt 부재)는 startedAt 폴백 — 하위 호환
  assert.equal(decideWatchdog({ startedAt, codexCalls: 0, now: base + 30 * 60_000 + 1 }).deny, true)
})

// 실측 회귀(관측 ④): 신뢰 CLI를 쓰고 있는데 deny 이유가 "loop.mjs로만 하라"인 자기모순 메시지 →
// 승인 실패 원인(인자 불일치·메타문자·형태 오류)을 이유에 실어 .sh 우회 대신 인자를 고치게 한다.
test("decideBash: 신뢰 CLI 형태의 승인 실패는 원인 진단이 deny 이유에 실림", () => {
  const mismatch = decideBash({ command: "node /plugin/scripts/loop.mjs delta /other abc --out /other/.harnie/review/u/delta.patch", ...ctx })
  assert.equal(mismatch.deny, true)
  assert.match(mismatch.reason, /승인 실패/)
  assert.match(mismatch.reason, /불일치/)
  const meta = decideBash({ command: "node /plugin/scripts/loop.mjs capture /repo && cat .harnie/active.json", ...ctx })
  assert.equal(meta.deny, true)
  assert.match(meta.reason, /메타문자/)
  const generic = decideBash({ command: "cat .harnie/active.json", ...ctx })
  assert.equal(generic.deny, true)
  assert.doesNotMatch(generic.reason, /승인 실패/)
})

// U1 카드 9: D4 이후 이 deny를 받는 세션은 대개 run과 무관한 방관자다. 그 세션에 닿는 문구가 R2 완화의
// 유일한 접점이므로, 어느 run이 잠갔는지(slug)와 두 출구가 반드시 들어 있어야 한다.
test("decideWriteEdit: 승인 前 deny 문구에 활성 slug와 두 출구(재개·abandon)가 들어간다", () => {
  const d = decideWriteEdit({ relPath: "src/x.ts", phase: "planning", track: "plan", slug: "feat-x", root: "/repo", execCli: "/plugin/scripts/execution.mjs" })
  assert.equal(d.deny, true)
  assert.match(d.reason, /feat-x/)
  assert.match(d.reason, /\/harnie:dev/)
  assert.match(d.reason, /abandon --root \/repo --slug feat-x --confirm feat-x/)
})
