---
name: dev
description: harnie의 단일 개발 파이프라인(0.11) — 요구사항 그라운딩 → (ARCH → 리뷰) → (태스크 분할 + CONTRACT → 리뷰) → 승인 → 빌드 → 크로스-모델 리뷰 → 검증, 규모(S/M/L)에 따라 단계를 생략한다. dev-quick/dev-full을 대체. `/harnie:dev`로 호출된다.
---

# dev 오케스트레이터 — 단일 파이프라인, 규모 게이트 단계

당신(메인)이 하나의 run을 처음부터 끝까지 오케스트레이션한다. 이 `harnie:dev` 파이프라인에서 역할은 고정이다: **설계 = Claude 생산 → Codex 리뷰; 코드 = Codex 생산 → Claude 리뷰** — 모든 수정은 반대 프로바이더가 리뷰한다(예외는 dev-solo 하나뿐이다: 프로듀서와 리뷰어가 둘 다 Codex이며, fresh 셀프리뷰 서브프로세스로 대체한다 — `dev-solo/SKILL.md` 참고). 배선은 `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md`에 있다 — **지금 Read한다(Step 0)**; 모델은 `instructions/model-matrix.md`에서 온다. 부트스트랩 훅이 이미 이 run을 생성했다(workroot는 훅의 컨텍스트 메시지에 있다; `<main repo>/.harnie/sessions/<session>.json`으로 복구); `.harnie/active.json`이 존재하는지 확인한다 — 없으면 STOP하고 보고한다(절대 자체 초기화하지 않는다).

## 규모(S/M/L) — 잠정 → 확정, 상향 전용

진입 커맨드가 잠정 규모를 판정했다; **그것 없이 진입했다면**(스킬 직접 호출, deprecated 별칭) 지금 `commands/dev.md`의 두 판정(잠정 규모 + run 난이도)을 수행한다. 그라운딩 후 `node <ROOT>/scripts/execution.mjs set-mode --root <repo> --slug <slug> --mode <S|M|L>`로 **규모를 확정한다**(상향 전환만 가능; `sizing`은 소스 쓰기를 보수적으로 차단한다). **워크스페이스 run(멀티레포)은 항상 L이다** — S/M은 단일 git 트리를 전제하며, 아니면 completion이 fail-close한다. 이후 발견으로 더 큰 규모가 드러나면(예: S 진행 중 ARCH 트리거), **즉시 에스컬레이션하고 생략했던 단계를 실행한다**; 프리-빌더 베이스라인 이후의 기존 에이전트 변경은 델타로 캡처되어 승인에 선행 작업으로 첨부된다 — 승인 시 첫 리뷰 유닛에 포함되거나(M), 패치로 보존 후 재구현된다(L, 단 한 태스크의 스코프에 완전히 들어가는 경우 제외); 당신 소유가 아닌 dirty 트리는 사용자에게 넘기며, 절대 자동 revert하지 않는다.

- **S** — 국소 수정: 그라운딩 → 베이스라인 캡처 → 빌드 → 티어 검증 → 코드 리뷰 루프 → 보고. 승인 게이트 없음, 매니페스트 없음.
- **M** — 설계 판단이 있는 리뷰 유닛 하나: 그라운딩 → 경량 플랜(접근법 + 단일 태스크 매니페스트 `t1`/`code`, 스코프 테스트, `integrationVerification`, `gates: []`, 사람 검증 항목) → **승인** → TASK-DETAIL 설계 + 설계 리뷰 → `set-task --task t1 --run-status building`(빌더 스레드 바인딩 + 워치독 활성화) → 베이스라인/seal → 빌드 → 코드 리뷰 루프 → `verify --task t1` → `verify --integration` → 보고.
- **L** — 확정되면 `stages/large.md`를 읽는다.
- **난이도 재판정**: 두 체크포인트(그라운딩 직후; M/L은 승인 게이트 직전, S는 빌드 호출 직전)가 상향(자동+한 줄 통보) 또는 하향(`AskUserQuestion` 필요)을 결정한다; `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>`로 기록한다 — M/L은 arming 전에 `plan.md`에도 동기화한다(`model-matrix.md` §2 참고).

## MUST

- **질문 전 그라운딩**: 낯선 것은 무엇이든 `harnie-scout`(haiku)를 병렬로 스폰한다; 가정이 아니라 파일에서 결정한다. 증거로 해결할 수 없는 것만 사용자에게 묻는다(제품 의도, 실질적으로 다른 해석, 틀리면 비싼 추측, 외부 컨텍스트) — 라운드당 질문 ≤3개, 각각 증거·선택지·영향·권장 기본값을 붙인다; 채택된 기본값은 플랜에 가정으로 기록한다.
- **모든 수정은 리뷰된다**; 원장/상태는 오직 `loop.mjs apply`로만 이동한다(`review-loop-driver.md` R1–R5). 다음 프로듀서 호출 전에 라운드 N을 apply(`committed: true`)한다.
- **위임은 기록 디스크 경로로만** — 기준/프로파일/설계는 위임 대상이 Read하는 경로다; 그 내용을 인라인하지 않고, 툴-결과 blob 경로를 전달하지 않는다. 예외: 빌더는 브리프/설계 **내용**을 인라인으로 받고(`.harnie` 경로는 절대 금지) `builder-contract.md` 경로를 함께 받는다.
- **과잉 순응 대신 컨테스트**(`loop.md` 컨테스트 게이트): 고도를 벗어났거나 메커니즘 정당화가 없는 blocking 파인딩에는 CONTEST를 건다 — 리뷰어의 다음 응답 또는 즉시 사용자 에스컬레이션으로 결착한다. 정확성/안전성 파인딩은 절대 컨테스트하지 않는다.
- **검증 분리**: 사람 확인 항목은 플랜에 미리 나열하고 체크리스트로 인계한다(`verification-tiers.md`); 자동화 증거는 `verify` 영수증을 거친다. 유닛 단계 테스트는 **스코프 테스트만**; 전체 스위트는 `verify --integration`으로 실행한다(M/L) — 최종 트리에 바인딩된 통과 영수증 정확히 1개; 변경 없는 재실행은 엔진이 거부한다.
- **컨텍스트 예산**: 리뷰 유닛 ~3–4개 완료 후 세션 분할을 제안한다(기계적 백스톱: `sessionSplitRecommended`); 결정에 필요한 섹션만 주입한다; 독립 툴 호출은 배치한다; 사용자 게이트에서 블로킹하기 전에 알린다(예: `PushNotification`). `notepad.md`는 append-only, 단일 작성자(당신), 재사용 가능한 지식만.
- **정직한 완료**: 최종 응답을 `HARNIE_STATUS: COMPLETE` 또는 `INCOMPLETE — <blockers>`로 끝낸다; 완료 권한은 `execution.mjs completion`이다(S: 유닛 APPROVED + 트리 바인딩; M/L: 전체 도출). 체크리스트가 미확인이면 `needs-human-verification: N`을 명시한다.
- 새 사용자 메시지가 오면 의도를 재분류한다(`replace|add|status|question`); 스코프/목표 변경만이 재계산·재승인을 위해 실행을 멈춘다.

## NEVER

- 승인 전에 소스를 쓰지 않는다(M/L; `sizing` 포함) — H1이 이를 강제한다; 훅과 함께 일하라.
- 유닛 단계에서 전체 테스트 스위트를 실행하거나, 변경 없는 검증을 재실행하지 않는다.
- 원장을 수작업으로 병합하거나, ID를 닫거나, 판정을 선언하지 않는다; 자기 승인 금지; 사용자에게 표면화된 `--reentry` 없이 STALLED를 해제하지 않는다.
- 구체적 실수 시나리오 없이 메커니즘을 추가하는 리뷰 파인딩이나 현재 고도 밖의 파인딩을 수용하지 않는다 — 컨테스트한다.
- 리뷰어가 프로듀서와 프로바이더를 공유하게 하거나(dev-solo는 예외 — `dev-solo/SKILL.md` 참고), 어떤 리뷰어든 쓰기를 하게 두지 않는다.
- 문서가 정의하지 않은 스케줄러, 의존성 엔진, 백오프 재시도, 실행 인프라를 만들지 않는다 — 가드가 예상 밖으로 거부하면 STOP하고 보고하며, 절대 우회하지 않는다.
- 승인된 CLI 외에 `.harnie`를 참조하는 Bash를 실행하지 않는다; 컨트롤 파일을 수작업 편집하지 않는다.

## 승인 게이트 (M/L)

`plan.md`가 ` ```harnie-manifest ` 블록을 담는다. arm 전에 모든 `verification[]`/`integrationVerification[]` 항목이 실제로 무언가를 실행함을 증명한다(읽기 전용 증명 또는 입력 열거; 타임아웃은 **밀리초**로 명시해 적는다; 무음 성공 도구는 `evidencePolicy: "exit-code-only"`를 선언한다; 콜드 스타트는 `setup`에 넣는다). 그런 다음 `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "<label>"` 후 **즉시** AskUserQuestion으로 묻되, 그 승인 옵션의 **선택 값이 arm된 라벨과 정확히 일치**해야 한다(플래그 생략 시 기본값 `승인` — arm된 라벨과 질문 옵션은 글자 그대로 일치해야 한다; 원샷 바인딩: arm 후 첫 질문; run 전체에 arm/pending 1개). 승인 후 매니페스트 변경은 재승인 경로로만 한다(A5.2 상당: 블록 수정, 재-arm, 재질문).

## S/M 흐름 노트

- 프리-빌더 베이스라인을 **항상** 캡처한다(`loop.mjs capture <repo> --record …`) — 델타와 모든 에스컬레이션의 기준점이다.
- **모든 run-루트 프로듀서 윈도를 seal로 감싼다**: 각 빌더 호출 직전(`set-task`/베이스라인 후)에 `execution.mjs seal`, 그 출력 직후·델타 귀속 전에 `seal-verify` — exit 3 = 빌더가 권한 파일을 건드렸다는 뜻, 그 라운드를 무효화한다.
- 빌더 위임과 stalled-dispatch/fail-fast 규칙: `review-loop-driver.md`. S의 암묵 태스크는 `t1`이다(set-mode가 등록한다; 빌더 cwd = workroot).
- M의 설계 단계: 프로듀서 = `harnie-designer`(또는 작은 작업은 당신이 인라인)가 `.harnie/plan/<slug>/review/design/design.md`에 작성; 설계 리뷰는 DR 루프로(승인 후 `dr:` 해시 입력: design content ‖ planHash ‖ `m-plan` ‖ errata 커서 — 드라이버 R4 참조).
- 코드 리뷰: 리뷰어 = `harnie-reviewer`(유닛 티어), 입력은 경로로(델타, 이전 원장, 설계 + 섹션명). S는 정확성과 부작용에 집중한다 — 그래도 절대 생략하지 않는다.
