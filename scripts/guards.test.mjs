import { test } from "node:test"
import assert from "node:assert/strict"
import { isControlPath, decideWriteEdit, decideBash, decideTask, decideCodex, decideStop, decideWatchdog, referencesHarnie, decideActiveRunDeletion, isActiveTaskWorktree, taskIdFromActiveTaskWorktree } from "./guards.mjs"

test("isControlPath: 권위 파일·세션·lock 보호, 일반 산출물 허용", () => {
  for (const p of [
    ".harnie/active.json", ".harnie/plan/x/manifest.json", ".harnie/plan/x/execution.json",
    ".harnie/plan/x/review/u/ledger.json", ".harnie/plan/x/review/u/state.json",
    ".harnie/plan/x/review/u/receipt.json", ".harnie/state.lock",
  ]) assert.equal(isControlPath(p), true, p)
  for (const p of [".harnie/pending-route/s.json", ".harnie/plan/x/plan.md", ".harnie/plan/x/review/u/round-1.txt", ".harnie/plan/x/review/u/delta.patch", "src/x.ts"])
    assert.equal(isControlPath(p), false, p)
})

test("isControlPath: 세션 바인딩 디렉터리도 control(T2)", () => {
  assert.equal(isControlPath(".harnie/sessions/abc-123.json"), true)
})

// CR-001/CR-004 회귀: worktree-per-run(T2)의 컨테이너 `.harnie-wt`가 `.harnie` 매칭에 걸려 그 안의 평범한 파일까지
// Bash로 접근 불가능해지던 버그(라운드1), 그리고 trailing slash·glob 형태가 그 컨테이너 보호를 빠져나가던 버그(라운드2).
test("referencesHarnie: .harnie-wt 컨테이너 안의 평범한 파일은 매치 안 됨, 컨테이너 자체(슬래시·glob 포함)·nested .harnie는 매치", () => {
  assert.equal(referencesHarnie("git -C .harnie-wt/harnie-foo status"), false)
  assert.equal(referencesHarnie("node --test .harnie-wt/harnie-foo/x.test.mjs"), false)
  assert.equal(referencesHarnie("npm --prefix .harnie-wt/harnie-foo test"), false)
  assert.equal(referencesHarnie("cat .harnie-wt/harnie-foo/README.md"), false)
  assert.equal(referencesHarnie("rm -rf .harnie-wt"), true)                          // 컨테이너 자체(모든 run 삭제)
  assert.equal(referencesHarnie("ls .harnie-wt/harnie-foo/.harnie/active.json"), true) // nested 권위 상태
  assert.equal(referencesHarnie("rm -rf .harnie"), true)                             // 기존 단일 .harnie 보호 유지
  assert.equal(referencesHarnie("cat .harnie/sessions/x.json"), true)
  // trailing slash·glob도 "컨테이너 전체"를 뜻하므로 매치돼야 한다(셸 탭완성·정리 명령의 흔한 형태).
  assert.equal(referencesHarnie("rm -rf .harnie-wt/"), true)
  assert.equal(referencesHarnie("rm -rf .harnie-wt/*"), true)
  assert.equal(referencesHarnie("rm -rf .harnie-wt/harnie-*"), true)
  assert.equal(referencesHarnie("rm -rf .harnie-wt/harnie-foo"), false) // 한 worktree만 정확히 지목
  assert.equal(referencesHarnie("rm -rf .harnie-wt/harnie-foo/*"), true) // 특정 worktree라도 glob subtree는 차단
  assert.equal(referencesHarnie("rm -rf ./.harnie-wt/"), true)
  assert.equal(referencesHarnie("find .harnie-wt/ -name active.json -delete"), true)
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

const T = new Set(["/plugin/scripts/loop.mjs", "/plugin/scripts/execution.mjs", "/plugin/scripts/worktree.mjs"])
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

test("decideBash: worktree CLI는 --repo가 활성 repo일 때만 sanctioned, auto-allow는 아님", () => {
  const good = "node /plugin/scripts/worktree.mjs create --repo /repo --branch x"
  assert.deepEqual(decideBash({ command: good, ...ctx }), { deny: false, autoAllow: false })
  assert.equal(decideBash({ command: good.replace("--repo /repo", "--repo /other"), ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: `${good} && rm -rf /`, ...ctx }).autoAllow, false)

  // `.harnie` 토큰을 넣으면 sanctioned 여부가 관찰 가능하다: 올바른 repo 바인딩만 Bash guard를 통과한다.
  const probe = "node /plugin/scripts/worktree.mjs create --repo /repo --branch .harnie/probe"
  assert.equal(decideBash({ command: probe, ...ctx }).deny, false)
  assert.equal(decideBash({ command: probe.replace("--repo /repo", "--repo /other"), ...ctx }).deny, true)
  assert.equal(decideBash({ command: probe.replace("--repo /repo", "--repo /repo/.harnie-wt/harnie-x-t1"), ...ctx }).deny, true)
  assert.equal(decideBash({ command: `${probe} && rm -rf /`, ...ctx }).deny, true)
})

// 0.13 T8(2026-08-26 사고 대응): referencesHarnie는 "정확히 한 worktree를 지목"하면 일부러 허용한다
// (guards.test.mjs 위 "referencesHarnie" 테스트 참조) — 그 안에서 build/test/git을 자유롭게 쓰게 하려는 의도인데,
// `git worktree remove`/`rm -rf`가 그 허용 분기에 함께 떨어져 사고의 직접 원인이었다. decideActiveRunDeletion은
// activeRuns(새 상태 파일 없이 각 run의 `.harnie/active.json`에서 파생)로 그 삭제 시도만 별도로 잡는다.
test("decideActiveRunDeletion: 활성 run의 워크트리 삭제(git worktree remove·rm -rf)만 deny, 하위 경로·무관 run은 allow", () => {
  const runs = [{ worktreePath: "/repo/.harnie-wt/harnie-foo", slug: "foo", branch: "harnie/foo" }]
  for (const cmd of [
    "git worktree remove /repo/.harnie-wt/harnie-foo",
    "git -C /repo worktree remove .harnie-wt/harnie-foo",
    "rm -rf .harnie-wt/harnie-foo",
    "rm -rf .harnie-wt/harnie-foo/",
    "rm -fr /repo/.harnie-wt/harnie-foo",
    "rm -r -f .harnie-wt/harnie-foo",
  ]) assert.equal(decideActiveRunDeletion(cmd, runs).deny, true, cmd)
  for (const cmd of [
    "git -C .harnie-wt/harnie-foo status",                  // 삭제 의도 아님 — referencesHarnie가 이미 허용
    "rm -rf .harnie-wt/harnie-foo/tmp",                      // worktree "안"의 하위 경로 삭제는 정상 작업
    "rm -r .harnie-wt/harnie-foo",                           // force 없음 — rm -rf만 대상
    "rm -rf .harnie-wt/harnie-foo2",                         // 접두만 겹치는 다른 이름
    "git worktree remove .harnie-wt/harnie-bar",             // 등록되지 않은(비활성) run — 명시 열거 정리 대상
    "rm -rf /tmp/unrelated",
  ]) assert.equal(decideActiveRunDeletion(cmd, runs).deny, false, cmd)
})

test("decideActiveRunDeletion: 활성 run 브랜치 삭제(git branch -d/-D·git push --delete)만 deny", () => {
  const runs = [{ worktreePath: "/repo/.harnie-wt/harnie-foo", slug: "foo", branch: "harnie/foo" }]
  for (const cmd of ["git branch -D harnie/foo", "git branch -d harnie/foo", "git push origin --delete harnie/foo"])
    assert.equal(decideActiveRunDeletion(cmd, runs).deny, true, cmd)
  for (const cmd of ["git branch -D harnie/foo2", "git branch -D other-branch", "git branch --list harnie/foo", "git push origin harnie/foo"])
    assert.equal(decideActiveRunDeletion(cmd, runs).deny, false, cmd)
})

test("decideBash: 활성 run 삭제는 sanctioned CLI(worktree.mjs remove)로는 여전히 허용, 원문 git/rm은 deny", () => {
  const runs = [{ worktreePath: "/repo/.harnie-wt/harnie-x", slug: "x", branch: "harnie/x" }]
  const sanctioned = "node /plugin/scripts/worktree.mjs remove --repo /repo --branch harnie/x --delete-branch"
  assert.equal(decideBash({ command: sanctioned, ...ctx, activeRuns: runs }).deny, false)
  assert.equal(decideBash({ command: "git worktree remove /repo/.harnie-wt/harnie-x", ...ctx, activeRuns: runs }).deny, true)
  assert.equal(decideBash({ command: "git branch -D harnie/x", ...ctx, activeRuns: runs }).deny, true)
  // activeRuns를 안 넘기면(기본값 []) 새 predicate가 무해하게 no-op — 기존 호출부 하위호환.
  assert.equal(decideBash({ command: "git worktree remove /repo/.harnie-wt/harnie-x", ...ctx }).deny, false)
})

test("decideBash: loop CLI는 활성 task worktree를 repo로 허용", () => {
  const wt = "/repo/.harnie-wt/harnie-x-t1"
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs capture ${wt}`, ...ctx }).deny, false)
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs delta ${wt} a --out ${wt}/.harnie/review/code/delta.patch`, ...ctx }).deny, false)
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs apply --root ${wt} --ledger ${wt}/.harnie/review/code/ledger.json --review ${wt}/.harnie/review/code/round-1.txt --ns CR --state ${wt}/.harnie/review/code/state.json --artifact a`, ...ctx }).deny, false)
  const other = wt.replace("harnie-x-t1", "harnie-other-t1")
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs capture ${other}`, ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs delta ${other} a --out ${other}/.harnie/review/code/delta.patch`, ...ctx }).deny, true)
  assert.equal(decideBash({ command: `node /plugin/scripts/loop.mjs apply --root ${other} --ledger ${other}/.harnie/review/code/ledger.json --review ${other}/.harnie/review/code/round-1.txt --ns CR --state ${other}/.harnie/review/code/state.json --artifact a`, ...ctx }).deny, true)
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

test("isActiveTaskWorktree: 활성 slug의 직접 task worktree만 허용", () => {
  assert.equal(isActiveTaskWorktree("/repo", "x", "/repo/.harnie-wt/harnie-x-t1"), true)
  assert.equal(isActiveTaskWorktree("/repo", "x.y", "/repo/.harnie-wt/harnie-x.y-tA_2"), true)
  assert.equal(isActiveTaskWorktree("/repo", "x", "/repo/.harnie-wt/harnie-other-t1"), false)
  assert.equal(isActiveTaskWorktree("/repo", "x", "/repo/.harnie-wt/harnie-x-t1/nested"), false)
  assert.equal(isActiveTaskWorktree("/repo", "x", "/repo/.harnie-wt-evil/harnie-x-t1"), false)
  assert.equal(taskIdFromActiveTaskWorktree("/repo", "x", "/repo/.harnie-wt/harnie-x-tA_2"), "A_2")
})

test("decideCodex: 승인 후 builder는 workspace-write + 활성 cwd + building task", () => {
  const base = { isReply: false, sandbox: "workspace-write", root: "/repo", slug: "x", cwd: "/repo", phase: "executing", buildingUnboundTasks: ["1"], pendingRunRootBootstrap: "1", taskRepoWorkroots: { "1": "/repo" } }
  assert.equal(decideCodex(base).deny, false)
  // 0.13: 태스크별 worktree cwd는 더 이상 허용되지 않는다 — PostToolUse가 귀속할 수 없는 호출을 열지 않는다
  assert.equal(decideCodex({ ...base, cwd: "/repo/.harnie-wt/harnie-x-t1" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/repo/.harnie-wt/harnie-other-t1" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/repo/.harnie-wt" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/repo/.harnie-wt/harnie-x-t1/nested" }).deny, true)
  assert.equal(decideCodex({ ...base, cwd: "/repo/.harnie-wt-evil/harnie-x-t1" }).deny, true)
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
