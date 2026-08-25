# harnie 0.11 — 상세설계 (rev-6)

> 부모 아키텍처: `design-0.11-process.md` rev-5(승인·Codex APPROVE). 이 문서는 §11 인계 항목을 구현 착수 가능한 수준으로 확정한다. 부모의 결정(단일 파이프라인, 3층 고도, hard rule 2종, contest 게이트, dev-solo)은 변경하지 않는다 — 변경이 필요하면 Architecture Change Request로 분리한다.
> 구현 언어 정책: 실행 정본은 영문 `*.md`, 한국어 `-ko` 미러 동시 갱신(기존 정책). 이 설계의 문안 예시는 한국어로 쓰되 구현 시 영문 정본으로 작성한다.

## 1. 파일 인벤토리 — 생성 / 재작성 / 은퇴

| 구분 | 파일 | 내용 |
|---|---|---|
| 재작성 | `commands/dev.md` | 유일 진입점. 잠정 S/M/L·난이도 판정 + 파이프라인 스킬 즉시 진입. 워크스페이스 진입 규칙은 스킬로 이동 |
| 신설 | `skills/dev/SKILL.md` | 파이프라인 오케스트레이터 — 공통 계약(상태 위치·위임 규칙·컨텍스트 예산·이의 게이트·크기 판정·완료 보고)과 S/M 인라인 플로우 |
| 신설 | `skills/dev/stages/large.md` | L 전용 스테이지 절차 |
| alias | `skills/dev-quick/SKILL.md`, `skills/dev-full/SKILL.md`(+phase 파일) | 본문 삭제 → "0.11에서 `harnie:dev`로 통합 — 그 스킬을 즉시 로드해 수행하라 + deprecated 1줄"(U-1: 1버전 유지) |
| 재작성 | `agents/harnie-task-runner.md` | §5 러너 프로토콜(개정 재개표 포함) |
| 재작성 | `agents/harnie-designer.md`, `harnie-reviewer.md`, `harnie-builder.md`, `harnie-scout.md` | 역할·MUST·NEVER·산출물 4절 구조로 압축. 계약 내용은 보존 |
| 재작성 | `instructions/loop.md` | 이의(contest) 게이트 절 추가(§7), ledger ID 유닛 스코프 1줄, 계약 보존·압축 |
| 재작성 | `instructions/review-loop-driver.md` | R1–R5 유지, seal 인터리빙 경고 1줄, 빌더 계약을 `builder-contract.md` 경로 참조로 |
| 개정 | `instructions/design-review.md` | 고도 3층(ARCH/CONTRACT/TASK-DETAIL) 렌즈, 이의 응답 규칙. 요구 커버리지 기준 한 줄 유지 |
| 신설 | `instructions/design-authoring-contract.md` | CONTRACT 프로파일(§4) |
| 개정 | `instructions/design-authoring-arch.md`, `design-authoring-detail.md` | 추적성 매트릭스·강제 ID 필수 해제, Env Fact Sheet에 드라이버/세션 시맨틱스 카테고리 추가, detail은 TASK-DETAIL 경량 계약 중심 압축 |
| 신설 | `instructions/builder-contract.md` | 빌더 표준 규칙 단일 파일(6절 보고·baseline·fail-capability·캐시 경로·응답 ≤50줄·스코프 테스트 한정) |
| 개정 | `instructions/model-matrix.md` | 스테이지 이름 매핑 갱신(ARCH=fable, CONTRACT=구 A4 티어, TASK-DETAIL 설계리뷰=`gpt-5.6-sol`, 코드리뷰·확인·Final 불변), 트랙 문구를 S/M/L로 |
| 유지 | `instructions/review-schema.md` | 무변경 |
| 개정 | `instructions/verification-tiers.md` | "사람검증 체크리스트 인계" 1줄 추가만 |
| 신설 | `skills/dev-solo/SKILL.md` | Codex 단독 파이프라인(§9) |
| 개정 | `scripts/execution.mjs`, `scripts/loop.mjs`(delta만), `hooks/*` | §6 변경 목록 — **이 목록이 스크립트 변경의 전부이며, 구현 중 목록 밖 수정이 필요해지면 이 문서를 개정하고 재리뷰한다** |
| 개정 | `.claude-plugin/plugin.json`, `README.md`, `CLAUDE.md`/`AGENTS.md`, `docs/architecture.md` | 컴포넌트 목록·버전 0.11.0·개요 현행화 |

NFR-3 측정: 오케스트레이터가 한 런에서 로드하는 스킬 문서 합(`commands/dev.md`+`skills/dev/SKILL.md`+`stages/large.md`)을 `wc -l` 기준 **≤210줄**로 상한(현행 dev 계열 ≈420줄의 50%). 릴리스 게이트에서 기계 확인(§10).

## 2. 상태·부트스트랩 — track/경로는 `plan` 재사용 (DR-101 처분)

**상태 루트와 track 값은 0.10의 `plan`을 그대로 쓴다**: `.harnie/plan/<slug>/`, sentinel `track:"plan"`. 디렉터리·track 개명은 미관 변경일 뿐 `execution.mjs`·guards·훅 전반의 `plan` 하드코딩을 건드리는 대규모 churn을 유발하므로 **비목표**(부모 §2 "새 상태 스킴 발명 금지"). quick 트랙 경로(`.harnie/quick/`)는 신규 런에서 사용하지 않음 — S 런도 plan 스킴으로 통일(아래). 과거 런 판독은 무영향(경로 불변이므로 자연 보존).

- **sentinel/execution.json 신규 필드 `mode`**: 부트스트랩이 `"sizing"`으로 초기화. `execution.mjs set-mode --root <repo> --slug <slug> --mode <S|M|L>` 1회 이상 호출 가능하되 **상향만**(sizing→S|M|L, S→M|L, M→L; 하향·동급 재설정은 exit 2). sentinel과 execution.json의 mode 불일치는 모든 서브커맨드에서 fail-closed.
- **모드별 게이트**: `sizing`·`M`·`L` = 0.10 plan과 동일(H1 승인 전 소스 쓰기 차단 활성 — 잠정 S 동안도 차단, 보수 기본값). `S` = H1의 승인 전 쓰기 차단만 면제(승인 게이트 자체가 없으므로), **그 외 훅 전부 활성**(builder 바인딩, seal, Stop 정직 보고, `.harnie` 가드).
- **S의 실행·완료 권위(DR-103·114)**: `set-mode S`가 **단일 암묵 태스크 `t1`(reviewUnit `code`)을 execution.json에 등록하고 `building` 상태로 둔다** — 빌더 threadId 자동 귀속·워치독·seal이 기존 태스크 매핑 그대로 동작한다(§6-a). 플로우 순서는 **빌드 → tier 검증(수행·증거 확보) → 코드리뷰**로 고정: 검증 증거가 리뷰어 입력이 되고, 리뷰어의 검증 적정성 게이트(기존 `code-review.md`)가 그것을 판정하므로 **리뷰 APPROVE가 검증 보고를 보증**한다. Stop 훅의 S 판정 = ① `review/code/` state `APPROVED` ② `reviewedPostSHA` = 현재 트리 SHA ③ HARNIE_STATUS 푸터 존재 — 이 산식은 `completion`이 mode-aware로 구현하고 Stop 훅은 그것을 호출한다(한 곳 구현, dev-solo도 동일 CLI 사용 — §6-a). 회귀 테스트: 리뷰 후 트리 변경 → 차단, 유닛 부재/REVISING → 차단, 검증 증거 없는 리뷰 REJECT 경로.
- **M의 승인 산출물·순서(DR-104 — 부모 파이프라인 순서 준수)**: 승인 **전** 산출물 `plan.md` = **경량 계획**(접근 방향 요약 + 단일 태스크 manifest: id `t1`, reviewUnit `code`, scope, verification = 스코프 테스트, `integrationVerification`(§6-b, M 필수), `gates: []` + 검증 전략 자동/사람 2열). TASK-DETAIL 설계·설계리뷰는 부모 §5대로 **승인 후 구현 단위 안에서** 수행(설계 destination `.harnie/plan/<slug>/review/design/design.md`, 리뷰는 DR 루프 — 구 quick Step 3 배선 계승). 승인·planHash·A5.2는 0.10 그대로. M 완료 = `completion`(태스크 ledger+receipt+scope+통합 receipt).
- **승격 전이**: 부모 §5 그대로. S는 빌더 첫 호출 전 `loop.mjs capture --record`가 필수(현행 quick과 동일)이므로 승격 delta의 기준점이 항상 존재한다.
- **워크스페이스 런**: 0.10 규칙 무변경, L 전용 — `stages/large.md`에만 기술.

## 3. 파이프라인 스킬 계약

`skills/dev/SKILL.md` — 4절 구조:

1. **역할·목표** 1문단 + 크기 판정 표(S/M/L 정의·잠정→확정·승격 — 부모 §5) + `set-mode` 호출 시점.
2. **MUST**: cross-model 대칭 / 모든 수정은 리뷰 / ledger·상태는 CLI로만 / 위임은 디스크 아티팩트 경로만·tool-result blob 금지 / 컨텍스트 예산 3규칙 / 질문 규칙(증거 우선, 라운드당 ≤3) / 사람검증 체크리스트 분리 인계 / HARNIE_STATUS 푸터 / notepad 단일 작성자·append-only / S에서도 pre-builder baseline capture.
3. **NEVER**: 승인 전 소스 쓰기(sizing·M·L) / 태스크 단계 전량 테스트 / 무변화 중복 검증 실행 / 고도 이탈 수용 / 시나리오 없는 메커니즘 추가 / 스코프 밖 개선 / 리뷰어=생산자 동일 프로바이더 / STALLED 자가 해제 / 신규 실행 인프라 제작.
4. **플로우**: S(그라운딩→baseline→빌드→tier 검증→코드리뷰 루프→보고) / M(그라운딩→경량 계획→승인→TASK-DETAIL 설계·설계리뷰→baseline→빌드→코드리뷰→**`verify --task t1` → `verify --integration`**→보고 — 부모 §5 순서, DR-115) 각 ≤15줄 + "L이면 `stages/large.md`를 그 시점에 Read". 이의 게이트·R1–R5는 `loop.md`·`review-loop-driver.md` 참조.

`stages/large.md`: 아키설계(0.10 A3 트리거 5항 유지)→분할 초안→태스크 스코프 그라운딩(스카우트 병렬, 산출=태스크별 Env Fact Sheet)→CONTRACT 작성·리뷰→A5.0 검증 증거 계약(0.10 문안 압축 이식)→승인→브리프→러너 스폰·수집(0.10 B2′ 계승: 카나리아·워치독·FAILURE 분류)→순차 통합(0.10 B3′ 계승: mergeBaseline·확인 리뷰·archive-to — **각 태스크의 확인 리뷰 APPROVE 직후 그 태스크의 `verify --task <id>` 실행**, 0.10 B4 계승·DR-115)→**전 태스크 receipt 확보 후 통합 검증(§6-b: `verify --integration`)**→Final Review 1유닛→completion. **CONTRACT 결함의 in-run 수정은 0.10 errata v2 경로 그대로**(§5의 contract-conflict 수신 포함 — DR-106).

## 4. CONTRACT 프로파일 (`design-authoring-contract.md`)

경량 단일 모드(formal 없음). 섹션 계약:

1. **결정 요약** — 태스크 간 경계 핵심 결정 3~5개와 근거.
2. **태스크 분할표** — 태스크마다: id / 목적 1줄 / **독립 리뷰 가치 근거 1줄(필수)** / scope 경로 / deps / 스코프 테스트 집합 / 사람검증 항목(없으면 "없음").
3. **태스크 간 계약** — 인터페이스·데이터·이벤트만. 기계 판독 스키마는 파일·ID 참조. **태스크 내부 로직·클래스·SQL 금지**.
4. **태스크별 Env Fact Sheet** — 각 사실에 소스 경로. 카테고리: 코드 경로·기존 테스트·런타임/드라이버·세션 시맨틱스(배치 스코프 SET 옵션, datetime 절삭, rowcount 신뢰성 등)·스키마 상태.
5. **검증 전략** — 자동(태스크 스코프 테스트 / 통합 전체 스위트 — §6-b 필드로 등록) / 사람(체크리스트) 2열.
6. **비목표** — 최소 1줄.

manifest 스키마: 0.10 `harnie-manifest`에 2개 확장 — ① top-level `integrationVerification: [{executable,args,cwd,timeout,evidencePolicy?,repo?}]` — **L·M 필수**(arm 시 빈 배열 거부; A5.0 증거 계약 동일 적용; 워크스페이스 런은 entry별 `repo`(등록 repo key) 필수 — `cwd`는 그 member workroot 기준 해석). **S는 대상 아님**(S는 manifest 없이 tier 검증 — 부모 §9 S 시나리오의 "자동 검증" 실현). ② `gates`는 L에서 `[{name:"final-review", reviewUnit:"final-review"}]` 1개, M에서 `[]`.

## 5. 러너 프로토콜 (`harnie-task-runner.md` 재작성)

유지: worktree 생성·probe·카나리아 핸드셰이크·threadId 바인딩·fail-fast(무변경 트리 idle timeout 2연속 = 인프라, 세션 재시작 권고)·커밋(scope 한정 pathspec)·구조화 종료 보고·"러너는 소스를 쓰지 않는다"(리뷰·설계 아티팩트 Write는 예외로 명시).

**스텝(순서)**: 1 worktree → 2 브리프 Read → 3 **증분 그라운딩**(브리프 Env Fact Sheet 검증+잔여 확인, 목표 ≤ 스카우트 1회분) → 4 **TASK-DETAIL 설계 Write**(`<taskWt>/.harnie/review/design/design.md`, 경량 detail 프로파일) → 5 **Codex 설계리뷰 루프**(read-only, `gpt-5.6-sol`, `<dir>`=`…/review/design/`, DR, 경로 전달 — quick Step 3 계승) → 6 baseline `capture --record` → 7 probe·(카나리아면 핸드셰이크) → 8 빌드(브리프 인라인 + `builder-contract.md` 경로 Read 지시, 스코프 테스트 한정) → 9 인라인 코드리뷰 루프(CR) → 10 커밋 → 11 종료 보고.

**CONTRACT 충돌(DR-106)**: 스텝 4~5 중 CONTRACT와 충돌 발견 시 — 트리 무변경 상태로 즉시 `contract-conflict: <계약 절> <충돌 내용>` 종료 보고(설계 문서는 남김). 메인의 복구 = 0.10 errata v2 경로 재사용: `errata-add`(CONTRACT는 design 문서) → blocker/degrade면 사용자 승인 disposition → 전파는 **0.10 규칙 그대로 정확히**: **직접 영향 태스크**(수정된 계약 절을 인용한 브리프의 태스크)만 — 미착수 = 브리프 vN+1 재발행, 진행 중 = TaskStop→재발행→재스폰, 통합됨 = rebind 절차; **deps 후손은 상류 수정 병합 후 verify 재실행만, 실패 시에만 수정 대상으로 승격**. 재발행된 브리프의 태스크는 기존 TASK-DETAIL·D 상태가 **자동 무효**(아래 리비전 바인딩 — 재개표가 브리프 에디션 불일치를 감지해 스텝 4로 보낸다). scope/verification 변경이 필요하면 `superseded-by-A5.2`. serial fallback 선택 시 근거를 notepad에 기록.

**설계 승인의 리비전 바인딩(DR-105·106)**: DR 루프의 `apply`에 `--artifact dr:<sha256>`를 허용한다(§6-g). **해시 키 = sha256(설계 파일 내용 ‖ 현재 planHash ‖ 에디션 토큰 ‖ 승인 errata 커서)** — 에디션 토큰은 L에서 브리프 에디션(`t<id>-brief.vN`), M에서 고정 문자열 `m-plan`; errata 커서는 이 태스크의 브리프가 인용하는 계약 절에 대해 마지막으로 승인된 errata ID(없으면 `none`). 재개·D-기반 진입마다 **현재 권위(planHash·브리프 에디션·errata 상태)로 재계산해 state의 `reviewedPostSHA`와 대조** — 불일치 = stale 승인으로 스텝 4 강등. 이로써 ① design.md 헤더만 바꾼 재사용 ② A5.2 후 브리프 재발행 누락 ③ CONTRACT correction 후 구 설계 재사용이 전부 해시 불일치로 차단된다.

**개정 재개표(DR-105)** — 디스크 상태만으로 진입점 판정(D=`review/design/` 상태, C=`review/code/` 상태):

| 관측 상태 | 진입 |
|---|---|
| worktree 없음 | 스텝 1 |
| worktree 있음 · design.md 없음 | 스텝 3 |
| design.md 있음 · D state 없음(리뷰 전 사망) | 스텝 5(첫 설계리뷰) |
| D `REVISING` | 설계 수정 후 재리뷰(스텝 4→5) |
| D `STALLED` | 정지·보고(재진입은 메인) |
| D `APPROVED`(브리프 에디션 일치) · baseline 기록 없음 | 스텝 6 |
| D `APPROVED` · 브리프 에디션 불일치 | 스텝 4(설계 재작성 — 리비전 바인딩 규칙) |
| D `APPROVED` · baseline 있음 · threadId 미바인딩 · 트리 clean | 스텝 7→8 |
| baseline 있음 · threadId **미바인딩** · 트리 **dirty**(바인딩 전 사망 — 귀속 불명) | **fail-closed 인계**: 진행 금지, 파일 목록·delta와 함께 FAILURE 보고(메인·사용자가 귀속 판단 — 임의 재사용·revert 금지) |
| threadId 바인딩 · C state 없음 · 트리 dirty | 스텝 9(최근 기록 baseline에서 delta) |
| threadId 바인딩 · C state 없음 · 트리 clean | 스텝 8(`codex-reply`로 실 빌드) |
| C `REVISING` | `codex-reply` 수정(바인딩 스레드; 미전달 시 FAILURE 보고) |
| C `APPROVED` · 미커밋 | 스텝 10 |
| 커밋됨 | 종료 보고만 |
| C `STALLED` | 정지·보고 |

**워치독(DR-107)** — `builderBoundAt` 생명주기: PostToolUse가 태스크의 **첫 threadId 바인딩 성공 시각**을 execution.json에 기록(1회, 이후 불변 — 재스폰·correction/dead-session rebind에도 리셋 없음; 필드 부재 구 상태는 `startedAt` 폴백). **예산 산식(연장 통합)**: `effectiveWall = baseWall × (1 + extensions)`, `effectiveCalls = baseCalls × (1 + extensions)` — wall 초과 판정 `now - builderBoundAt > effectiveWall`, 호출 수는 **누적 카운트 유지(리셋 없음)**로 **pre-call 판정 `calls >= effectiveCalls`면 deny**(기존 상한 계약 보존 — base 15면 15번째 사용 후 16번째 호출 거부; 연장 전후 경계값 테스트 필수). `watchdog-extend`는 `extensions`를 +1(기존 상한 계약 유지: auto-cap 1회 = 총 2× 이내, 초과는 사용자 동의). 현행 "startedAt·호출 수 리셋" 구현을 이 산식으로 대체. 변경 파일: post-tool-use 훅(기록), `execution.mjs` watchdog 계산·extend, 테스트(기록·폴백·rebind 후 유지·연장 산식·구 상태 호환).

**브리프 축소**: `t<id>-brief.md` = manifest 엔트리 + CONTRACT의 해당 태스크 절(분할표 행·관련 계약 절·태스크 Env Fact Sheet) 발췌 + notepad 발췌 + `builder-contract.md` 경로. 구 "설계 섹션 verbatim 전체" 폐지.

## 6. 스크립트 변경 목록 (전체·이 목록이 계약)

- **(a) `execution.mjs set-mode`** 신설: §2 전이 규칙 + **`S` 설정 시 단일 암묵 태스크 `t1`(reviewUnit `code`) 등록·`building` 상태 초기화**. **`registerBuilderAuto` 변경 포함(DR-114)**: `mode==="S"`에서는 manifest 조회 대신 암묵 `t1`으로 매핑하되, 호출 cwd의 git root가 run workroot와 일치할 때만 바인딩(불일치 = fail-closed, 바인딩 거부·보고) — 이 매핑 없이는 S의 첫 workspace-write 호출이 threadId 미귀속으로 `codex-reply`·워치독이 전부 실패한다. **`completion`을 mode-aware로**: S = §2의 3항 판정, M/L = 기존 유도 + 통합 receipt(§6-b); Stop 훅은 completion 산식을 호출(단일 구현). 테스트: 상향/하향/불일치 fail-closed, S 면제, S t1 등록·root-cwd 바인딩·타 cwd 거부, S completion 3항, 검증 순서 회귀.
- **(b) 통합 검증(DR-102)**: manifest top-level `integrationVerification` 스키마 추가 — validateManifest에서 **L·M 필수**(빈 배열이면 arm 거부), 워크스페이스 런은 entry별 `repo` 키 필수(그 member workroot에서 실행). `execution.mjs verify --integration --root --slug` 신설: shell-free argv 실행, run-level receipt `receipts/integration.json` — **유효 키 = whole-tree 아티팩트(워크스페이스는 `ws:` composite — `loop.mjs capture` 산식 재사용) + planHash + integrationVerification 항목의 정규화 해시**(승인된 계약과 다른 argv로 만든 receipt는 무효). vacuous 검출 동일 적용. **동일 유효 키의 pass receipt 존재 시 실행하지 않고 `skipped: existing-receipt` 반환**. `completion`: L·M에서 현재 트리·현재 planHash와 일치하는 pass receipt 부재 = 블로커. 테스트: 유효 키 3요소 각각의 불일치 무효, skip, 워크스페이스 repo 해석.
- **(c) 게이트 티어링(DR-104)**: `validateManifest`의 "4게이트 필수"를 mode 기준으로 — L: `final-review` 1개 필수, M/S: `gates: []`. completion의 게이트 검증은 선언된 게이트에 대해서만(기존 로직 재사용). 테스트: L 게이트 누락 arm 거부, M 게이트 없음 completion 통과.
- **(d) `rebind-task` dead-session(DR-108)**: **사용자 승인 원샷 바인딩 + 원문 봉인** — `execution.mjs rebind-arm --root --slug --task <id> --old-thread <threadId> --evidence <provider terminal 응답 원문 텍스트|@file>`. arm은 ① `--task`의 현재 바인딩 threadId와 `--old-thread` 일치 ② `--evidence`에 terminal 패턴(`Session not found`류 — 엔진이 알려진 terminal 마커 화이트리스트로 검사; idle-timeout 문구는 화이트리스트에 없어 거부)을 요구하고, 그 원문을 **arm 페이로드에 봉인**한다. 다음 AskUserQuestion은 봉인된 원문·태스크·구 threadId를 **질문 본문에 그대로 제시**해야 하며(PostToolUse가 대조), 정확한 `Approve` 선택에만 threadId 해제+마커 설정을 원자 수행. 요약·전언이 아닌 원문 제시로 "다른 태스크의 오래된 문구 재사용" 사고를 사용자 눈앞에서 차단. **원샷 arm 상호배제(DR-108)**: A5 `arm-approval`·`errata-arm`·`rebind-arm`은 **런 전체에서 동시에 하나만 pending**(기존 "errata-arm은 pending A5와 상호배타" 규칙의 일반화 — 엔진 강제: pending arm 존재 중 새 arm은 exit 2). 하나의 AskUserQuestion 응답은 자신을 소비한 arm 타입의 전이만 원자 수행하며, 실패(불일치·비승인) 시 어떤 전이도 일어나지 않는다. 기존 `correction:E-NNN`·`--cancel` 무변경. 테스트: old-thread 불일치 거부, 비-terminal 증거 거부, 질문 본문 불일치 비바인딩, 승인 바인딩, 이중 arm exit 2.
- **(e) `delta.mjs` `maxBuffer` 상향** 1줄(선택 채택분).
- **(f) 부트스트랩 훅**: `/harnie:dev` 커맨드 매칭 추가(기존 dev-full 매칭은 alias 경유 호환 유지), sentinel에 `mode:"sizing"` 초기화. track 값은 `plan` 유지 — 그 외 훅·guards 무변경.
- **(g) `loop.mjs apply` — DR 아티팩트 허용(DR-105)**: `--ns DR`에서 `--artifact dr:<sha256>` 형식을 허용(기존 금지 완화 — CR의 40-hex/`ws:`와 구분되는 접두사), 기존 `reviewedPostSHA` 필드에 저장. 그 외 apply 로직 무변경(contest는 CLI 개념 아님 — §7). 테스트: dr: 형식 수용, DR에 40-hex 거부 유지, CR에 dr: 거부.
- **(h) `scripts/run-capped.mjs`** 신설(§9 의존): `node run-capped.mjs <timeout-ms> <cmd> [args…]` — `spawnSync(…, {timeout})` 래퍼. macOS에 `timeout` 명령이 없으므로 dev-solo의 리뷰 서브프로세스 실행 상한을 이것으로 건다. 테스트: 상한 초과 kill·비정상 종료 코드 전달.

## 7. 이의(contest) 게이트 — 문안·기록 계약

- **제기**: 다음 리뷰어 호출 프롬프트에 `CONTEST [ID] reason=<altitude|overengineering> : <근거 2~3문장>` 블록. 수정을 대체(그 ID에 대한 산출물 변경 없음).
- **판정(그 응답 1회)**: 수긍 → `resolved`(+필요시 신규 non-blocking ID — 스키마 무변경) / 고수 → `open` 유지 + 구체적 실수 시나리오 명시.
- **고수 시**: 재설득 금지, 즉시 사용자 에스컬레이션 → 인수 시 기존 human-gated 해제 절차(`user-decision`) / 사용자가 리뷰어 편이면 정상 REVISING.
- **이의 불가**: 정확성·안전·미검증 리스크. 리뷰어는 이의 불가 클래스의 CONTEST를 고수로 처리(리뷰 기준 문서에 명시).
- **기록(DR-109)**: 오케스트레이터/러너가 이의 라운드마다 `<dir>/contest-N.txt` 사이드카를 Write(round-N.txt와 동일 유닛 디렉터리·동일 권한 — 리뷰 라운드 파일과 같은 sanctioned 쓰기 대상): CONTEST 원문 · 리뷰어 판정 요약 · `--progress yes` 사유(`contest-adjudication`) · 에스컬레이션·사용자 결정 기록. harness-digest는 `contest-*.txt`를 스캔해 남용을 집계. `loop.mjs`는 무변경 — apply 호출 시 `--progress yes`는 이의 판정 라운드(blocking 수 불변이 정상)에만 사용하고 그 사유가 사이드카에 남는다.

## 8. 위임 프롬프트 경로 참조 + U-2 카나리아

- **원칙**: 표준 계약은 경로 Read 지시로 전달 — Claude Code 쪽 위임은 `${CLAUDE_PLUGIN_ROOT}/instructions/builder-contract.md`(설계·리뷰 기준의 경로 전달은 이미 검증된 기존 패턴), dev-solo 문서는 마켓플레이스 스냅샷 절대경로 `~/.codex/.tmp/marketplaces/harnie/…`. 태스크 브리프 내용은 계속 인라인(blob-ban·`.harnie` 경로 금지 불변 — `builder-contract.md`는 플러그인 루트라 무관).
- **U-2 카나리아 — 실측 통과(2026-08-25, T1에서 실행)**: `mcp__codex__codex`, `sandbox:"workspace-write"`, `gpt-5.6-terra`, cwd=작업 트리로 1콜 — 레포 절대경로와 마켓플레이스 스냅샷 절대경로(`~/.codex/.tmp/marketplaces/harnie/instructions/…`) 두 파일의 첫 헤딩을 모두 정확히 반환. **경로 참조 위임 채택 확정** — 빌더 프롬프트의 표준 계약은 `builder-contract.md` Read 지시로 전달한다.

## 9. dev-solo (Codex 단독) — CLI-only 권위 경로

- **초기화(DR-111)**: 훅이 없으므로 `execution.mjs init --root <repo> --slug <slug> --authority cli`를 dev-solo가 직접 호출(신설 플래그). init(authority cli)은 훅 부트스트랩이 하던 실행 환경 준비를 포함한다: **run worktree/branch 생성**(`harnie/<slug>` — 기존 `worktree.mjs` 재사용; 워크스페이스면 run-state 디렉터리 + `repo-add` 경로 그대로), sentinel·execution.json 초기화(`mode:"sizing"`). `authority:"cli"` 런에서만 `approve` 서브커맨드가 유효하고, 훅-부트스트랩 런(`authority:"hook"`)에서는 exit 2(자가승인 차단 불변). 기존 init 가드(중복 sentinel 거부) 재사용. 테스트: hook 런 approve 거부, cli init의 worktree 생성.
- **승인(M/L)**: plan.md를 사용자에게 제시하고 대화 승인 후 `execution.mjs approve --root --slug --plan-hash <hash>` — 현재 plan.md의 planHash 불일치 시 거부. 대화 승인의 기계 바인딩 부재는 **문서화된 한계**(Codex 훅 신뢰 게이트의 무음 스킵 리스크로 훅 강제가 비목표라는 부모 결정의 귀결); approve 호출·planHash·시각이 감사 기록으로 남는다.
- **실행·검증·완료**: 스냅샷 `scripts/`의 `loop.mjs`·`execution.mjs`(set-mode/set-task/verify/`verify --integration`/completion — completion은 §6-a의 mode-aware 산식이라 S도 CLI로 판정 가능)를 셸로 그대로 사용. **seal/seal-verify도 유지** — 생산자와 오케스트레이터가 같아도, 실수하는 메인이 권위 파일을 우발 변경하는 것의 탐지 가치는 동일하다(부모 disposition 표의 유지 결정 준수). HARNIE_STATUS는 completion 출력에서만 유도.
- **리뷰 배선(DR-112)**: 두 경로 모두 **셸 서브프로세스 = fresh context가 구조적으로 보장**되고 stdout을 `round-N.txt`로 저장해 `apply`로 판정한다.
  - cross-model(기본, 감지 = `command -v claude` 성공): `node <스냅샷>/scripts/run-capped.mjs <상한ms> claude -p "<리뷰 프롬프트>" --model <티어> --allowedTools Read Grep Glob` — **도구 화이트리스트로 read-only를 기계 격리** + **run-capped 래핑으로 결정적 종료**(§6-h; macOS `timeout` 부재·codex-wrappers 워치독 교훈). 프롬프트에 기준 파일 절대경로(스냅샷)·review-schema 출력 요구·delta.patch 경로 포함. headless claude는 MCP 미로드지만 Read/Grep 내장이라 리뷰에 충분. 상한 초과·비정상 종료는 폴백 경로로.
  - 셀프리뷰 폴백: `node <스냅샷>/scripts/run-capped.mjs <상한ms> codex exec --sandbox read-only -m gpt-5.6-sol "<동일 리뷰 프롬프트>"` — 새 프로세스라 대화 이력 미전달, sandbox가 쓰기를 기계 차단. 스키마 불일치면 1회 재요청 후 **중단·보고**(protocol failure — `apply`는 invalid 라운드에 state를 기록하지 않으므로 STALLED 래치·`--reentry`는 적용되지 않는다; rev-6에서 정합화).
  - **ACR-1 결정(사용자 승인 2026-08-25)**: `claude -p` 채택 확정. 사용자 지침에 따라 MCP serve 복귀 분기는 두지 않는다 — CLI 호출에 문제가 있으면 **codex 셀프리뷰 폴백만으로 동작**한다(위 폴백 경로가 유일한 대안). T4 착수 가능.
  - Claude MCP 서버 등록은 **불채택** — 부모 rev-5 §6.6의 "Claude MCP(claude mcp serve)" 메커니즘을 CLI 서브프로세스로 대체하는 **Architecture Change Request(§13 ACR-1)**로 처리: cross-model 유지·셀프리뷰 폴백이라는 사용자 결정은 불변, 호출 메커니즘만 변경(근거: 설정 의존 제거·결정적 종료·도구 화이트리스트 격리 가능). 부모 문서에 개정 기록.
- **L 실행(solo 편차 — 설계 결정)**: 러너 서브에이전트 없이 **순차 자기 실행** — 태스크마다 자기 worktree에서 `harnie-task-runner` 프로토콜의 태스크 시퀀스(그라운딩→TASK-DETAIL 설계+리뷰→빌드→코드리뷰→커밋)와 재개표·contract-conflict 정지 규칙을 따르되, 배선은 solo식(빌드 = 자신, 리뷰 = 서브프로세스; 브리프 대신 CONTRACT 절 직접 참조 — 컨텍스트 격리가 없으므로 브리프 불요). 병렬 격리 불가 사실을 plan에 기록한다. (rev-1에 있던 결정이 rev-2 재작성에서 누락 — 문서 리뷰 CR-213이 발견, rev-6에서 복원.)
- **트리거·라우팅**: SKILL.md description을 코드 변경 요청 전반이 걸리게 작성 + `~/workspace/agent-ops/claude/CLAUDE.md`(=`~/.codex/AGENTS.md` 정본)에 "[Codex only] 개발 요청은 harnie dev-solo 스킬로 수행" 1줄 추가(릴리스 체크리스트 검증 항목).

## 10. 검증 계획·릴리스 게이트 (DR-113)

**S 카나리아(e1ct)**: happy-chebyshev 워크트리의 원 요청을 새 워크트리에서 `/harnie:dev`로 재실행.
- 측정: wall-clock, 총 리뷰 라운드, 오케스트레이터 툴콜 수, 산출 diff.
- **통과 조건**: ① 블라인드 A/B(무표기 두 diff를 fresh opus 리뷰어가 code-review.md 렌즈로 비교)에서 0.11 산출물에 **0.10에 없는 blocking 결함 0건** ② 세 비용 지표(시간·라운드·툴콜) 중 **2개 이상 개선, 악화 지표 없음**. 지표 상충 시 사용자 판정(품질 우선).

**L E2E(대상은 실제 업무에서 선정 — U-4)**: 필수 통과 단계 = ARCH(트리거 시)→CONTRACT 리뷰 APPROVE→러너 ≥2 병렬 완주→순차 통합+확인 리뷰→`verify --integration` receipt 1개→final-review APPROVE→completion COMPLETE.
- **통과 조건**: ① NFR-1(주 판정) — **run 전체의 모든 리뷰 유닛(설계·유닛·확인·final 포함) 라운드 합계**가 hmm급(0.10식 태스크 수 ≈14 상당)이면 **≤35**, 규모가 다르면 "0.10식 유닛 수 추정 × hmm 평균 3.8라운드"의 **50% 이하**(추정 근거를 CONTRACT 승인 자료에 기록; 태스크당 평균은 보조 지표) ② NFR-2 — 전체 스위트 실행이 receipt 기준 1개(+실패 유발 재실행 별도 집계, 무변화 중복 0) — receipt·delta 사이드카로 기계 확인 ③ 블라인드 품질 판정 동일 기준.

**NFR-3**: 릴리스 전 `wc -l` 기계 확인 ≤210줄.

**배포 절차**: 두 게이트 통과 → 0.11.0 태그·main 머지 → `codex plugin marketplace upgrade` + Claude `/plugin update` → agent-ops 라우팅 1줄 커밋 확인.

## 11. 구현 작업 분할

| id | 내용 | deps | 독립 리뷰 가치 근거 |
|---|---|---|---|
| T1 | `scripts/`+`hooks/` 변경(§6 a~f)과 테스트, U-2 카나리아 실행·기록 | — | 유일한 실행 코드 변경 — 독자 위험 |
| T2 | 파이프라인 문서 세트: commands/dev, skills/dev(+stages), instructions 재작성·신설, alias 처리 (+ko) | T1 | 최대 볼륨·상호 참조 일관성이 한 유닛 |
| T3 | agents 5종 재작성 (+ko) | T2 | 러너 프로토콜·재개표가 독자 리스크 |
| T4 | dev-solo + agent-ops 라우팅 + 리뷰 배선(claude -p, ACR-1 승인됨) (+ko) | T2 | Codex 쪽 독립 배포면 |
| T5 | plugin.json·README·CLAUDE/AGENTS·architecture.md 현행화 + 릴리스 체크리스트 | T2~T4 | 마감 정합성 유닛 |

T2~T4는 T1 이후 병렬 가능. 각 유닛 완료 시 cross-model 리뷰.

## 12. Revision Notes

**rev-2** (Codex 상세 리뷰 라운드 1의 blocking 13건 전량 반영):
- DR-101 → §2: `.harnie/dev/` 개명 철회 — 상태 루트·track `plan` 재사용, mode 필드만 추가. 전환표 자체가 불필요해짐.
- DR-102 → §4·§6-b: `integrationVerification` manifest 필드 + `verify --integration`(whole-tree receipt, 동일 트리 skip) + completion 블로커 연결.
- DR-103 → §2: S 완료 = canonical 유닛 APPROVED + reviewedPostSHA 트리 일치 + 푸터, 회귀 테스트 명시.
- DR-104 → §2: M = detail 경량 설계 + 단일 태스크 manifest + gates [], 게이트 티어링은 §6-c.
- DR-105 → §5: 설계 상태(D)×코드 상태(C)×바인딩×트리 조합의 개정 재개표 명시.
- DR-106 → §3·§5: contract-conflict 복구를 0.10 errata v2 경로(전파·재발행·A5.2 상향) 재사용으로 확정.
- DR-107 → §5: builderBoundAt 생명주기(1회 기록·rebind에도 불리셋·startedAt 폴백)와 변경 파일·테스트.
- DR-108 → §6-d: dead-session을 CLI 형식 검사에서 **사용자 승인 원샷 바인딩**(rebind-arm, errata-arm 패턴)으로 격상 — 기계 검증 불가한 증거를 사용자 권위로 대체.
- DR-109 → §7: contest 기록의 canonical artifact = `<dir>/contest-N.txt` 사이드카(원문·판정·progress 사유·에스컬레이션), digest 스캔 대상.
- DR-110 → §8: 카나리아를 실제 MCP 네임스페이스·sandbox·모델·정확한 스냅샷 절대경로로 고정, 두 경로 개별 판정.
- DR-111 → §9: `init --authority cli` + `approve --plan-hash`(cli 런 전용, hook 런에서 거부)로 CLI-only 권위 경로 확정, 한계 문서화.
- DR-112 → §9: 리뷰 원시 기능 확정 — cross-model = `claude -p` 서브프로세스(MCP serve 불채택), 폴백 = `codex exec` fresh 프로세스, 둘 다 stdout→round-N.txt→apply.
- DR-113 → §10: S/L 통과 조건·임계값·필수 통과 단계·NFR-1/2/3 기계 확인을 릴리스 게이트로 명시.

**rev-3** (Codex 상세 리뷰 라운드 2 반영):
- DR-102 → §4·§6-b: integrationVerification을 L·M 필수로(S는 tier 검증 — 부모 §9 S 시나리오 정합), receipt 유효 키 = whole-tree + planHash + 항목 정규화 해시, 워크스페이스 entry별 `repo` 키.
- DR-103·114 → §2·§6-a: S 플로우를 빌드→tier 검증→리뷰로 고정(검증 증거가 리뷰 입력 — 리뷰 APPROVE가 보증), set-mode S가 단일 태스크 t1 등록·building으로 빌더 바인딩·워치독 매핑 제공, completion을 mode-aware 단일 구현으로.
- DR-104 → §2·§3: M 순서를 부모 파이프라인대로 원복 — 승인 전 = 경량 계획+manifest, TASK-DETAIL 설계·리뷰는 승인 후.
- DR-105·106 → §5: 재개표에 미바인딩+dirty fail-closed 인계와 브리프 에디션 불일치 강등 행 추가, 설계 승인의 리비전 바인딩 신설, errata 전파를 0.10 규칙 그대로(후손은 verify만, 실패 시 승격) 정정.
- DR-107 → §5: watchdog-extend 산식(effectiveWall/Calls = base×(1+extensions), 호출 수 누적 유지) 정의.
- DR-108 → §6-d: rebind-arm이 old-thread 대조 + terminal 마커 화이트리스트 검사 + 원문 봉인·질문 본문 제시(PostToolUse 대조)를 요구.
- DR-111 → §9: init(authority cli)이 run worktree/branch 생성 포함, completion mode-aware로 S도 CLI 판정, seal/seal-verify 유지로 원복.
- DR-112 → §9: claude -p를 `--allowedTools Read Grep Glob` 화이트리스트 + `timeout` 래핑으로 기계 격리; MCP→CLI 메커니즘 변경은 ACR-1로 공식화(§13, 부모 문서 개정).
- DR-113 → §10: NFR-1 주 판정을 run 전체 라운드 합계(≤35 hmm급 / 0.10 환산 50%)로 복원, 태스크 평균은 보조.

## 13. Architecture Change Requests

**rev-4** (Codex 상세 리뷰 라운드 3 반영):
- DR-105 → §5·§6-g: 리비전 바인딩을 권위 state로 격상 — DR `apply`에 `dr:<sha256(설계+브리프 에디션)>` 아티팩트 허용, 재개 시 재계산·대조로 stale 승인 차단.
- DR-107 → §5: pre-call 판정 `calls >= effectiveCalls`로 기존 상한 계약 복원, 경계값 테스트.
- DR-108 → §6-d: 원샷 arm(A5·errata·rebind) 런 전체 단일 pending 상호배제, 응답 소비의 원자성.
- DR-112 → §6-h·§9: macOS `timeout` 부재 → `run-capped.mjs`(spawnSync timeout) 신설로 대체. ACR-1은 사용자 결정 대기(T4 착수 전 필수).
- DR-114 → §6-a: `registerBuilderAuto`의 S 매핑(root-cwd → 암묵 t1, 타 cwd fail-closed) 명시.
- DR-115 → §3: M = 코드리뷰 후 `verify --task t1`→`verify --integration`, L = 태스크별 확인 리뷰 직후 `verify --task`(0.10 B4 계승)·전 receipt 확보 후 통합 검증.

**rev-5** (Codex 상세 리뷰 라운드 4 반영):
- DR-105 → §5: dr: 해시 키를 설계 내용+planHash+에디션 토큰(L=브리프 vN, M=`m-plan`)+승인 errata 커서로 확장 — A5.2·correction 후 stale 승인 재사용까지 차단.
- DR-112 → §9·§11: 실행 명령을 `run-capped.mjs`로 정합화, ACR-1 기각 분기(claude mcp serve 등록·호출 계약) 명시, T4 deps에 ACR-1 결정 추가.

**rev-6** (T2~T4 문서 리뷰 반영): CR-213 — rev-2 재작성에서 누락된 solo-L 순차 실행 결정을 §9에 복원(러너 프로토콜 시퀀스 준수 + solo 배선 치환 명시). CR-209 — `rebind-task`에 `finding:CR-NNN` 사유 추가(통합 후 순수 코드 결함의 마커 경로; §6-d의 correction 경로와 동일 효과, 테스트 포함). CR-217 — dev-solo 설계리뷰 모델은 opus **잠정**(U-3 첫 사용 실측 후 확정).

**ACR-1 (승인됨 — 2026-08-25)**: 부모 §6.6의 dev-solo cross-model 리뷰 메커니즘 `claude mcp serve`(MCP 서버 등록)를 **`claude -p` CLI 서브프로세스**로 변경. 사용자 결정(cross-model 우선·셀프리뷰 폴백)은 불변. 근거: ① config.toml 의존 제거 ② `--allowedTools` 화이트리스트로 read-only 기계 격리 ③ run-capped 래핑으로 결정적 종료. 사용자 지침: CLI에 문제가 있으면 codex 셀프리뷰만으로 동작(MCP serve 복귀 분기 없음). 부모 rev-6에 기록 완료.
