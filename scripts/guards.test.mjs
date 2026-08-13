// guards.mjs 테스트 — 강제 훅 순수 결정 함수(H1 Write/Bash/Task/Codex, H2 Stop).
import { test } from "node:test"
import assert from "node:assert/strict"
import { isControlPath, decideWriteEdit, decideBash, decideTask, decideCodex, decideStop, referencesHarnie } from "./guards.mjs"

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

test("isControlPath: 세션 바인딩 디렉터리도 control(T2)", () => {
  assert.equal(isControlPath(".harnie/sessions/abc-123.json"), true)
})

// CR-001 회귀: worktree-per-run(T2)의 컨테이너 `.harnie-wt`가 `.harnie` 매칭에 걸려 그 안의 평범한 파일까지
// Bash로 접근 불가능해지던 버그. `.harnie-wt/<slug>/…`(nested `.harnie/` 없는 평범한 파일)은 매치되지 않아야 하고,
// 컨테이너 자체 참조·nested `.harnie/` 참조는 계속 매치돼야 한다.
test("referencesHarnie: .harnie-wt 컨테이너 안의 평범한 파일은 매치 안 됨(CR-001), 컨테이너 자체·nested .harnie는 매치", () => {
  assert.equal(referencesHarnie("git -C .harnie-wt/harnie-foo status"), false)
  assert.equal(referencesHarnie("node --test .harnie-wt/harnie-foo/x.test.mjs"), false)
  assert.equal(referencesHarnie("npm --prefix .harnie-wt/harnie-foo test"), false)
  assert.equal(referencesHarnie("cat .harnie-wt/harnie-foo/README.md"), false)
  assert.equal(referencesHarnie("rm -rf .harnie-wt"), true)                          // 컨테이너 자체(모든 run 삭제)
  assert.equal(referencesHarnie("ls .harnie-wt/harnie-foo/.harnie/active.json"), true) // nested 권위 상태
  assert.equal(referencesHarnie("rm -rf .harnie"), true)                             // 기존 단일 .harnie 보호 유지
  assert.equal(referencesHarnie("cat .harnie/pending-route/x.json"), true)
  // CR-004 회귀: trailing slash·glob도 "컨테이너 전체"를 뜻하므로 매치돼야 한다(셸 탭완성·정리 명령의 흔한 형태).
  assert.equal(referencesHarnie("rm -rf .harnie-wt/"), true)
  assert.equal(referencesHarnie("rm -rf .harnie-wt/*"), true)
  assert.equal(referencesHarnie("rm -rf ./.harnie-wt/"), true)
  assert.equal(referencesHarnie("find .harnie-wt/ -name active.json -delete"), true)
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

test("decideBash: 비-sanctioned Bash의 .harnie **변형**은 phase 무관 deny(승인 후 포함)", () => {
  assert.equal(decideBash({ command: "find .harnie -delete" }).deny, true)
  assert.equal(decideBash({ command: "rm -rf .harnie" }).deny, true)
  assert.equal(decideBash({ command: "git clean -fd .harnie" }).deny, true)
  assert.equal(decideBash({ command: "node -e \"require('fs').rmSync('.harnie/plan/x/manifest.json')\"" }).deny, true)
  assert.equal(decideBash({ command: "echo x > .harnie/y" }).deny, true)
  assert.equal(decideBash({ command: "mv .harnie/plan .harnie/old", phase: "executing" }).deny, true)
})

test("decideBash: .harnie read-only 조사는 허용(쓰기 능력 없음 — 오탐 제거)", () => {
  for (const phase of ["planning", "awaiting-approval", "executing"]) {
    assert.equal(decideBash({ command: "cat .harnie/active.json", phase }).deny, false, phase)
    assert.equal(decideBash({ command: "cat .harnie/plan/x/manifest.json", phase }).deny, false, phase)
    assert.equal(decideBash({ command: "ls .harnie/plan/x/review", phase }).deny, false, phase)
    assert.equal(decideBash({ command: "jq .phase .harnie/plan/x/execution.json", phase }).deny, false, phase)
  }
  // read-only 허용이 auto-allow(프롬프트 skip)로 번지지 않는다
  assert.equal(decideBash({ command: "cat .harnie/active.json", phase: "planning" }).autoAllow, false)
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

test("decideBash: auto-allow는 sanctioned 4종만(capture·delta·completion·seal-verify), 나머지 sanctioned는 프롬프트", () => {
  const AR = "/repo", TT = new Set(["/repo/scripts/loop.mjs", "/repo/scripts/execution.mjs"])
  const ctx = { phase: "executing", trustedClis: TT, activeRoot: AR, activeSlug: "feat-x", activeTrack: "plan" }
  // 4종 → deny:false, autoAllow:true
  assert.equal(decideBash({ command: "node /repo/scripts/loop.mjs capture /repo", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /repo/scripts/loop.mjs delta /repo abc --out .harnie/plan/feat-x/review/u/d.patch", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs completion --root /repo --slug feat-x", ...ctx }).autoAllow, true)
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs seal-verify --root /repo --slug feat-x", ...ctx }).autoAllow, true)
  // 나머지 sanctioned → 통과하되 autoAllow:false(프롬프트 유지)
  const notAuto = (cmd) => { const d = decideBash({ command: cmd, ...ctx }); assert.equal(d.deny, false, cmd); assert.equal(d.autoAllow, false, cmd) }
  notAuto("node /repo/scripts/loop.mjs apply --root /repo --ledger .harnie/plan/feat-x/review/u/ledger.json --state .harnie/plan/feat-x/review/u/state.json --ns CR --review .harnie/plan/feat-x/review/u/round-1.txt --artifact " + "0".repeat(40))
  notAuto("node /repo/scripts/execution.mjs verify --root /repo --slug feat-x --task T1")
  notAuto("node /repo/scripts/execution.mjs seal --root /repo --slug feat-x")
  notAuto("node /repo/scripts/execution.mjs set-task --root /repo --slug feat-x --task T1 --run-status building")
  notAuto("node /repo/scripts/execution.mjs init --root /repo --slug feat-x")
  // 일반 read-only Bash는 auto-allow 아님(범위 확대 안 함)
  assert.equal(decideBash({ command: "git status", ...ctx }).autoAllow, false)
  assert.equal(decideBash({ command: "cat src/foo.ts", ...ctx }).autoAllow, false)
})

test("decideBash: 인터프리터 바인딩 — bare node/신뢰 execPath만, 위장 /tmp/node 거부(DR-004)", () => {
  const AR = "/repo", TT = new Set(["/repo/scripts/loop.mjs"])
  const ctx = { phase: "executing", trustedClis: TT, activeRoot: AR, activeSlug: "feat-x", activeTrack: "plan" }
  // bare node → sanctioned·auto-allow
  assert.equal(decideBash({ command: "node /repo/scripts/loop.mjs capture /repo", ...ctx }).autoAllow, true)
  // trustedNode 절대경로 일치 → 허용
  assert.equal(decideBash({ command: "/opt/n/bin/node /repo/scripts/loop.mjs capture /repo", trustedNode: "/opt/n/bin/node", ...ctx }).autoAllow, true)
  // 위장 /tmp/node → sanctioned 아님 → executing이라 deny는 아니지만 autoAllow:false(프롬프트)
  const evil = decideBash({ command: "/tmp/node /repo/scripts/loop.mjs capture /repo", trustedNode: "/opt/n/bin/node", ...ctx })
  assert.equal(evil.autoAllow, false)
  // planning에서 위장 인터프리터 → read-only 아님 → deny
  assert.equal(decideBash({ command: "/tmp/node /repo/scripts/loop.mjs capture /repo", phase: "planning", trustedClis: TT, activeRoot: AR, activeSlug: "feat-x", activeTrack: "plan", trustedNode: "/opt/n/bin/node" }).deny, true)
})

test("decideBash: 유효 컨텍스트 없으면 auto-allow 금지 — null·빈문자열·공백slug·규약밖 track(CR-001)", () => {
  const T2 = new Set(["/repo/scripts/loop.mjs"])
  const cmd = "node /repo/scripts/loop.mjs capture /repo"
  // activeRoot 없음(호환 경로): sanctioned 통과하지만 auto-allow 금지
  const d0 = decideBash({ command: cmd, trustedClis: T2 })
  assert.equal(d0.deny, false); assert.equal(d0.autoAllow, false)
  // 빈 문자열 slug/track → auto-allow 금지
  assert.equal(decideBash({ command: cmd, trustedClis: T2, activeRoot: "/repo", activeSlug: "", activeTrack: "" }).autoAllow, false)
  // 공백 slug(failClosed의 " ") → 금지
  assert.equal(decideBash({ command: cmd, trustedClis: T2, activeRoot: "/repo", activeSlug: " ", activeTrack: "plan" }).autoAllow, false)
  // 규약 밖 track → 금지
  assert.equal(decideBash({ command: cmd, trustedClis: T2, activeRoot: "/repo", activeSlug: "feat-x", activeTrack: "weird" }).autoAllow, false)
  // 유효 컨텍스트 → auto-allow
  assert.equal(decideBash({ command: cmd, trustedClis: T2, activeRoot: "/repo", activeSlug: "feat-x", activeTrack: "plan" }).autoAllow, true)
})

test("decideBash: execution --track 생략은 plan로 간주 — 비-plan 컨텍스트에선 매치 안 됨(CR-002)", () => {
  const TT = new Set(["/repo/scripts/execution.mjs"])
  const qctx = { trustedClis: TT, activeRoot: "/repo", activeSlug: "feat-x", activeTrack: "quick" }
  // --track 생략(=plan) but active track=quick → 불일치 → sanctioned 아님 → planning deny
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs completion --root /repo --slug feat-x", phase: "planning", ...qctx }).deny, true)
  // 명시 --track quick → 매치 → executing에서 auto-allow
  assert.equal(decideBash({ command: "node /repo/scripts/execution.mjs completion --root /repo --slug feat-x --track quick", phase: "executing", ...qctx }).autoAllow, true)
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

test("decideBash: read-only 판정 오탐 4건 — git 전역옵션·인용부호 파이프·stderr 억제·find", () => {
  const ro = (cmd) => assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, false, cmd)
  // (a) git 전역 옵션이 하위명령 앞에 오는 형태
  ro("git -C /tmp/x rev-parse HEAD")
  ro("git -C /tmp/x log --oneline -5")
  ro("git --no-pager diff HEAD")
  ro("git --git-dir=/tmp/x/.git status")
  ro("git -c core.quotepath=false ls-files")
  // (b) 인용부호 안의 | 는 파이프가 아니다
  ro("rg -n \"A|B\" p")
  ro("grep -nE 'foo|bar' src/app.js")
  // (c) stderr 억제만 리다이렉트 예외
  ro("grep -r x . 2>/dev/null")
  ro("find . -name '*.mjs' 2>&1")
  // (d) find 재포함
  ro("find . -name '*.mjs'")
  ro("find src -type f -newer package.json")
  // 파이프 조합
  ro("grep x f | head -5")
})

test("decideBash: 오탐 수정이 승인-前 쓰기 게이트를 넓히지 않는다", () => {
  const deny = (cmd) => assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, true, cmd)
  deny("find . -delete")
  deny("find . -exec rm {} ;")
  deny("find . -execdir rm {} +")
  deny("find . -fprint out.txt")
  deny("rm -rf .harnie")
  deny("echo x > .harnie/y")
  deny("git apply p.patch")
  deny("npm i")
  deny("node -e \"require('fs').writeFileSync('a','b')\"")
  deny("git -C /tmp/x apply p.patch")          // 전역옵션 스킵 후에도 하위명령이 GIT_RO 밖
  deny("git -C /tmp/x diff --output=/tmp/o")   // 쓰기 옵션은 여전히 거부
  deny("grep x f > out.txt")                   // stdout 리다이렉트는 예외 아님
  deny("grep x f 2>out.txt")                   // stderr를 파일로 쓰는 것도 예외 아님
  deny("cat f | tee out.txt")                  // 파이프 뒷단이 쓰기 명령
})

test("decideBash: 인용 인식이 치환·플래그 검사를 무력화하지 않는다(리뷰 R1 회귀)", () => {
  const deny = (cmd) => { for (const phase of ["planning", "executing"]) assert.equal(decideBash({ command: cmd, phase }).deny, true, `${phase}: ${cmd}`) }
  // 큰따옴표 안에서도 명령치환·백틱은 살아있다 → 판정 불가(fail-closed)
  deny("cat \"$(rm -rf .harnie; echo x)\"")
  deny("cat \"`rm -rf .harnie`\"")
  deny("grep x \"$(pwd)/.harnie/active.json\"")
  // 인용·이스케이프로 감싼 쓰기 플래그도 argv로 벗겨 검사 → 거부
  deny("find .harnie '-delete'")
  deny("find .harnie \\-delete")
  deny("find .harnie \"-delete\"")
  // 외부 프로그램을 실행시키는 옵션 → read-only 명령이어도 거부
  deny("rg --pre 'sh -c \"rm -rf .harnie\"' x .harnie/active.json")
  deny("rg --pre=sh x .harnie/active.json")
  // 닫히지 않은 인용 → 판정 불가
  deny("cat '.harnie/active.json")
  // .harnie 무관 명령의 실행 옵션은 승인 前 게이트에서만 거부(승인 後 Bash 자유는 기존 설계)
  assert.equal(decideBash({ command: "git log --ext-diff", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "rg --pre sh x src", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "git log --ext-diff", phase: "executing" }).deny, false)
})

test("decideBash: .harnie 접근은 좁은 positive 판정만 통과(리뷰 R2 회귀)", () => {
  const deny = (cmd) => { for (const phase of ["planning", "executing"]) assert.equal(decideBash({ command: cmd, phase }).deny, true, `${phase}: ${cmd}`) }
  // 리뷰 R2가 보고한 4종 — denylist가 놓치던 부작용 옵션·파라미터 확장
  deny("tree -o .harnie/active.json")
  deny("find .harnie -okdir rm -rf {} +")
  deny("find .harnie \"${X:--delete}\"")           // 셸이 `-delete`로 확장 → 확장 자체를 fail-closed
  deny("git -c core.pager=evil log .harnie")
  // 플래그 없이 위치인자로 쓰는 형태(열거로 닫을 수 없다는 증거)
  deny("uniq .harnie/active.json .harnie/pwned")
  // positive 판정을 직접 공격: 경로지정 위장 실행파일·긴 부작용 옵션·파이프 뒷단 쓰기
  deny("/tmp/cat .harnie/active.json")
  deny("./cat .harnie/active.json")
  deny("file -C -m .harnie/active.json")
  deny("rg --pre sh x .harnie/active.json")
  deny("cat .harnie/active.json | tee .harnie/pwned")
  deny("cp .harnie/active.json .harnie/bak")
  deny("env cat .harnie/active.json")
  deny("cat $X/.harnie/active.json")
  // 정상 조사는 계속 허용
  const allow = (cmd) => assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, false, cmd)
  allow("cat .harnie/active.json")
  allow("cat .harnie/active.json 2>/dev/null")
  allow("jq .phase .harnie/plan/x/execution.json")
  allow("ls -la .harnie/plan/x/review")
  allow("grep -nE 'phase|slug' .harnie/active.json")
  allow("head -5 .harnie/active.json")
  allow("test -s .harnie/active.json")
  allow("cat .harnie/active.json | wc -l")
  allow("ls --color=always .harnie")
})

test("decideBash: brace·glob 확장이 옵션 형태를 만들 수 있으면 fail-closed(리뷰 R3 회귀)", () => {
  const deny = (cmd) => { for (const phase of ["planning", "executing"]) assert.equal(decideBash({ command: cmd, phase }).deny, true, `${phase}: ${cmd}`) }
  // brace 확장이 `--pre /bin/rm` 두 단어가 되어 실제로 .harnie 파일이 삭제된 사례
  deny("rg x {--pre,/bin/rm} .harnie/active.json")
  deny("cat {--pre,/bin/rm} .harnie/active.json")
  deny("rg x {{--pre,a},b} .harnie/active.json")
  deny("rg x ''{--pre,y} .harnie/active.json")     // 빈 인용 접두어도 접두어 없음
  // 무접두 glob은 `-`로 시작하는 파일명으로 확장될 수 있다
  deny("rg x * .harnie/active.json")
  deny("grep x ?? .harnie/active.json")
  deny("rg x [a-z]* .harnie/active.json")
  deny("rg x *pre .harnie/active.json")
  // 승인 前 소스 게이트도 같은 부류(임의 실행 통로)
  assert.equal(decideBash({ command: "rg x {--pre,/bin/rm} src", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "grep x * src", phase: "planning" }).deny, true)
  // 확장 결과가 리터럴 접두어로 고정되면 옵션 형태가 될 수 없다 → 유지
  const allow = (cmd) => assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, false, cmd)
  allow("cat .harnie/*/manifest.json")
  allow("ls .harnie/plan/*/review")
  allow("rg x .{--pre,/bin/rm} .harnie/active.json") // `.--pre`·`./bin/rm` — 둘 다 경로
  allow("find . -name '*.mjs'")                      // 인용된 glob은 셸이 확장하지 않는다
  allow("grep -r x src")
})

test("decideBash: 홑따옴표 밖 파라미터 확장은 fail-closed(토큰=argv 계약 유지)", () => {
  for (const cmd of ["cat $HOME/f", "cat \"$HOME/f\"", "grep \"$PAT\" f", "find . -name \"${X:--delete}\""])
    assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, true, cmd)
  assert.equal(decideBash({ command: "grep '$HOME' f", phase: "planning" }).deny, false) // 홑따옴표 안은 리터럴
})

test("decideBash: 파일을 쓰는 형태가 있는 명령은 승인 前 allowlist에서 제외(tree·uniq)", () => {
  assert.equal(decideBash({ command: "tree -o out.txt", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "tree src", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "uniq src/a src/b", phase: "planning" }).deny, true)
  assert.equal(decideBash({ command: "find . -okdir rm -rf {} +", phase: "planning" }).deny, true)
})

test("decideBash: 렉서 경계 — 인용 밖 메타는 fail-closed, 인용 안 리터럴은 argv로", () => {
  const deny = (cmd) => assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, true, JSON.stringify(cmd))
  const allow = (cmd) => assert.equal(decideBash({ command: cmd, phase: "planning" }).deny, false, JSON.stringify(cmd))
  deny("cat f\nrm -rf .harnie")                        // 인용 밖 개행
  deny("FOO=bar cat .harnie/active.json")              // env 접두 할당은 선두 명령으로 인정 안 함
  deny("cat f # ; rm -rf .harnie")                     // 주석 뒤 메타도 보수적으로 거부
  deny("sh -c 'cat .harnie/active.json'")              // 인터프리터는 allowlist 밖
  deny("cat .harnie/active.json '--output=/tmp/x'")    // 인용된 쓰기 플래그
  allow("grep 'a\nb' f")                               // 인용 안 개행은 인자(명령 분리 아님)
  allow("grep x f 2>&1 | wc -l")                       // stderr 억제 + 파이프
  allow("cat .harnie/*/manifest.json")                 // glob 읽기
})

test("decideWriteEdit: outside=true면 승인 前 run 디렉터리 밖 규칙 미적용(control 검사는 유지)", () => {
  const base = { phase: "planning", track: "plan", slug: "x" }
  // repo 밖 경로: 기존(outside 미지정/false)엔 deny, outside=true면 allow
  assert.equal(decideWriteEdit({ ...base, relPath: "../scratch/notes.md" }).deny, true)
  assert.equal(decideWriteEdit({ ...base, relPath: "../scratch/notes.md", outside: false }).deny, true)
  assert.equal(decideWriteEdit({ ...base, relPath: "../scratch/notes.md", outside: true }).deny, false)
  assert.equal(decideWriteEdit({ ...base, relPath: "/tmp/x/notes.md", outside: true }).deny, false)
  // control 검사는 outside=true에서도 유지
  assert.equal(decideWriteEdit({ ...base, relPath: ".harnie/active.json", outside: true }).deny, true)
  assert.equal(decideWriteEdit({ ...base, relPath: ".harnie/plan/x/manifest.json", outside: true, phase: "executing" }).deny, true)
  // repo 안 소스는 outside=false 기본값에서 기존대로 deny
  assert.equal(decideWriteEdit({ ...base, relPath: "src/foo.ts" }).deny, true)
})

test("decideTask: designer는 read-only라 planning 허용, builder deny", () => {
  assert.equal(decideTask({ subagentType: "harnie-designer", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-builder", phase: "planning" }).deny, true)
  assert.equal(decideTask({ subagentType: "harnie-scout", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-reviewer", phase: "awaiting-approval" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie-builder", phase: "executing" }).deny, false)
})

test("decideTask: plugin-namespaced read-only 에이전트도 planning 허용(설치본 `harnie:` 접두어, 라이브 버그)", () => {
  assert.equal(decideTask({ subagentType: "harnie:harnie-scout", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie:harnie-designer", phase: "planning" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie:harnie-reviewer", phase: "awaiting-approval" }).deny, false)
  assert.equal(decideTask({ subagentType: "harnie:harnie-builder", phase: "planning" }).deny, true) // 빌더는 여전히 차단
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
