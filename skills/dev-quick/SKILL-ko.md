---
name: dev-quick
description: 작은 작업(장애·국소 버그픽스·소규모 수정)을 인라인 경량으로 처리하되, 단계별 크로스-모델 리뷰(설계=Claude→Codex 리뷰, 개발=Codex→Claude 리뷰)를 건너뛰지 않는 오케스트레이터. 새 컴포넌트·경계/계약 변경·아키텍처 결정이 필요하면 풀 트랙을 권한다. `/harnie:dev-quick` 또는 라우터 `/harnie:dev`가 호출한다.
---

# quick 오케스트레이터 (class A: 장애·작은 수정)

너(main)는 인라인 경량 흐름을 실행한다. 인터뷰·승인 게이트·플랜 파일·에이전트 오케스트레이션은 **없다.** 그러나 **리뷰는 축약하지 않는다** — 상세 설계(있으면)와 코드를 각각 크로스-모델로 리뷰한다.

## 매 사용자 메시지: 의도 재분류 (실행 권한 승계 금지)
새 사용자 메시지가 오면 **이번 실행 모드를 자동 승계하지 말고** 메시지를 `replace|add|status|question`으로 다시 분류한다. **status·question·단순 add**는 진행 중 작업을 취소하지 않는다. 그러나 **범위·목표가 바뀌면**(replace, 또는 범위를 바꾸는 add) 현재 실행을 멈추고 대상·리뷰 범위를 재계산한 뒤 이어간다. (실행 권한 리셋이 아니라 **메시지 의도·범위 리셋**.)

## Step 0 — 런타임 계약 주입 (필수, 먼저)
아래 canonical 파일을 **지금 Read** 한다(경로 참조만으론 부족 — 실제 내용을 이 세션에 올린다). 이 파일들이 리뷰 스키마·상태전이·검증 tier·리뷰 기준·루프 구동의 단일 소스다. 여기 스킬은 이를 **재서술하지 않고** 조율만 한다.
- `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md` — 리뷰 루프 상태머신 + 출력 스키마 + ledger 규칙
- `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md` — 루프 CLI·codex 배선(R1~R5)
- `${CLAUDE_PLUGIN_ROOT}/instructions/code-review.md` — 코드 리뷰 기준(REJECT 편향, in-loop)
- `${CLAUDE_PLUGIN_ROOT}/instructions/verification-tiers.md` — 검증 tier
- (Step 3 설계가 있을 때만) `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md` — 상세 작성 프로필(경량) + `${CLAUDE_PLUGIN_ROOT}/instructions/design-review.md` — 상세 고도 렌즈

> **대칭 크로스-모델**(각 단계 반대 프로바이더가 리뷰): **설계** = Claude(`harnie-designer`) 산출 → **Codex** 리뷰 / **개발** = **Codex** 빌더(codex MCP, `workspace-write`) 산출 → **Claude** 리뷰. codex MCP 툴명은 설치 형태에 따라 `mcp__plugin_harnie_codex__codex`(플러그인)/`mcp__codex__codex`(로컬), 재빌드·재리뷰는 `*__codex-reply`(threadId, stateful). 자세한 배선은 review-loop-driver.md.

## 상태 위치
`.harnie/quick/<slug>/` — 작업 루트. **중간 산출물**(설계 = `review/design/design.md`)과 리뷰 루프 상태는 `review/<name>/`(`design`·`code`) 아래 각각 `design.md`(설계 단계)·`delta.patch`·`round-N.txt`(리뷰어 원문 receipt)·`ledger.json`·`state.json`. slug = 작업의 짧은 kebab. (plan의 `.harnie/plan/<slug>/review/<name>/`와 대칭 — 단일 스킴.) 다음 단계(개발·리뷰)는 이 산출물을 읽는다.

## 흐름

### 1. Intent & size
작업을 한 줄로 재진술한다. **진짜 작은가**(새 컴포넌트·경계/계약 변경·아키텍처 결정 없음) 확인. 크면 멈추고 `/harnie:dev-full`을 권한다.

### 2. Read (필요시)
낯선 코드면 `harnie-scout`(haiku)를 병렬 스폰해 관련 위치를 잡는다. 자명하면 skip.

### 3. (옵션) 상세 설계(경량) + 설계 리뷰
비자명하면 **상세 설계를 경량 모드로** 산출한다(producer = **Claude** `harnie-designer`). 작성 계약 = `design-authoring-detail.md` 경량(Step 0에서 읽음) — 작으면 main 직접, 비자명하면 `harnie-designer` 위임(이때 **그 프로필 내용을 위임 프롬프트에 인라인**하고 "상세 설계, 경량"을 신호; 서브에이전트는 자기 컨텍스트라 프로필이 자동 로드되지 않는다). quick은 구조상 **상세(DETAIL) 고도만** — 새 컴포넌트·경계 변경·아키텍처 결정이 필요하면 애초에 `/harnie:dev-full`이다(Step 1에서 걸러짐). "정식으로"를 붙이지 않는다(경량 기본, 깊이 차등으로 작은 작업엔 몇 줄로 수렴).
**산출한 설계를 `.harnie/quick/<slug>/review/design/design.md`에 저장**한다(Step 4 개발·리뷰가 읽는 단일 소스). 그다음 → **설계 리뷰 루프**(리뷰어 = **Codex**, design-review.md 기준, 상세 고도, ID namespace `DR`, `<dir>` = `.harnie/quick/<slug>/review/design/`)를 review-loop-driver.md대로 APPROVE까지 돌린 뒤 코드로 넘어간다. **설계 루프는 R1 git-delta를 쓰지 않는다**(`design.md`는 `.harnie/` 제외 대상 → delta 항상 빈값). 대신 `design.md` 내용을 리뷰어 prompt에 직접 싣고(첫 리뷰=전체, 재리뷰=수정된 설계) R2~R5만 구동한다. 자명하면 Step 3 전체 skip.

### 4. Write (개발 producer = **Codex**)
`.harnie/`를 제외한 baseline을 먼저 캡처한다:
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/loop.mjs capture <repo>   # → baselineSHA 기록
```
그 다음 **Codex 빌더**(codex MCP, `sandbox:"workspace-write"`, `approval-policy:"never"`, `cwd:<repo>`)에게 구현을 위임한다 — 프롬프트에 작업 의도·제약 + (Step 3가 있었으면) **`review/design/design.md` 내용**을 실어 리뷰된 설계대로 짓게 한다. **surgical**(기존 스타일 유지, 요청 범위만). threadId 기록(재수정은 codex-reply). 코드 리뷰어는 Claude이므로 빌더는 반드시 Codex(크로스-모델).

### 5. Verify (self)
verification-tiers.md로 변경의 **실제 위험**에 맞는 tier를 정하고 그 필수 세트를 실행한다. "컴파일 통과"는 검증이 아니다. 미검증 위험은 정직하게 명시.

### 6. 코드 리뷰 루프 (review-loop-driver.md, ID namespace `CR`, `<dir>` = `.harnie/quick/<slug>/review/code/`)
review-loop-driver.md의 R1~R5를 구동한다. producer = **Codex 빌더**, **리뷰어 = read-only `harnie-reviewer` 서브에이전트**(main 인라인 아님 — 빌더가 Codex라 크로스-모델, 리뷰어는 쓰기 불가). Task로 위임해 code-review.md·verification-tiers.md·fix delta·이전 ledger를 프롬프트에 싣고, loop.md VERDICT/ISSUES 스키마 응답을 `round-N.txt`에 기록한다. `apply`엔 **이 라운드 delta의 `postSHA`를 `--artifact`로** 넘긴다(CR 필수). 수정은 Codex 빌더가 codex-reply로. trivial이라도 **축약 없이** 단계별 리뷰하되 1~2차원(correctness + side-effect)에 집중한다.

### 7. Report
변경 요약 + 선택 tier·통과한 검증 세트 + 리뷰 verdict(최종 ledger·round 수). open blocking 0이 아니면 "done"이라 하지 않는다. STALLED면 남은 blocker·미검증 범위와 함께 사용자에게 보고.

> **완료 상태 footer(필수).** 최종 응답 말미에 machine-readable 한 줄을 emit한다: 코드 리뷰가 전부 APPROVE(open blocking 0)면 `HARNIE_STATUS: COMPLETE`, 아니면 `HARNIE_STATUS: INCOMPLETE — <남은 blocker 요약>`. (quick 트랙은 execution.json·강제 훅이 없지만 이 footer 규약은 정직 보고의 단일 형식으로 공유한다.)

> 설계 리뷰(Step 3)와 코드 리뷰(Step 6)는 **동일한 review-loop-driver.md 루프**를 쓴다. 차이는 producer(Claude designer↔Codex builder)·리뷰어(Codex↔Claude)·기준 파일(design-review↔code-review)·namespace(`DR`↔`CR`)·상태 하위 디렉터리뿐이다.
