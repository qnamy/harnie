# PHASE A — PLAN (계획 단계)

> `skills/dev-full/SKILL-ko.md`에서 PHASE A로 진입할 때 이 파일을 읽는다. 그 파일의 Step 0·상태 위치·위임 참조 규칙·실행 상태/강제 훅·Notepad 프로토콜 섹션은 이미 읽었다고 전제한다 — 여기서 재서술하지 않는다.

**A0. 활성 run 채택(자체 init 금지).** bootstrap 훅의 컨텍스트 메시지에서 run 워크루트인 `<repo>`를 해석하고, 필요하면 `<main repo>/.harnie/sessions/<이 세션의 id>.json`에서 복구한다. bootstrap 훅이 그곳에 이미 이 호출의 `<repo>/.harnie/active.json`과 `execution.json`을 만들었다(phase=planning). 그 워크루트의 `.harnie/active.json`을 읽어 `track === "plan"` 확인 후 그 `slug`를 전 구간에 쓴다. 없거나 손상이면 **중단하고 bootstrap 실패 보고** — 절대 `execution.mjs init`으로 복구하지 않는다. sentinel이 있으므로 강제 훅이 승인 前 소스 쓰기·write 서브에이전트·workspace-write codex를 차단한다.

**A1. 범위비례 조사로 그라운딩.** `harnie-scout`(haiku)를 **병렬**로 스폰해 조사한다. 아래 각 항목에 대해 먼저 **존재·관련성**을 확인하고, **관련 있는 것만 충분히 깊게** 추적한다(무관한 영역까지 깊게 파는 건 scope inflation):

- 영향 코드와 그 **호출 경로**(caller·callee),
- 그 영역을 덮는 기존 **테스트**,
- **설정·환경 변수**,
- **데이터/스키마·마이그레이션**,
- **외부 연동·API**,
- 관련 **문서/ADR·저장소 지침**(`AGENTS.md`·`CLAUDE.md`·`README`·팀 컨벤션),
- 컨벤션을 따를 **유사 기존 구현**.

추정 전에 실제 파일·인터페이스·의존성·컨벤션을 근거로 잡는다.

**A2. 질문은 CLEAR/UNCLEAR 라벨이 아니라 근거로 결정한다.**

- 코드·테스트·설정·문서에서 **확인·추론 가능한 것은 묻지 않는다**(먼저 A1로 조사).
- **다음일 때만 질문한다**(도출 불가 + 오추정 비용이 큰 것에 한정): (a) **사용자만 정할 수 있는 제품·정책 의도**(어디에도 안 적힌 동작·UX·트레이드오프), (b) **유효한 해석이 실질적으로 갈리는** 모호한 요구, (c) 오추정 시 **상당한 재작업·호환성 파괴**를 부르는 결정, (d) 추론 불가한 **외부 컨텍스트** — 자격증명의 **소스/설정**·타깃·계정(소스/설정만 묻고 비밀값은 절대 요청하지 않는다).
- **질문 전에** 조사한 근거·**확인 못 한 부분**·**선택지별 영향**·권장 기본값(WHY)을 제시한다.
- **묶음 한도**: 설계 발견 라운드 **한 번에 최대 3개**, 포괄·복합 질문 금지. (A5 승인 질문은 별개이며 여기 셈에 안 든다.)
- **해소되지 않았지만 진행을 막지 않는 불확실성**(모든 비질문 항목이 아니라)만 기본값과 함께 `plan.md`의 `## Assumptions` 섹션에 기록한다 — announce만 하지 않는다 — 설계 리뷰·승인 게이트가 볼 수 있게.

**A3. 아키텍처 설계(정식) + 리뷰 루프 (조건부).** `harnie-designer`(opus/max)에게 **아키텍처 설계를 "정식으로"** 요청한다 — 위임 프롬프트에 `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-arch.md`의 **절대경로를 전달**하고 `architecture, formal`을 신호한다; designer의 에이전트 본문이 그 프로필을 먼저 Read하도록 요구하므로 계약을 프롬프트에 붙여넣지 말라. 시스템 경계·데이터 소유권·기술선택·SPOF에 집중, 클래스·SQL로 안 내려감. main은 받은 설계를 **그것을 참조하는 위임 前에** `.harnie/plan/<slug>/design/rev-N.md`에 쓰고(§위임 참조 규칙), 같은 리비전을 `plan.md`의 아키텍처 섹션에 기록한다.
- **조건부**: 경계/데이터 소유권/기술 선택이 실제로 **바뀔 때만** 이 단계를 수행한다. 기존 아키텍처가 그대로면(그 안의 큰 상세 작업) skip하고 A4로 간다 — 근거 없는 정식 아키 단계는 scope inflation.
- 수행 시 → **아키 설계 리뷰 루프**(review-loop-driver.md, producer=designer, 기준=design-review.md **아키 고도 렌즈**: 경계·소유권·기술선택·SPOF, namespace `DR`, `<dir>`=`.harnie/plan/<slug>/review/design-arch/`)를 APPROVE까지. R1의 delta 대신 **`design/rev-N.md` 경로를 Codex 리뷰어에게 전달**하고 리뷰 前에 읽도록 지시한다 — 첫 리뷰는 경로만, 재리뷰는 경로 + 변경된 섹션명 목록(나머지 R2~R5 동일).
- 리뷰 라운드에 답하는 각 개정본은 **새 `rev-N.md`**이며, 재리뷰 위임 前에 먼저 쓴다. 이전 파일이나 tool-result blob을 가리켜 재리뷰하지 않는다.

**A4. 상세 설계(정식) + 리뷰 루프.** 승인된 아키(또는 기존 아키) 위에서 `harnie-designer`(opus/max)에게 **상세 설계를 "정식으로"** 요청한다 — 위임 프롬프트에 `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md`의 **절대경로를 전달**하고 `detailed design, formal`을 신호한다; designer의 에이전트 본문이 그 프로필을 먼저 Read하도록 요구한다. 요구 추적표·핵심 처리 로직·계약·데이터/상태·작업 분해, decision-complete 수준을 요구한다. 아키 결정을 조용히 바꾸지 않는다(바꿔야 하면 A3로 되돌려 아키 변경 요청). main은 받은 설계를 그것을 참조하는 위임 前에 다음 `.harnie/plan/<slug>/design/rev-N.md`에 쓰고, 같은 리비전을 `plan.md`의 상세 섹션에 기록한다.
- → **상세 설계 리뷰 루프**(A3와 **독립** — 별도 ledger·state, producer=designer, 기준=design-review.md **상세 고도 렌즈**: decision-completeness·요구충족·실패모드, namespace `DR`, `<dir>`=`.harnie/plan/<slug>/review/design-detail/`)를 APPROVE까지. A3와 동일하게 **R1 git-delta 대신 리뷰어에게 `design/rev-N.md` 경로를 전달**한다(첫 리뷰는 경로만, 재리뷰는 경로 + 변경된 섹션명 목록). 설계 파일은 `.harnie/`/git 관리라 delta 비적용이기 때문이다.
- 두 루프 모두 설계 오류를 **구현 전에** 잡는 게 목적. STALLED면 사용자 보고. (아키·상세는 각각 독립 리뷰 — 아키 APPROVE 후 상세로.)
- **리뷰 지적 반영 순서 — 충족안을 쓰기 前에 두 질문에 먼저 답한다(두 루프 공통).** 각 REJECT 지적에 대해 이 순서로: ① 이 지적이 상정한 위협/실패가 **위협모델 안**인가(`§0.1` — 실수하는 fallible·over-eager 오케스트레이터/빌더가 대상이고, 세션을 통제하는 적대적 main은 비목표)? ② **이 기구가 존재해야 하는가**, 아니면 설계에 이미 있는 것으로 덮이는가? 두 답을 낸 뒤에야 어떻게 충족할지 쓴다. 매 REJECT를 "어떻게 충족하지?"로만 받는 것이 claim·lease·영수증·해시 식별자를 리비전마다 누적시키고, 되돌리는 데 라운드를 여러 번 쓰게 만든 원인이다.
- **기구를 새로 추가하는 반영은 근거를 함께 남긴다**: 그 기구가 막는 **구체적 실수 시나리오 1개 이상**을 새 `design/rev-N.md`의 `## Revision Notes`에 기록한다. 근거를 못 대면 기구를 추가하지 말고, 다음 라운드에 위 두 답을 제시해 리뷰어에게 **blocking 요구 철회**를 요청한다. ledger는 리뷰어의 다음 응답으로만, 그리고 `mergeLedger`가 받는 형태로만 움직인다: 리뷰어가 **원래 ID를 `resolved`로 닫고**(현재 범위·결정 하에서 그 위험이 더는 해당 없음), 기록할 가치가 남으면 **새 `non-blocking` ID를 연다**. 같은 ID를 blocking→non-blocking으로 재라벨하는 것은 `scripts/ledger.mjs`에서 fail-closed이므로 요청하지도 말고, `ledger.json`·verdict를 손으로 고치지도 않는다.
- **기계 파싱 manifest 블록(승인 대상)**: 상세 설계의 작업 분해가 확정되면 `plan.md`에 ` ```harnie-manifest ` 펜스로 JSON 블록을 넣는다 — `{tasks:[{id, deps, reviewUnit, scope:[<경로>], verification:[{executable, args, cwd, timeout}]}], gates:[{name, reviewUnit}]}`. `reviewUnit`은 task·gate 전부 유일(리뷰 디렉터리명), `scope`는 그 작업이 만질 경로, `verification`은 shell 없이 실행할 argv(런타임 증거 강제) — **각 항목은 아래 A5.0 증거 검사를 통과해야만 등록된다**. gates = Final Wave 4종(`coverage`·`quality`·`runtime`·`scope`, reviewUnit=`final-<name>`). 이 블록이 A5 승인 시 immutable `manifest.json`으로 고정되고 planHash로 봉인된다(권위 집합).

**A5. 승인 게이트 (1회, 실제 승인 툴에 바인딩).**

**A5.0 — 검증 명령이 실제로 무언가를 실행·검사하는지 등록 前에 입증한다(필수, arm 前).** manifest의 `verification[]`는 `verify`가 앞으로 만들어낼 **유일한 런타임 증거**다. 아무것도 훑지 않는 항목은 아무것도 검증하지 않으면서 영원히 통과한다. 승인 前 Bash는 H1이 read-only 명령으로 제한하므로, **그 게이트가 허용하는 가장 강한 방법으로** 각 항목을 입증하고 결과를 `plan.md`의 manifest 블록 옆에 기록한다:

- **read-only 질의 항목**(`rg`·`grep`·`git ls-files`·`jq` 등): argv를 **적힌 그대로** 1회 실행하고 `exitCode`와 **매치 수**를 기록한다. 매치 0건 → 등록하지 않는다.
- **인터프리터·테스트 러너가 필요한 항목**(`node --test`·`npm test`·`tsc --noEmit` 등): 승인 前에는 **실행할 수 없고, 실행시키려고 게이트를 느슨하게 하지 않는다** — 승인 前 repo 코드 실행은 H1이 막는 쓰기 primitive 그 자체다. 대신 **입력 집합**을 read-only 탐색 명령으로 입증하고(그 러너의 패턴이 수집할 파일 목록) 개수를 기록한다. 0이면 그 항목은 아무것도 검증하지 않는다. 조용히 새는 경우는 **아무것도 매치하지 않는 패턴 인자**다: `node --test 'scripts/*.test.mjs'`는 매치 파일이 없으면 `# tests 0`을 찍고 **exit 0**이다(Node v21.6.2에서 실행 확인). manifest argv는 shell 없이 실행되므로 그런 패턴은 러너에 문자 그대로 전달된다 — 매치 목록을 먼저 뽑고, 입력을 열거해 둔 argv를 우선한다.
- **"비어 있음"과 "조용함"은 다르다.** `tsc --noEmit`·quiet 린터·스키마 검사기는 성공 시 아무것도 출력하지 않는다 — 그건 통과지 빈 증거가 아니다. **비어 있음은 그 명령이 아무것도 훑지 않았다는 뜻**이다(매치 0·수집된 테스트 0·검사한 파일 0). silent-success 도구는 출력 크기가 아니라 **도구 자신이 알려주는 수**(파일 목록·verbose 플래그·보고된 입력 수)로 확인한다.
- **하류 백스톱은 없다 — 이 게이트가 유일하다.** `verify`는 argv를 `stdio: "ignore"`로 실행하고 receipt에는 `{executable, args, exitCode}`만 기록하므로([execution.mjs:734](scripts/execution.mjs:734)), 이후 어떤 단계도 "테스트 200개 실행"과 "0개 수집"을 구별하지 못한다. 게다가 승인 후 manifest는 immutable이고 `set-phase`는 `planning` 역전이를 거부하므로([execution.mjs:775](scripts/execution.mjs:775)), 껍데기 항목은 **그 run 안에서 고칠 수 없다**: 정직한 결말은 그 항목을 지목해 `HARNIE_STATUS: INCOMPLETE`로 보고하고 판단을 사용자에게 넘기는 것뿐이다. 여기서 맞게 잡아라.

몇 초면 확인되는 함정: `rg -e A -e B`는 AND가 아니라 **OR**, `rg --files-without-match`는 의도한 폴라리티를 뒤집는다. 실패할 수 없는 명령은 검증이 아니다.

> 이 단계의 올바른 기계화는 `scripts/execution.mjs`의 엔진 측 변경 2개이지 **Bash allowlist 확대가 아니다**: `dry-run` 서브커맨드(sanctioned CLI라 승인 前 실행 가능) + verify receipt에 **실행량 증거 필드**(출력 캡처 또는 훑은 개수)를 넣어 완료 재도출이 껍데기 통과를 거부할 수 있게 하는 것. 그것이 생기기 전까지는 위 검사가 계약이다.

**A5.1 — 승인 요청.** 리뷰 통과한 `plan.md`(아키+상세 설계 + 작업 분해 + 검증 전략과 그 A5.0 증거 + Final Wave + `harnie-manifest` 블록)를 사용자에게 제시한다. 그다음 **① `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "승인"`**을 부르고, **② 바로 그 다음**에 `AskUserQuestion`으로 승인 질문을 묻는다 — arm 이후 **처음** 관찰되는 `AskUserQuestion` 호출에 훅이 바인딩하므로(armed 질문과의 텍스트 대조가 아니라 일회성 순번 소비), 중간에 다른 질문을 끼워 넣으면 그게 슬롯을 대신 소비해 승인이 막혀버린다. 옵션 라벨은 선택 값만으로 승인/거절이 구분되게(예: `승인` / `거절·수정`). PreToolUse 훅이 그 호출의 tool_use_id와 현재 planHash를 pending으로 기록하고, PostToolUse 훅이 **선택 값이 정확히 "승인"이며 planHash가 그대로일 때만** manifest를 확정하고 phase=executing으로 연다(over-eager main의 self-승인·질문 후 몰래 plan 변경 차단; `set-phase`로는 executing 진입 불가). 거절·planHash 불일치면 awaiting-approval 유지(fail-closed). 승인 확정 후 → PHASE B(`phases/phase-b.md`를 읽는다). (A3·A4 설계 리뷰가 이미 건전성 게이트이므로 승인은 1회.)
