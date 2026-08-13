---
name: dev-full
description: 신규 기능·모듈·구조 변경 등 큰 작업을 풀 라이프사이클로 처리하는 오케스트레이터 — 계획(그라운딩+라우팅)→설계→크로스-모델 설계 리뷰(코드 前)→승인 게이트→오케스트레이션 실행→크로스-모델 코드 리뷰→최종 웨이브(Coverage·Quality·Runtime·Scope). 대칭 크로스-모델 방식으로 설계는 Claude→Codex 리뷰, 개발은 Codex→Claude 리뷰를 적용한다. `/harnie:dev-full` 또는 라우터 `/harnie:dev`가 호출한다. (내부 track 값은 그대로 `plan`.)
---

# plan 오케스트레이터 (class B: 신규·큰 변경)

너(main)는 계획 단계에서 실행 단계로 전환한다. 에이전트 전환이 아니라 한 세션의 국면 전환이다. 워크플로 규율은 이 스킬 + (P2 배송 시) 최소 강제 훅으로 지킨다.

## 매 사용자 메시지: 의도 재분류 (실행 권한 승계 금지)
새 사용자 메시지가 오면 **이번 실행 모드를 자동 승계하지 말고** 메시지를 `replace|add|status|question`으로 다시 분류한다. **status·question·단순 add**는 승인된 실행 권한을 취소하지 않는다(진행 유지). 그러나 **범위·목표가 바뀌면**(replace, 또는 범위를 바꾸는 add) 실행을 멈추고 `execution.json`·plan·리뷰 범위를 재계산한 뒤 필요한 재승인을 받고 이어간다. (실행 권한 리셋이 아니라 **메시지 의도·범위 리셋**.)

## Step 0 — 런타임 계약 주입 (필수, 먼저)
아래 canonical 파일을 **지금 Read** 한다(경로 참조만으론 부족 — 실제 내용을 이 세션에 올린다). 재서술하지 말고 조율만 한다.
- `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md` — 리뷰 루프 상태머신 + 출력 스키마 + ledger 규칙
- `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md` — 루프 CLI·codex 배선(R1~R5)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-arch.md` — 아키 작성 프로필(경량/정식 분기)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md` — 상세 작성 프로필(경량/정식 분기)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-review.md` — 설계 리뷰 기준(코드 前, namespace `DR`, 아키·상세 두 고도에 적용)
- `${CLAUDE_PLUGIN_ROOT}/instructions/code-review.md` — 코드 리뷰 기준(REJECT 편향, namespace `CR`)
- `${CLAUDE_PLUGIN_ROOT}/instructions/verification-tiers.md` — 검증 tier

> **대칭 크로스-모델**(각 단계 반대 프로바이더가 리뷰): **설계**(A3·A4) = Claude(`harnie-designer`) 산출 → **Codex** 리뷰 / **개발**(B2·B3·Final Wave) = **Codex** 빌더(codex MCP, `workspace-write`) 산출 → **Claude** 리뷰. codex MCP 툴명은 설치 형태에 따라 `mcp__plugin_harnie_codex__codex`/`mcp__codex__codex`, 재빌드·재리뷰는 `*__codex-reply`. 자세한 배선은 review-loop-driver.md.

## 상태 위치 (durable, 파일 기반)
`.harnie/plan/<slug>/`:
- `plan.md` — 설계 + 작업 분해 + 검증 전략 + Final Wave(Coverage·Quality·Runtime·Scope). 승인 게이트의 대상.
- `design/rev-N.md` — **버전이 붙은 설계 정본**: 리비전마다 파일 하나, N은 단조 증가, 덮어쓰기 없음. 서브에이전트·리뷰어에게 설계 내용으로 넘길 수 있는 **유일한 경로**.
- `notepad.md` — 진행 메모(크로스-프로바이더 공유 단일 소스).
- `review/design-arch/` · `review/design-detail/` — 아키·상세 설계 리뷰 루프 상태(각 독립: `ledger.json`·`state.json`·`round-N.txt`).
- `review/<unit>/` — 작업/웨이브별 코드 리뷰 루프 상태.

> 경로 단일 스킴: 모든 리뷰 루프 상태는 `.harnie/plan/<slug>/review/<name>/` 아래(quick의 `.harnie/quick/<slug>/`와 대칭). `<name>` = `design-arch` | `design-detail` | 코드 리뷰 단위.

## 위임 참조 규칙 (디스크 정본만)

서브에이전트·리뷰어에게 넘기는 모든 경로는 repo 안의 **디스크 정본**이어야 한다 — `.harnie/plan/<slug>/…` 또는 소스 파일. **tool-result blob 경로**(`tool-results/*.json`, 트랜스크립트 스크래치, 임시 캡처 등)는 **절대 넘기지 않는다.** 그 파일들은 읽히도록 쓰인 게 아니라서(한 줄 55k 토큰 JSON은 조용히 로드에 실패한다), 위임받은 쪽은 자기가 기억하는 **더 오래된 리비전**으로 설계를 재구성하게 되고, 그렇게 세대가 라운드를 넘어 뒤섞이면 하류에서 탐지되지 않는다.

따라서 **설계 산출물이 존재하는 순간부터**:

1. main이 현재 설계를 `.harnie/plan/<slug>/design/rev-N.md`에 쓴다 — **리비전마다 새 파일**, 이전 `N`을 덮어쓰지 않는다. **최초 작성 위임**(A3/A4 첫 패스)에는 아직 산출물이 없다 — designer가 작업과 그라운딩으로 `rev-1`을 만들고, 이 규칙은 **그 이후 모든 위임**에 적용된다.
2. **기존 설계를 참조하는 이후 위임**은 **그 정확한 경로와 리비전 번호**를 명시하고, 어떤 리비전이 리뷰 대상인지 말한다(예: "`design/rev-4.md`를 리뷰하라, rev-3은 폐기됨").
3. 설계 내용을 프롬프트에 인라인으로 싣는 것(`review-loop-driver.md` R2가 `DR` 루프에서 요구 — 설계 파일은 git delta에서 제외되므로)은 이 규칙을 **대체하지 않는다**: 인라인 내용과 명시한 `rev-N.md`는 **같은 리비전**이어야 한다.
4. **빌더 예외(B2).** Codex 빌더는 `.harnie/`에 접근하지 않으므로 `.harnie` 경로를 받지 않는다. 승인된 설계를 프롬프트에 **인라인**으로 주고, **어느 리비전에서 온 것인지(`rev-N`)를 명시**해 산출의 귀속을 유지한다. 경로 명시 요구는 `.harnie/`를 읽을 수 있는 위임 대상(designer·설계 리뷰어)에 적용된다.

위임받은 쪽이 참조 경로를 읽지 못했다고 보고하면 그 라운드의 산출은 **무효**로 보고, 참조를 고쳐 재위임한다. 기억으로 재구성한 결과는 절대 받아들이지 않는다.

## 실행 상태 + 강제 훅 (plan 전용 하네스 — `scripts/execution.mjs`)
plan 트랙은 **durable 실행 상태 + 최소 강제 훅**으로 두 불변식을 기계화한다: **① 승인 前 소스 쓰기 금지, ② 미승인·미완료를 done으로 확정 금지.** 권위 = planHash 고정 immutable `manifest.json` + 각 리뷰 단위 ledger·state + verification receipt(`execution.json`은 advisory 캐시일 뿐 신뢰하지 않는다 — 훅은 manifest+planHash로 승인을 판정하지 advisory phase를 믿지 않는다). 아래 스텝에서 `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`, `<repo>` = 이 run의 절대경로 **워크루트**다. 이는 세션 시작 디렉터리가 아니라 `/harnie:dev-full` bootstrap 훅이 컨텍스트 메시지(`hookSpecificOutput.additionalContext` 또는 `permissionDecisionReason`)로 보고한 전용 git worktree 경로다. 메시지를 찾을 수 없으면 `<main repo>/.harnie/sessions/<이 세션의 id>.json`의 `workroot` 필드에서 `<repo>`를 복구한다. **모든 `execution.mjs`·`loop.mjs` 호출은 `--root <repo>` 필수**(없으면 즉시 종료). 상태 조작은 **반드시 `execution.mjs`로만**(직접 Edit/Write/Bash-write는 훅이 차단):
- **활성 run은 bootstrap 훅이 만든다 — 스킬이 직접 만들지 않는다.** `/harnie:dev-full`(또는 라우터 `/harnie:dev` → `Skill(harnie:dev-full)`) 호출 시 bootstrap 훅이 보고한 워크루트 안에 sentinel(`<repo>/.harnie/active.json`)과 `execution.json`을 이미 만들었다. **위 bootstrap 컨텍스트 메시지나 세션 바인딩 파일에서 `<repo>`를 해석하고, `<repo>/.harnie/active.json`을 읽어 `track === "plan"`을 확인한 뒤 그 `slug`(`<slug>`)를 아래 모든 CLI에 쓴다. `execution.mjs init`을 직접 실행하지 않는다.** 그 워크루트의 active.json이 없거나 손상이면 **중단하고 bootstrap 훅 실패를 보고**한다 — 자체 init으로 복구하지 않는다(부트스트랩 갭 재발; `bootstrap-adherence.md` 참조).
- **승인 바인딩(A5)**: plan.md에 기계 파싱 `harnie-manifest` 블록이 있어야 한다. 승인 질문 직전 `execution.mjs arm-approval --root <repo> --slug <slug> --question "<질문>" --approve-option "승인"`(이 질문·옵션만 승인 후보로 arm)를 부르고, 승인은 실제 `AskUserQuestion`으로 받는다(PreToolUse가 질문/옵션 대조 후 pending, PostToolUse가 선택값 정확일치 관찰; §PHASE A A5). **승인·threadId 등록은 CLI로 노출되지 않는다** — 훅이 실제 툴 호출을 관찰해 in-process로만 수행(sanctioned Bash로 self-승인 불가).
- **빌더 게이트(B2)**: 작업 위임 직전 `set-task --root <repo> --slug <slug> --task <id> --run-status building` + `seal --root <repo> --slug <slug>`(권위 스냅샷) → 빌더 산출 후 delta 귀속 前 `seal-verify --root <repo> --slug <slug>`(빌더가 권위 파일 훼손 시 fail-closed, exit 3).
- **검증(B4)**: `verify --root <repo> --slug <slug> --task <id>` — manifest의 `verification[]` argv를 shell 없이 실행해 receipt 기록(reviewedPostSHA 기준 scopeHash).
- **완료(B6)**: `completion --root <repo> --slug <slug>`으로 manifest 순회 재도출(현재 working tree ↔ 리뷰된 tree 바인딩까지). Stop 훅이 같은 재도출로 미완료 종료를 차단하므로, 최종 응답에 `HARNIE_STATUS` footer로 정직 보고한다.

## Notepad 프로토콜 (`notepad.md`, append-only, 단일 writer)
`notepad.md`는 위임 사이로 **재사용할 지식**을 나르는 공유 소스다. 동시 append 충돌을 피하려 **오케스트레이터(main)를 유일 writer**로 둔다:
1. **위임 前 read** — 이번 작업에 관련된 notepad 구간을 읽는다.
2. **필요한 것만 주입** — 그 구간을 producer(Codex 빌더/designer) prompt에 싣는다(전체 덤프 금지).
3. **결과 회수** — producer/reviewer가 발견·결정·검증 결과를 응답으로 반환한다.
4. **각 위임·리뷰 라운드 종료 직후 append** — main이 그 결과를 notepad에 **추가만** 한다(작업 전체가 아니라 라운드 단위).
5. **덮어쓰기·삭제 금지** — 기존 기록은 불변(append-only). 각 항목엔 짧은 `<entry-id>`를 단다. **stale·오류 지식은 기존 항목을 고치지 않고 `supersedes <entry-id>` 정정 항목을 새로 append**한다(불변 유지하며 최신성 확보).

**기록 대상(재사용 지식만)**: 새로 발견된 제약 · 승인된 결정 · 다음 작업에 영향 주는 사실 · 검증 결과와 evidence 경로 · 실패 원인과 재진입 근거. **일반 진행 로그는 넣지 않는다**(AI-slop 방지).

---

## PHASE A — PLAN (계획 단계)

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

**A3. 아키텍처 설계(정식) + 리뷰 루프 (조건부).** `harnie-designer`(opus/max)에게 **아키텍처 설계를 "정식으로"** 요청한다 — 위임 프롬프트에 `design-authoring-arch.md`의 **정식 섹션 계약을 인라인 주입**하고 `architecture, formal`을 신호한다(서브에이전트는 프로필이 자동 로드되지 않음). 시스템 경계·데이터 소유권·기술선택·SPOF에 집중, 클래스·SQL로 안 내려감. main은 받은 설계를 **그것을 참조하는 위임 前에** `.harnie/plan/<slug>/design/rev-N.md`에 쓰고(§위임 참조 규칙), 같은 리비전을 `plan.md`의 아키텍처 섹션에 기록한다.
- **조건부**: 경계/데이터 소유권/기술 선택이 실제로 **바뀔 때만** 이 단계를 수행한다. 기존 아키텍처가 그대로면(그 안의 큰 상세 작업) skip하고 A4로 간다 — 근거 없는 정식 아키 단계는 scope inflation.
- 수행 시 → **아키 설계 리뷰 루프**(review-loop-driver.md, producer=designer, 기준=design-review.md **아키 고도 렌즈**: 경계·소유권·기술선택·SPOF, namespace `DR`, `<dir>`=`.harnie/plan/<slug>/review/design-arch/`)를 APPROVE까지. R1의 delta 대신 아키 설계를 codex `prompt`에 싣고 **그 리비전이 담긴 `design/rev-N.md` 경로를 함께 명시**한다(나머지 R2~R5 동일).
- 리뷰 라운드에 답하는 각 개정본은 **새 `rev-N.md`**이며, 재리뷰 위임 前에 먼저 쓴다. 이전 파일이나 tool-result blob을 가리켜 재리뷰하지 않는다.

**A4. 상세 설계(정식) + 리뷰 루프.** 승인된 아키(또는 기존 아키) 위에서 `harnie-designer`(opus/max)에게 **상세 설계를 "정식으로"** 요청한다 — 위임 프롬프트에 `design-authoring-detail.md`의 **정식 섹션 계약을 인라인 주입**하고 `detailed design, formal`을 신호(요구 추적표·핵심 처리 로직·계약·데이터/상태·작업 분해, decision-complete 수준). 아키 결정을 조용히 바꾸지 않는다(바꿔야 하면 A3로 되돌려 아키 변경 요청). main은 받은 설계를 그것을 참조하는 위임 前에 다음 `.harnie/plan/<slug>/design/rev-N.md`에 쓰고, 같은 리비전을 `plan.md`의 상세 섹션에 기록한다.
- → **상세 설계 리뷰 루프**(A3와 **독립** — 별도 ledger·state, producer=designer, 기준=design-review.md **상세 고도 렌즈**: decision-completeness·요구충족·실패모드, namespace `DR`, `<dir>`=`.harnie/plan/<slug>/review/design-detail/`)를 APPROVE까지. A3와 동일하게 **R1 git-delta 대신 상세 설계를 리뷰어 prompt에 싣고 그 `design/rev-N.md` 경로를 명시한다**(설계 파일은 `.harnie/`/git 관리라 delta 비적용).
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

**A5.1 — 승인 요청.** 리뷰 통과한 `plan.md`(아키+상세 설계 + 작업 분해 + 검증 전략과 그 A5.0 증거 + Final Wave + `harnie-manifest` 블록)를 사용자에게 제시한다. 그다음 **① `execution.mjs arm-approval --root <repo> --slug <slug> --question "<정확한 질문 텍스트>" --approve-option "승인"`**(이 승인 질문만 후보로 arm — 기대 질문·승인 옵션 값을 고정해 다른 질문의 오-바인딩·오판 차단)를 부르고 **② 곧바로 `AskUserQuestion`으로 그 질문을 그대로** 묻는다 — 질문 텍스트는 arm의 `--question`과 정확히 일치해야 하고, 옵션 라벨은 선택 값만으로 승인/거절이 구분되게(예: `승인` / `거절·수정`). 훅은 arm의 질문/옵션과 실제 질문/옵션을 대조하고, **선택 값이 정확히 `승인`일 때만** 승인으로 본다(질문 텍스트에 "승인"이 들어가도 오판 없음). 실제 승인 응답에 바인딩하는 이유: PreToolUse 훅이 armed 질문의 tool_use_id와 현재 planHash를 pending으로 기록하고, PostToolUse 훅이 **선택 값이 "승인"이며 planHash가 그대로일 때만** manifest를 확정하고 phase=executing으로 연다(over-eager main의 self-승인·질문 후 몰래 plan 변경 차단; `set-phase`로는 executing 진입 불가). 거절·planHash 불일치면 awaiting-approval 유지(fail-closed). 승인 확정 후 → PHASE B. (A3·A4 설계 리뷰가 이미 건전성 게이트이므로 승인은 1회.)

---

## PHASE B — EXECUTE (실행 단계)

**B1. 플랜 파싱 → 작업 + 의존성 맵.** named 의존이 없으면 fan-out. **delta는 전체 tree를 비교**하므로 비중첩 경로만으론 부족(loop.md 귀속 불변): **진짜 동시 실행 → 작업별 격리 worktree**, **공유 worktree → 작업들의 write+delta 캡처 구간을 직렬화**(A 빌드·캡처 완료 후 B 시작).

**B2. 각 작업 → Codex 빌더 위임 (개발 producer = Codex).** 위임 직전 순서로: ① `execution.mjs set-task --root <repo> --slug <slug> --task <id> --run-status building`(빌더 workspace-write codex 부트스트랩을 훅이 이걸로 게이트) → ② `loop.mjs capture <repo>`로 작업별 baseline 캡처(B3 R1 fix-delta 기준점) → ③ `execution.mjs seal --root <repo> --slug <slug>`(권위 스냅샷). 병렬이면 작업마다 독립 baseline이 필요하므로 **동시 실행=격리 worktree / 공유 worktree=write+캡처 직렬화**(B1 참조 — 비중첩 경로만으론 delta 오염). 그다음 **Codex 빌더**(codex MCP, `sandbox:"workspace-write"`, `cwd:<repo>`)에게 위임 — 프롬프트에 작업 지시 + **승인된 `plan.md`의 해당 설계 섹션**을 실어 리뷰된 설계대로 짓게 한다. 6-section 계약(요구/설계간단/구현/견고함/테스트/검증). surgical scope. **빌더는 `.harnie/`에 접근하지 않는다**(권위 상태는 오케스트레이터·CLI 소유). threadId는 PostToolUse 훅이 성공한 codex를 관찰해 등록(재수정은 codex-reply).

**B3. ★ 코드 리뷰 루프 (작업/웨이브별, 크로스-모델).** 빌더 산출 직후 delta 귀속 前 **`execution.mjs seal-verify --root <repo> --slug <slug>`**(빌더가 권위 파일을 실수로 훼손했으면 fail-closed → 그 라운드 무효·보고). 통과하면 review-loop-driver.md R1~R5:
- producer = **Codex 빌더**, **리뷰어 = read-only `harnie-reviewer` 서브에이전트**(main 인라인 아님 — 빌더가 Codex라 크로스-모델, 리뷰어는 쓰기 불가). 기준 = code-review.md + verification-tiers.md. namespace = `CR`. `<dir>` = `.harnie/plan/<slug>/review/<unit>/`(manifest의 그 작업 `reviewUnit`).
- 리뷰어는 loop.md VERDICT/ISSUES 스키마로 `round-N.txt`에 기록. `apply`엔 **이 라운드 delta의 `postSHA`를 `--artifact`로** 넘긴다(CR 필수 — execution.mjs가 이 tree에서 `reviewedScopeHash` 재계산해 검증을 리뷰 tree에 바인딩). 수정 → 델타만 재리뷰(Codex 빌더 codex-reply). 전 차원 APPROVE까지.

**B4. 작업별 검증.** `execution.mjs verify --root <repo> --slug <slug> --task <id>` — manifest의 `verification[]` argv를 shell 없이 실행해 exitCode·scopeHash·planHash receipt를 기록한다(리뷰 APPROVE 후, reviewedPostSHA 기준). 추가로 Manual QA(자동으로 못 잡는 사용자 가시 동작) + `plan.md` 재읽기로 범위 대조. 완료는 **ledger APPROVE ∧ receipt pass**로 재도출되므로(권위), 검증 실패·코드 재변경은 자동으로 미완료가 된다.

**B5. Final Wave (규모비례, 병렬) — 게이트 `Coverage·Quality·Runtime·Scope`.** 전체가 하나로 맞물리는지 최종 확인. **각 게이트를 별개 리뷰 단위로** review-loop-driver.md로 구동(namespace `CR`, `<dir>`=`review/final-<gate>/` — `coverage`·`quality`·`runtime`·`scope`):
- **Coverage** — plan.md·설계 결정·요구 ID를 실제로 **전부 충족**했나(커버 안 된 FR/NFR = under-build).
- **Quality** — 정확성·안전성·과설계(code-review.md 렌즈 전체).
- **Runtime** — 실제 실행 검증(verification-tiers.md, 통합 경계 포함). 미검증 위험 = REJECT.
- **Scope** — 요청 범위만 완결, 요청 안 한 것 안 만듦(scope inflation = over-build 차단).
- 리뷰어 = read-only **`harnie-reviewer`**(코드 단계이므로; 빌더=Codex의 반대). 각 게이트도 `apply`에 그 시점 tree의 `--artifact <postSHA>`를 넘긴다. 전부 APPROVE, **실패한 게이트만 재실행**. 기본 Claude 단독, 사용자가 "고정밀" 요청 시 dual(Codex 최종 사인오프 auxiliary 추가).

**B6. Report + 완료 재도출.** `execution.mjs completion --root <repo> --slug <slug>`으로 manifest를 순회해 완료를 재도출한다(각 task = ledger APPROVE ∧ receipt pass ∧ 현재 scope==리뷰 scope, 각 gate = ledger approved ∧ 현재 전체 tree==리뷰 tree). 요약: 변경 파일 + 작업별 tier·검증 증거 + 각 리뷰 단위 최종 verdict(ledger·round) + Final Wave 4게이트 verdict. **최종 응답 말미에 machine-readable footer를 emit한다**: 재도출이 complete면 `HARNIE_STATUS: COMPLETE`, 아니면 `HARNIE_STATUS: INCOMPLETE — <남은 blocker 요약>`. Stop 훅이 같은 재도출로 판정하므로, 권위상 미완료인데 COMPLETE라 주장하거나 footer를 빠뜨리면 종료가 차단된다. 남은 blocking·STALLED 단위·미검증 범위는 정직하게 INCOMPLETE로 보고하고 제어권을 반환한다.

---

## 불변
- **모든 수정은 반드시 리뷰된다.** 아키 설계 리뷰(A3)·상세 설계 리뷰(A4)·코드 리뷰(B3)·Final Wave(B5) 모두 동일한 review-loop-driver.md 루프 — producer·리뷰어 프로바이더·기준·고도 렌즈·namespace·`<dir>`만 다르다. **대칭 크로스-모델**: 설계는 Claude producer→Codex 리뷰, 개발은 Codex producer→Claude 리뷰(리뷰어=producer의 반대).
- ledger·verdict 정합·상태 전이는 **손으로 판정하지 말고 loop CLI로**(false approval 방지).
- 설계·계획은 durable 파일(`plan.md`·`design/rev-N.md`·`notepad.md`)로 — Claude와 Codex가 같은 소스를 읽는다. **위임에서 참조할 수 있는 것은 디스크 정본뿐**이며, tool-result blob 경로는 참조가 아니다.
- 설계 리뷰 지적은 **충족안을 쓰기 前에** "위협모델 안인가"·"이 기구가 존재해야 하는가"에 먼저 답한다. 구체적 실수 시나리오 없이 추가된 기구는 준수가 아니라 과설계다.
- **무언가를 실제로 훑는다는 증거 없이 manifest에 들어가는 검증 명령은 없다.** 아무것도 매치하지 않거나 테스트를 하나도 수집하지 않는 검사는 영원히 통과한다.
- 승인 게이트(A5) 전에 코드를 쓰지 않는다.
