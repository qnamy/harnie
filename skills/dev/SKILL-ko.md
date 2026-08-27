---
name: dev
description: harnie의 단일 개발 파이프라인 — 요구사항 그라운딩 → 승인 → 설계 → 빌드 → 크로스-모델 리뷰 → 검증, 규모(S/M)에 따라 단계를 생략한다. M보다 큰 작업은 사람 + orca 프로세스로 인계한다. `/harnie:dev`로 호출된다.
---

# dev 오케스트레이터 — 단일 파이프라인, 규모 게이트 단계

당신(메인)이 하나의 run을 처음부터 끝까지 오케스트레이션한다. **리뷰 계약은 여기서 정의하지 않는다**: 이 파이프라인은 `${CLAUDE_PLUGIN_ROOT}/skills/cross-review/SKILL.md`의 두 사용처 중 하나다 — **지금 Read하고(Step 0)** 따른다(그 스킬이 `loop.md`, `review-schema.md`, `review-loop-driver.md`, 기준 문서, `model-matrix.md`를 참조로 가리킨다). 이 파일은 아래 run 특화 배선만 추가한다. 이 파이프라인에서 그 스킬이 강제하는 프로듀서/리뷰어 짝은 다음으로 귀결된다: **설계 = Claude 생산 → Codex 리뷰; 코드 = Codex 생산 → Claude 리뷰**(예외는 dev-solo 하나뿐 — `dev-solo/SKILL.md` 참고). 부트스트랩 훅이 이미 이 run을 생성했다(workroot는 훅의 컨텍스트 메시지에 있다; `<main repo>/.harnie/sessions/<session>.json`으로 복구); `.harnie/active.json`이 존재하는지 확인한다 — 없으면 STOP하고 보고한다(절대 자체 초기화하지 않는다).

## 규모(S/M) — 잠정 → 확정, 상향 전용; M 위로는 출구 없음

진입 커맨드가 잠정 규모를 판정했다; **그것 없이 진입했다면**(스킬 직접 호출) 지금 `commands/dev.md`의 두 판정(잠정 규모 + run 난이도)을 수행한다. 그라운딩 후 `node <ROOT>/scripts/execution.mjs set-mode --root <repo> --slug <slug> --mode <S|M>`로 **규모를 확정한다**(상향 전환만 가능; `sizing`은 소스 쓰기를 보수적으로 차단한다). run은 **단일 git 트리**를 전제하며, 아니면 completion이 fail-close한다.

**M보다 위로는 harnie 안에 상향 출구가 없다.** L 트리거가 나타나면 — ARCH 트리거(신규 컴포넌트/경계/데이터 소유권/기술 선택/SPOF 결정), 또는 독립적 리뷰 가치를 지닌 태스크 2개 이상 — **멈추고 그 작업을 사람 + orca 프로세스로 인계한다**(분해·디스패치·통합은 그쪽 몫이지 harnie의 몫이 아니다). 무엇을 발견했는지, 분해가 어떤 모습인지, 현재 트리 상태를 보고한다; 모드를 에스컬레이션하지 않는다(`set-mode --mode L`은 엔진이 거부한다). S 진행 중 **M**으로의 에스컬레이션은 그대로다: 즉시 에스컬레이션하고 생략했던 단계를 실행한다; 프리-빌더 베이스라인 이후의 기존 에이전트 변경은 델타로 캡처되어 승인에 선행 작업으로 첨부되고 승인 시 첫 리뷰 유닛에 포함된다; 당신 소유가 아닌 dirty 트리는 사용자에게 넘기며, 절대 자동 revert하지 않는다.

- **S** — 국소 수정: 그라운딩 → 베이스라인 캡처 → 빌드 → 티어 검증 → 코드 리뷰 루프 → 보고. 승인 게이트 없음, 매니페스트 없음.
- **M** — 설계 판단이 있는 리뷰 유닛 하나: 그라운딩 → 경량 플랜(접근법 + 단일 태스크 매니페스트 `t1`/`code`, 스코프 테스트, `integrationVerification`, `gates: []`, 사람 검증 항목) → **승인** → TASK-DETAIL 설계 + 설계 리뷰 → `set-task --task t1 --run-status building`(빌더 스레드 바인딩 + 워치독 활성화) → 베이스라인/seal → 빌드 → 코드 리뷰 루프 → `verify --task t1` → `verify --integration` → 보고.
- **난이도 재판정**: 두 체크포인트(그라운딩 직후; M은 승인 게이트 직전, S는 빌드 호출 직전)가 상향(자동+한 줄 통보) 또는 하향(`AskUserQuestion` 필요)을 결정한다; `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>`로 기록한다 — M은 arming 전에 `plan.md`에도 동기화한다(`model-matrix.md` §2 참고).

## MUST

- **질문 전 그라운딩**: 낯선 것은 무엇이든 `harnie-scout`(T1; 탐색에 의미적/구조적 판단이 필요하면 T2 — `model-matrix.md` §3)를 병렬로 스폰한다; 가정이 아니라 파일에서 결정한다. 증거로 해결할 수 없는 것만 사용자에게 묻는다(제품 의도, 실질적으로 다른 해석, 틀리면 비싼 추측, 외부 컨텍스트) — 라운드당 질문 ≤3개, 각각 증거·선택지·영향·권장 기본값을 붙인다; 채택된 기본값은 플랜에 가정으로 기록한다.
- **모든 수정은 `cross-review` 스킬을 통해 리뷰된다** — 발견 수용과 컨테스트 게이트를 포함해서다. Run 특화 배선: 다음 프로듀서 호출 전에 라운드 N을 apply(`committed: true`)하고, 어떤 run 스테이지도 자체 리뷰 경로로 대체하지 않는다.
- **위임은 기록 디스크 경로로만** — 기준/프로파일/설계는 위임 대상이 Read하는 경로다; 그 내용을 인라인하지 않고, 툴-결과 blob 경로를 전달하지 않는다. 예외: 빌더는 설계 **내용**을 인라인으로 받고(`.harnie` 경로는 절대 금지) `builder-contract.md` 경로를 함께 받는다.
- **검증 분리**: 사람 확인 항목은 플랜에 미리 나열하고 체크리스트로 인계한다(`verification-tiers.md`); 자동화 증거는 `verify` 영수증을 거친다. 유닛 단계 테스트는 **스코프 테스트만**; 전체 스위트는 `verify --integration`으로 실행한다(M) — 최종 트리에 바인딩된 통과 영수증 정확히 1개; 변경 없는 재실행은 엔진이 거부한다.
- **컨텍스트 예산**: 리뷰 유닛 ~3–4개 완료 후 세션 분할을 제안한다(기계적 백스톱: `sessionSplitRecommended`); 결정에 필요한 섹션만 주입한다; 독립 툴 호출은 배치한다; 사용자 게이트에서 블로킹하기 전에 알린다(예: `PushNotification`). `notepad.md`는 append-only, 단일 작성자(당신), 재사용 가능한 지식만.
- **정직한 완료**: 최종 응답을 `HARNIE_STATUS: COMPLETE` 또는 `INCOMPLETE — <blockers>`로 끝낸다; 완료 권한은 `execution.mjs completion`이다(S: 유닛 APPROVED + 트리 바인딩; M: 전체 도출). 체크리스트가 미확인이면 `needs-human-verification: N`을 명시한다.
- 새 사용자 메시지가 오면 의도를 재분류한다(`replace|add|status|question`); 스코프/목표 변경만이 재계산·재승인을 위해 실행을 멈춘다.

## NEVER

- 승인 전에 소스를 쓰지 않는다(M; `sizing` 포함) — H1이 이를 강제한다; 훅과 함께 일하라.
- 유닛 단계에서 전체 테스트 스위트를 실행하거나, 변경 없는 검증을 재실행하지 않는다.
- 원장을 수작업으로 병합하거나, ID를 닫거나, 판정을 선언하지 않는다; 자기 승인 금지; 사용자에게 표면화된 `--reentry` 없이 STALLED를 해제하지 않는다.
- 리뷰어가 프로듀서와 프로바이더를 공유하게 하거나(dev-solo는 예외 — `dev-solo/SKILL.md` 참고), 어떤 리뷰어든 쓰기를 하게 두지 않는다.
- 문서가 정의하지 않은 스케줄러, 의존성 엔진, 백오프 재시도, 실행 인프라를 만들지 않는다 — 가드가 예상 밖으로 거부하면 STOP하고 보고하며, 절대 우회하지 않는다.
- 승인된 CLI 외에 `.harnie`를 참조하는 Bash를 실행하지 않는다; 컨트롤 파일을 수작업 편집하지 않는다.

## 승인 게이트 (M)

`plan.md`가 ` ```harnie-manifest ` 블록을 담는다. arm 전에 모든 `verification[]`/`integrationVerification[]` 항목이 실제로 무언가를 실행함을 증명한다(읽기 전용 증명 또는 입력 열거; 타임아웃은 **밀리초**로 명시해 적는다; 무음 성공 도구는 `evidencePolicy: "exit-code-only"`를 선언한다; 콜드 스타트는 `setup`에 넣는다). 그런 다음 `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "<label>"` 후 **즉시** AskUserQuestion으로 묻되, 그 승인 옵션의 **선택 값이 arm된 라벨과 정확히 일치**해야 한다(플래그 생략 시 기본값 `승인` — arm된 라벨과 질문 옵션은 글자 그대로 일치해야 한다; 원샷 바인딩: arm 후 첫 질문; run 전체에 arm/pending 1개). 승인 후 매니페스트 변경은 재승인 경로로만 한다(A5.2 상당: 블록 수정, 재-arm, 재질문).

## S/M 흐름 노트

- 프리-빌더 베이스라인을 **항상** 캡처한다(`loop.mjs capture <repo> --record …`) — 델타와 모든 에스컬레이션의 기준점이다.
- **모든 run-루트 프로듀서 윈도를 seal로 감싼다**: 각 빌더 호출 직전(`set-task`/베이스라인 후)에 `execution.mjs seal`, 그 출력 직후·델타 귀속 전에 `seal-verify` — exit 3 = 빌더가 권한 파일을 건드렸다는 뜻, 그 라운드를 무효화한다. `seal`은 멱등이다(변경 없는 권한 상태에 재실행하면 no-op이며, 베이스라인이 이동한 미검증 seal 위에는 재-seal을 거부한다 — 먼저 `seal-verify`를 실행한다). 불일치 후에는 권한 파일을 복원하고 재-seal한다(기록된 베이스라인으로 되돌아가는 no-op); 변경된 상태를 새 베이스라인으로 수용하려면 의도적으로 프롬프트를 띄우는 `seal --after-mismatch`가 필요하다.
- 빌더 위임과 stalled-dispatch/fail-fast 규칙: `review-loop-driver.md`. S의 암묵 태스크는 `t1`이다(set-mode가 등록한다; 빌더 cwd = workroot).
- M의 설계 단계: 프로듀서 = `harnie-designer`(또는 작은 작업은 당신이 인라인)가 `.harnie/plan/<slug>/review/design/design.md`에 작성; 리뷰 자체는 `cross-review` 스킬의 DR 루프다. Run 특화 배선: 승인 후 `dr:` 아티팩트는 design content ‖ planHash ‖ `m-plan`을 해시한다(드라이버 R4). 승인된 설계에서 승인 후 결함이 발견되면 경로는 하나다: A5.2 재승인(블록 수정, 재-arm, 재질문) — 이것이 `planHash`를 바꾸고 그로써 낡은 설계 승인을 무효화한다.
- 코드 리뷰: `cross-review` 스킬의 CR 루프이며, 리뷰 유닛 디렉터리 `.harnie/plan/<slug>/review/<unit>/`를 상태 위치로 쓴다. S는 정확성과 부작용에 집중한다 — 그래도 절대 생략하지 않는다.
