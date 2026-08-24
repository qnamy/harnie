# 상세 설계 — dev-full 0.10.0 재편: 플랜-분배-병렬-통합 (태스크 러너 구조)

> **rev-9** (구현 리뷰 중 발견된 D2 편차 정정 — 아래 rev-9 노트).
>
> **rev-9 노트 (W2 문서 리뷰 DR-029):** rev-5의 "마커 없으면 병렬 태스크가 하나라도 building인 동안 run-root 부트스트랩 fail-closed"는 **직렬 경로 B2를 차단하는 과잉**이었다(직렬 run은 마커 없이 run-root에서 부트스트랩하는 것이 정상). 정정: run/member-root cwd + 마커 없음 → **building-unbound 태스크가 정확히 1개이고 그 태스크의 워크트리가 존재하지 않을 때만** 허용·귀속(직렬 시그니처); 러너 소유 태스크(워크트리 존재)나 복수 후보는 계속 거부. guards·registerBuilderAuto 대칭 구현, 테스트 3종(직렬 허용 회귀·워크트리 존재 거부·복수 거부). 직접 작업 모드 — 경량 프로파일. 작성 근거: fcl-hmm run 실측(2026-08-19~21)과 2026-08-24 세션의 구조 분석·사용자 결정 4건. 부모 아키텍처 = `docs/architecture.md`(v0.9.x 기준) — 본 설계는 §5 PHASE B 실행 구조를 바꾸므로 아키텍처 변경 요청(ACR)을 §7에 분리했다.

## 0. Environment Fact Sheet (전부 레포·세션에서 검증)

| 사실 | 출처 |
|---|---|
| dev-full 계약: A5 승인은 arm-approval→AskUserQuestion 훅 바인딩, planHash 봉인, manifest는 A5.2로만 개정 | `skills/dev-full/phases/phase-a.md` A5 |
| 병렬 경로(B2′/B3′)는 존재하나 **경로 선택이 오케스트레이터 재량이고 근거 기록 의무 없음** — fcl-hmm run은 조건 충족에도 직렬 실행(태스크 워크트리 0개) | `phases/phase-b.md` B1, run 상태 실측 |
| `registerBuilderAuto`는 시스템 전체에서 building+unbound 태스크 1개만 자동 바인딩(gap 4) — `decideCodex`도 최초 workspace-write 호출을 building 태스크 존재에 결부 | `phases/phase-b-parallel.md` gap 4, `scripts/guards.mjs` |
| `execution.json` 갱신 경로(set-task·threadId 등록·빌더 호출 카운트)는 현재 **단일 오케스트레이터 전제의 read-modify-write** — 병렬 갱신 락 계약은 미확립(`withStateLock` 프리미티브는 존재) | `scripts/execution.mjs` |
| 워크트리 엔진: `worktree.mjs create/merge/remove`(idempotent create, `.harnie` 스태시 후 제거 — **제거 시 태스크 리뷰 상태는 삭제됨**), guards가 활성 태스크 워크트리 sanctioning(gap 1–3 해소됨) | `phases/phase-b-parallel.md`, `scripts/worktree.mjs` 196줄 |
| 리뷰 루프 코어: `loop.mjs`(324줄) capture/delta/apply/export — apply가 ledger fail-closed·STALLED 래치·`--artifact` 바인딩·apply-before-next-producer 규칙 소유; delta는 `--out` 사이드카(changedCount 등) 기록 | `instructions/review-loop-driver.md`, `scripts/loop.mjs` |
| 실행 상태 엔진: `execution.mjs`(1,004줄) — set-task/seal/seal-verify/verify(리시트+vacuous 검출)/completion/arm-approval/repo-add/watchdog-extend | `skills/dev-full/SKILL.md` §Execution State, `scripts/execution.mjs` |
| Stop 훅의 false-done 차단은 completion 재도출(ledger APPROVE ∧ receipt pass)에 의존 — **리시트를 제거하면 불변식 ②가 무너짐** | `phases/phase-b.md` B6 |
| 빌더 경계: **Codex 빌더는 `.harnie` 경로를 수령하지 않는다** — 설계는 프롬프트에 인라인하고 rev를 명기(Builder exception) | `skills/dev-full/SKILL.md` §Delegation Reference Rule 4 |
| 모델 매트릭스: 세션 모델은 harnie 통제 밖; 유닛 리뷰 티어 easy=sonnet·**medium/hard=opus**, 확인 리뷰 hard 미만 sonnet, Final Wave 항상 opus | `instructions/model-matrix.md` §3 |
| 실측 기준선: 오케스트레이터(opus) 1,869콜·출력 4.49M·캐시리드 889M·콜당 입력 p50 47~54만; wall 45h 중 승인 대기 25h; 리뷰 유닛 19개 중 극소 유닛 다수 | 메모리 `fcl-hmm-run-cost-measurement` |
| Claude Code 서브에이전트: Task 호출에 모델 오버라이드 가능, **frontmatter `tools` allowlist에 명시된 도구만 사용 가능**(MCP 도구 포함 필요), 서브에이전트는 Task tool로 중첩 spawn 불가 | `model-matrix.md` §3 선택 메커니즘, Claude Code 문서 조사(2026-08-24) |
| Codex MCP 도구명은 설치별 상이: `mcp__plugin_harnie_codex__codex(-reply)` 또는 `mcp__codex__codex(-reply)` | `instructions/review-loop-driver.md` 서두 |
| Agent Teams는 실험 기능: `/resume`이 팀메이트 미복원, 팀메이트에 서브에이전트 frontmatter mcpServers 미적용, 훅 발화 미확인 | Claude Code 문서 조사(2026-08-24) |
| 훅 페이로드에 `agent_id`/`agent_type` 존재(메인/서브 구분 가능) | 2026-08-24 검증(grep-guard 도입 시 확인) |
| **이 머신에 `rg` 미설치** — 0.9.1 rg 정책·grep-guard는 설치 전까지 메인 세션 검색을 시스템 `grep` 폴백으로 몰아넣음 | 2026-08-24 실측(`command -v rg` 실패) |
| 테스트 인프라: `node --test scripts/*.test.mjs hooks/*.test.mjs` (loop/execution/guards/ledger/delta/worktree 테스트 존재) | `scripts/` 목록 |
| design errata v1 = 문서 계약만(B5 게이트 ledger가 이빨); v2(엔진 강제)는 "수기 변조 사고 관측 시" 조건부 보류였음 | `phases/phase-b.md` §Design errata, 메모리 `design-errata-v2-deferred` |

## 1. 설계 요약

**대상:** harnie dev-full의 PHASE B 실행 구조. PHASE A(그라운딩·설계·설계리뷰·승인)와 `loop.mjs`/`ledger.mjs`의 리뷰 상태 기계는 계약 불변, 배선만 바뀐다.

**문제:** 실측상 지배 비용은 ① main 오케스트레이터가 run 전체를 한 컨텍스트로 끌고 다니며 매 콜 재독(캐시리드 889M), ② 병렬 조건 충족에도 직렬 실행, ③ 게이트·권한 대기 25h, ④ 극소 유닛에 풀 리뷰 루프 고정비.

**해법(C안):** main은 **플랜과 통합만** 소유하고, 태스크 실행은 태스크당 1개의 **`harnie-task-runner` 서브에이전트**(모델 = 유닛 리뷰 티어, §2 D1)에 위임한다 — 소컨텍스트·병렬. 사용자 승인은 A5 1회. 크로스모델은 설계 리뷰(A3/A4, Codex)와 Final Wave(opus)에서 유지하고, 유닛 리뷰는 러너가 **인라인 Claude 리뷰**로 수행한다 — 빌더가 Codex이므로 유닛 리뷰도 크로스모델 성질을 잃지 않는다.

**입력/출력/의존:** 입력 = 승인된 manifest + 태스크 브리프(설계 발췌). 출력 = run 브랜치에 순차 통합된 태스크 커밋 + 기존과 동일한 completion 재도출. 의존 = Codex MCP, Agent tool 모델 오버라이드, guards/worktree 엔진(gap 1–3 해소 상태).

**스코프:** dev-full PHASE B 재편, errata v2 엔진, harness-digest 스킬, 관련 문서·미러. **비스코프(비목표):** Agent Teams 도입(실험 기능·재개 불가로 배제), dev-quick 변경, 스케줄러·의존그래프 실행기·자동 재시도, 전역 CLAUDE.md 압축(레포 밖 별도 건), 새 추상화 계층(러너는 에이전트 문서 1장 + 기존 CLI 재사용으로만 구성). 리뷰어 **티어 값** 변경 없음(러너 모델이 유닛 리뷰 티어를 그대로 따른다 — rev-1의 "러너=sonnet 고정"은 철회, §9 DR-004).

### FR / NFR

| ID | 내용 |
|---|---|
| FR1 | 배타 scope 태스크 2개 이상이면 **병렬(러너) 경로가 기본**. 직렬 선택 시 근거를 `notepad.md`에 기록해야 한다(강제는 문서 계약, §4 참고). |
| FR2 | 사용자 승인은 A5 1회(planHash 바인딩·A5.2 개정 경로 불변). 정상 경로에서 추가 사용자 게이트는 errata blocker/degrade disposition뿐 — 그 전이는 **훅 바인딩**으로만 성립(§2 D3). |
| FR3 | 크로스모델 게이트 = A3/A4 설계 리뷰(Codex) + Final Wave 4게이트(opus). 유닛 리뷰 = 러너 인라인 Claude 리뷰(대상은 Codex 빌더 산출물 — 크로스모델 유지), 러너 모델 = model-matrix 유닛 리뷰 티어. |
| FR4 | 태스크 러너·빌더는 **자기완결 브리프**만으로 실행 가능: manifest 엔트리 + 설계 발췌(rev-N·섹션명 명시) + notepad 관련 항목. run 전체 설계서(~100k tok)를 재독하지 않는다. 빌더에게는 러너가 브리프 **원문을 프롬프트에 인라인**해 전달한다(§2 D5). |
| FR5 | errata v2: `execution.mjs`가 errata를 control 파일로 소유(직접 Write 차단), pending blocker/degrade를 completion 재도출에 산입, blocker/degrade disposition 전이는 사용자 응답에 훅으로 귀속. |
| FR6 | harness-digest 스킬: run 종료 후 실행 상태·**보존된** 유닛 리뷰 상태(§2 D7 review-archive)에서 하네스 개선 후보를 **제안만**(quality-digest 원칙 재사용, 자동 적용 금지). |
| FR7 | **재개(resume) 프로토콜**: 러너·main이 어느 지점에서 중단돼도 디스크 상태만으로 단계별 재진입이 가능하다(§2 D6). |
| NFR1 | main 콜당 입력 p50 < 100k 토큰(실측 47~54만 대비 ~80%↓). 측정: 다음 run 세션 JSONL 분석. |
| NFR2 | 실작업 wall time이 임계 경로에 수렴: fcl-hmm급(15태스크·경로 7단계) 재현 시 실작업 ≤ 10h `[가정: 태스크당 러너 40~80분]`. |
| NFR3 | 정상 run의 사용자 개입 ≤ 2회(A5 + 알림 응답). watchdog 밤샘 블록 제거(§2 D4). |
| NFR4 | 사고 유래 불변식 무손실: ① 승인 전 소스 쓰기 차단 ② false-done 차단(리시트+Stop 훅 유지) ③ blob 경로 위임 금지 ④ ledger fail-closed ⑤ bootstrap 준수 ⑥ scope 배타 검증(arm-approval) ⑦ 빌더의 `.harnie` 비접근. |

### 요구사항 추적 매트릭스

| ID | 구현 모듈 | 검증 |
|---|---|---|
| FR1 | `phases/phase-b.md` B1 재작성 | 문서 리뷰 + 다음 run에서 경로 선택 기록 확인 |
| FR2·FR5 | `execution.mjs` errata 서브커맨드 + 훅 바인딩(D3) + `guards.mjs` 보호 목록 + completion 산입 | `execution.test.mjs`·`guards.test.mjs` 신규 케이스(무승인 전이 차단 포함) |
| FR3 | `agents/harnie-task-runner.md` 신설(티어 모델·인라인 리뷰 계약), `phases/phase-b.md` 재편 | 문서 리뷰 + W0 PoC |
| FR4 | phase-a A5 직후 브리프 생성 스텝, `.harnie/plan/<slug>/tasks/t<id>-brief[.vN].md`, 러너의 인라인 전달 계약 | 브리프 존재·rev 명시를 러너 시작 조건으로 계약; 빌더 프롬프트에 `.harnie` 경로 부재 |
| FR6 | `worktree.mjs remove` review-archive 이관(D7) + `skills/harness-digest/SKILL.md`(+ko) | 이관 후 ledger/사이드카 존재 테스트; fcl-hmm run 시범 실행 |
| FR7 | 재개 규칙표(D6)를 phase-b·러너 본문에 계약화, `loop.mjs capture --record` | 중단 지점별 재개 테스트(W1) |
| NFR1–3 | 구조 자체 + harness-digest가 회귀 측정 | 다음 실측 run 대비 |
| NFR4 | 훅·엔진 불변(수정 범위 밖) + D2·D3·D4의 보수적 설계 | 기존 테스트 전체 통과 + D2 동시성 테스트 |

## 2. 핵심 결정

### D1. 실행 계층: main = 플랜+통합, 태스크 = `harnie-task-runner` 서브에이전트

- **신규 에이전트 `harnie-task-runner`.** frontmatter: `model: opus`(안전 폴백 — main이 Task 호출 시 **유닛 리뷰 티어**를 오버라이드로 전달: easy=sonnet, medium/hard=opus. model-matrix §3의 기존 행을 그대로 따르므로 티어 값 변경이 아니다); `tools: Read, Glob, Grep, Write, Bash, mcp__plugin_harnie_codex__codex, mcp__plugin_harnie_codex__codex-reply, mcp__codex__codex, mcp__codex__codex-reply`(설치별 네임스페이스 병기 — 미존재 도구명은 무해하나 **W0에서 실제 러너 컨텍스트의 codex 호출 가능 여부를 검증**한다. Edit 불필요: 소스는 Codex 빌더가 쓴다). 서브에이전트는 Task 중첩 spawn이 불가하므로 **유닛 리뷰는 러너 본문이 인라인 수행** — 리뷰 기준은 `code-review.md`+`verification-tiers.md`+`review-schema.md`를 러너가 Read(harnie-reviewer와 동일 방식). 생산자 = Codex 빌더, 리뷰자 = Claude(러너)로 "reviewer = producer의 반대 프로바이더" 불변식이 유닛 수준에서도 유지된다. 러너 본문 가드레일: "너는 코드를 직접 쓰지 않는다"(기존 "main inline 리뷰 금지"는 main의 자기 리뷰 방지 목적이라 저촉 없음).

- **결정적 실행 순서(태스크 1개당).** *main:* ⓐ 러너 spawn **직전** `execution.mjs set-task --task <id> --run-status building`(훅이 빌더 부트스트랩을 허용하는 전제 — D2에 따라 복수 building 동시 허용) → ⓑ 러너 spawn(Task tool, background, 모델 오버라이드, 브리프 경로 전달). *runner:* ① `worktree.mjs create`(idempotent) → ② 브리프 Read → ③ **빌드 전 baseline 캡처**: `loop.mjs capture <taskWt> --record <taskWt>/.harnie/review/code/` — `--record`는 신규 플래그로 `baseline-N.json`(SHA·시각)을 리뷰 디렉터리에 영속화한다(재개 근거, D6). **컨테인먼트:** `--record` 목적지는 positional `<repo>`의 `.harnie` 아래 **또는** 활성 run workroot(센티널 검증)의 `.harnie` 아래여야 한다 — 후자는 워크스페이스 run에서 correction baseline을 run 상태의 reviewUnit 디렉터리에 기록하기 위한 것으로, 기존 R4 apply의 split-containment(delta는 멤버 레포, ledger/state는 run root)와 같은 이원 규칙이다(라운드 6 DR-012) → ④ codex 빌드(`cwd:<taskWt>`, 난이도 모델, 브리프 원문 인라인 — D5; 6섹션 계약·빌더 위임 계약은 기존 review-loop-driver 문구 재사용) → ⑤ 유닛 리뷰 라운드: `loop.mjs delta <taskWt> <baselineSHA> --scope … --out …` → 러너가 리뷰 수행 → `round-N.txt` Write → `loop.mjs apply --root <taskWt> … --artifact <postSHA>` — **apply의 `committed: true` 확인 전에는 다음 생산자 호출(codex-reply) 금지**(기존 ordering hard rule 그대로) → REJECT면: 새 baseline `capture --record` → `codex-reply` 수정 → delta → 재리뷰 → apply, APPROVE까지 반복 → ⑥ scope 경로만 `git add -- <paths>`·commit → ⑦ 종료 보고(§아래). **seal/seal-verify는 태스크 단계에서 실행하지 않는다** — run 권위 봉인은 통합 시점(B3′ 1·3, 기존 계약 그대로)에만 의미가 있고, 태스크 워크트리에는 run 권위 상태가 없다(기존 B2′와 동일).

- **러너 종료 보고(구조화, main이 notepad에 요약 append):** verdict·라운드 수·blocking 추이·threadId·baseline/post SHA·delta 사이드카의 changedCount·errata-candidate(있으면)·notepad 후보 항목. **러너는 run workroot의 `.harnie/plan/`을 만지지 않는다**(읽기는 브리프 경로만, 쓰기는 금지 — 기존 태스크 워크트리 격리 계약).

- **기존 B2′ 스텝 2–3(태스크별 경량 설계 + 태스크별 Codex 설계 리뷰)은 제거한다.** 근거: A4 formal 설계가 decision-complete를 계약하고 브리프가 해당 섹션 원문을 전달한다. 태스크별 설계 루프는 A4와 중복이며 fcl-hmm 실측에서 한 번도 실행되지 않은 태스크당 Codex 왕복 고정비였다. 실행 중 설계 결함은 errata(v2)가 정정 채널이다.

- **main의 역할:** A5 직후 브리프 생성 → deps 레벨별로 러너 병렬 spawn → 완료 알림 수신 → **순차 통합**(기존 B3′ 1~5: mergeBaselineSHA 캡처+seal → `worktree.mjs merge` → seal-verify/충돌 해소+해소분 CR 1라운드 → 확인 리뷰 → 워크트리 제거(D7 아카이브 포함)) → B4 verify → B5 Final Wave → B6 completion. 확인 리뷰(post-merge abridged)는 main이 `harnie-reviewer` 서브에이전트(확인 티어)로 위임 — main은 서브에이전트 spawn이 가능하므로 기존 계약 그대로다.

- **main 컨텍스트가 작아지는 이유:** 빌드·리뷰 왕복(라운드당 수천~수만 토큰 × 태스크 × 라운드)이 전부 러너 컨텍스트로 이동하고, main에는 러너의 종료 보고(수십 줄)만 남는다. 세션 분할 계약(3~4유닛)은 유지하되 발동 빈도가 구조적으로 급감한다.

### D2. gap 4 해소 + 병렬 상태 갱신 원자성

- **threadId 등록(본선):** PostToolUse 훅이 codex 호출의 `cwd`에서 `<…>/.harnie-wt/harnie-<slug>-t<id>` 패턴으로 `<id>`를 유도해 그 태스크에 바인딩한다(워크스페이스 run은 멤버 workroot 하위 동형 패턴). cwd는 guards의 `isActiveTaskWorktree`가 이미 검증하는 값이라 새 신뢰 표면이 없다. 매핑 실패 시 기존 단일-unbound 로직 폴백(직렬 경로·quick 무변경). 방지하는 구체 사고: 러너 N개 동시 첫 호출 시 현행 로직은 unbound 2개 이상에서 바인딩 불가 → 전 태스크의 codex-reply 귀속 불능.
- **`decideCodex`·`registerBuilderAuto`의 복수 building 허용:** 최초 workspace-write 허용 판정을 "building 태스크 존재 ∧ cwd가 그 태스크의 워크트리"로 바꾼다(현행 "정확히 1개" 전제 제거). 이미 바인딩된 태스크의 재호출은 threadId 명시 `codex-reply`로만(기존과 동일).
- **대안(폴백, W0 부정 시):** 신규 sanctioned 서브커맨드 `execution.mjs bind-thread --root <repo> --slug <slug> --task <id> --thread <tid>`. **바인딩은 러너 자신이, 첫 codex 호출 직후·어떤 `codex-reply`보다 먼저 실행한다** — 러너 내부의 REJECT 수정 라운드가 `codex-reply`를 쓰므로, 통합 시점까지 바인딩을 미루면 미등록 thread의 재호출이 거부된다(라운드 2 지적). 같은 시점에 `<taskWt>/.harnie/review/code/thread.json`에도 threadId를 Write해 둔다(재개용 사본). **검증 계약:** 엔진은 ⓐ 해당 task가 building ⓑ `harnie/<slug>-t<id>` 브랜치의 워크트리 실존 ⓒ threadId 형식·중복(다른 태스크에 이미 바인딩된 값 거부) ⓓ **동일 값 재바인딩은 멱등 성공**(재spawn 시 thread.json 복원 경로), 다른 값은 거부를 검사한다. bind-thread는 추적 등록일 뿐 승인이 아니며 --root의 run 권위 파일을 이 서브커맨드 외로 열지 않는다.
- **폴백의 watchdog 대체(DR-011) — W0 결과 3분기:** 훅은 threadId 등록만 하는 게 아니라 PreToolUse가 watchdog 판정을, PostToolUse가 `recordBuilderCall`(호출 카운트)을 수행한다. 러너 컨텍스트에서의 발화 여부에 따라 — ⓘ **양쪽 발화**: 본선, 추가 계약 없음. ⓘⓘ **Pre만 발화(Post 미발화)**: 시간·판정은 훅이 유지하되 호출 카운트가 늘지 않으므로, 러너가 **각 codex/codex-reply 호출 직후 sanctioned `execution.mjs record-builder-call --root <repo> --slug <slug> --task <id>`를 실행**하는 계약을 러너 본문에 명시한다(러너가 계약을 빠뜨리는 실수는 위협 모델의 과잉 실행 클래스이고, 시간 캡은 훅이 계속 강제하므로 폭주 방어의 바닥은 유지된다). ⓘⓘⓘ **Pre도 미발화**: 러너 경로에서 watchdog 강제 자체가 사라지므로 **병렬 러너 경로를 지원 불가로 선언**하고 직렬 경로(B2–B3, 훅이 main 컨텍스트에서 정상 동작)로 폴백한다 — 러너 자율 기록에 시간 캡까지 맡기는 변형은 만들지 않는다. W1 테스트: 폴백 ⓘⓘ에서 16번째 호출 거부·시간 초과 거부 재현. 과거 MCP 호출의 실제 cwd는 CLI가 증명할 수 없다 — 잔여 리스크는 "main이 잘못된 threadId를 묶는" 실수인데, 이후 `codex-reply`도 워크스페이스 쓰기가 guards의 cwd 검증(활성 태스크 워크트리)에 갇히므로 권위 침해가 아니라 귀속 혼선으로 한정된다(수용, 문서화). 등록은 승인이 아니라 추적이므로 CLI 노출이 자기승인 방지 원칙과 충돌하지 않는다. **W0 결과로 본선/폴백 중 하나만 구현한다 — 둘 다 만들지 않는다.**
- **동시 갱신 원자성(DR-002):** `execution.json`을 갱신하는 모든 경로(set-task, threadId 등록—훅·CLI 불문, 빌더 호출 카운트, watchdog 기록)를 기존 `withStateLock`으로 감싼다. 병렬 러너 2개가 동시에 훅을 발화시키는 시나리오에서 마지막-쓰기-승리로 타 태스크의 threadId·카운트가 유실되는 사고를 막는다. W1에 동시 갱신 테스트(경합 시뮬레이션) 포함.
- **set-task 상태 전이 시맨틱 — watchdog 이력 보존(DR-003):** `set-task --run-status building`은 **최초 pending→building 전이에서만** `startedAt`·`codexCalls`를 초기화한다. 이미 building(또는 threadId bound)인 태스크에 대한 재호출은 멱등 no-op으로 기존 `startedAt`·`codexCalls`·`watchdogExtensions`를 보존한다 — 재spawn 때마다 초기화되면 러너를 다시 띄우는 것만으로 D4의 2× 캡이 우회된다(라운드 2 지적 사고). D6의 모든 재개 진입점은 이 보존 시맨틱 위에서 동작하며, W1 테스트에 "재spawn 후 watchdog 사용량 연속성" 케이스를 포함한다.

### D3. errata v2 (엔진 승격) — 최소 표면 + 승인 귀속

v1 보류 사유는 "수기 변조 사고 관측 전까지 표면을 늘리지 않는다"였다. 재개 근거(사용자 지시 + 구조 변화): 러너 구조에서는 설계 결함 발견 채널이 태스크 수만큼 분산되고 append-only를 문서 계약만으로 지키기 어려워진다.

- **서브커맨드:** `errata-add --severity --design-ref --defect`(E-NNN 채번·append), `errata-arm --id`(blocker/degrade disposition 승인 무장), `errata-set-disposition --id --disposition --correction`, `errata-list [--pending]`. 파일은 기존 `design/errata.md` 유지(포맷 신설 없음), `guards.mjs` 보호 목록에 추가해 직접 Edit/Write/Bash 쓰기 차단.
- **disposition의 사용자 귀속(DR-006):** blocker/degrade의 `pending → approved-workaround | deferred-next-run | superseded-by-A5.2` 전이는 **A5와 동일한 one-shot 훅 바인딩**을 재사용한다. **arm이 전이와 correction을 함께 봉인한다:** `errata-arm --id --disposition <값> --correction <텍스트 또는 파일>` 실행 후 첫 `AskUserQuestion`의 응답을 PostToolUse가 관찰해 선택값이 승인 옵션과 일치할 때만 훅이 **disposition과 correction을 한 append로 원자 기록**한다 — 승인과 correction 기록 사이에 중단·누락 창이 없다(라운드 2 지적). 이중 안전으로, `completion`은 correction 텍스트가 없는 `approved-workaround` 항목을 여전히 blocker로 계산한다. `errata-set-disposition` CLI는 **`note` 항목 전용**이며 blocker/degrade 전이는 어떤 CLI 경로로도 불가(fail-closed). 방지하는 구체 사고: ① 과잉 실행 main이 사용자 질문 없이 pending blocker를 approved로 바꿔 FR2 게이트와 completion 차단을 동시에 우회; ② 승인은 됐으나 대체 설계문(correction)이 기록되기 전에 세션이 죽어, 리뷰 기준 없는 항목이 해소로 계산.
- **completion 산입:** `completion`이 errata-list를 내부 호출해 pending blocker/degrade를 남은 blocker로 계산(v1은 B5 게이트 리뷰어 보고 의존 — 게이트 APPROVE 후 추가된 errata를 놓치는 창이 v2가 막는 구체 사고).
- **러너 연동과 브리프 무효화(DR-007):** 러너는 errata를 쓰지 못한다(guards + 러너 본문 계약). 결함 발견 시 종료 보고의 `errata-candidate`로 반환 → main이 errata-add. **correction 승인 시 영향 전파 규칙:** 브리프 머리말은 인용한 rev-N 섹션 목록을 명기하므로(D5), 영향 태스크 = correction의 design-ref 섹션을 인용한 브리프의 태스크. main은 영향 태스크별로 —
  - *실행 중 러너:* TaskStop → 브리프 vN+1 재발급 → 재spawn(워크트리 idempotent, threadId는 bound 상태로 `codex-reply` 계속, D6 재개표 적용).
  - *빌드 완료·미통합:* **수정 전 baseline capture**(`capture --record`) → `codex-reply`로 correction 반영 수정 → 그 baseline 기준 delta → 재리뷰(라운드 2 지적: 수정 후 캡처는 빈 델타로 무검토 라운드를 만든다 — D1의 REJECT 루프와 동일 순서).
  - *이미 통합(워크트리 제거됨):* **직렬 경로 수정 라운드를 재사용**하되, bound-task 규칙이 새 codex 부트스트랩을 거부하는 문제(라운드 3 지적)를 **명시적 스레드 전환**으로 푼다 — 신규 sanctioned 서브커맨드 `execution.mjs rebind-task --root <repo> --slug <slug> --task <id> --reason correction:<E-NNN>`이 기존 threadId 바인딩을 해제하고 해제 이력(구 threadId·사유·시각)을 `execution.json`에 append 기록하며(감사 가능·미소거), **동시에 `pendingRunRootBootstrap: <id>` 마커를 기록해 다음 run-root 부트스트랩의 대상 태스크를 결정적으로 지정한다**(라운드 4 지적): run workroot cwd의 codex 호출은 cwd→task 매핑이 불가능하므로, 등록 로직은 run-root(또는 멤버 workroot) cwd 호출에 대해 이 마커가 가리키는 태스크에만 threadId를 바인딩하고 **바인딩과 마커 소거를 `withStateLock` 아래 한 트랜잭션으로** 수행한다(bound∧marker-pending 조합이 존재할 수 없게). **cwd–repo 정합 검증(라운드 5 지적):** 바인딩 전에 호출 cwd(심링크 해소한 git root)가 마커 태스크의 manifest `repo` 키가 가리키는 workroot(워크스페이스 run: 센티널 `repos` 레지스트리; 단일 레포: run workroot)와 일치해야 하며, 불일치는 fail-closed — 다른 멤버 레포에서 띄운 thread가 태스크에 귀속되는 사고를 막는다. 마커가 없으면 병렬 태스크가 하나라도 building인 동안 run-root 부트스트랩 등록을 fail-closed(단일-unbound 추측 금지)하고, 마커가 이미 있는 상태의 재-rebind는 거부한다(run-root correction은 한 번에 하나). 마커의 정상 종료는 두 가지뿐: 부트스트랩 바인딩 시 원자 소거, 또는 `rebind-task --cancel --task <id> --reason approved-artifact:<postSHA>`(디스크 상태 리뷰가 새 thread 없이 APPROVE된 경우 — D6 재개표) — 취소도 해제 이력과 동일하게 append 감사 기록을 남긴다. **correction 라운드의 baseline 영속화:** 부트스트랩 codex 호출 **전에** main이 `loop.mjs capture <대상 workroot> --record <repo>/.harnie/plan/<slug>/review/<그 태스크 reviewUnit>/`로 baseline을 기록한다 — 중단 후에도 correction delta의 기준이 디스크에 남는다(D6 재개표 참조). 막는 사고: 무영향 러너들이 병렬 진행 중일 때 correction 부트스트랩의 등록이 단일-unbound 폴백에서 모호해져 no-op → 이후 correction용 codex-reply 거부. 이후 `set-task --run-status building`(보존 시맨틱) → run workroot cwd의 새 codex 호출이 정상 부트스트랩(직렬 경로의 기존 등록 규칙 그대로) → correction 반영 수정(scope는 해당 태스크의 manifest scope) → B3 확인 리뷰 → B4 verify 재실행. 제거된 태스크 워크트리는 복구하지 않는다. 이 수정으로 전체 트리가 바뀌면 **이미 APPROVE된 Final Wave 게이트의 `--artifact`(전체 트리 SHA) 바인딩이 기계적으로 무효화**되어 completion이 게이트 재실행을 강제한다 — 기존 completion 재도출 규칙 그대로. rebind-task가 막는 구체 사고: 전환 경로가 없으면 correction을 적용할 producer가 존재하지 않아 통합 완료 태스크의 결함이 영구 잔존; 전환을 비명시적으로 허용하면(자동 언바인드) 귀속 이력이 사라진다.
  - **의존 폐쇄(라운드 3 지적):** 영향 집합 = 브리프가 correction 섹션을 인용한 태스크 ∪ **그 태스크들의 manifest `deps` 하류(транз이티브)**. 하류 태스크 처리 — *미착수:* 상류 수정 반영 후 브리프 vN+1 재발급(머리말에 상류 correction 명기). *진행·완료:* 상류 수정이 run 브랜치에 병합된 뒤 해당 태스크의 **B4 verify를 재실행**한다(기계적·저비용 — 상류 행동 변화로 인한 파손을 verification[]이 잡고, run 수준 정합은 무효화된 Final Wave 게이트 재실행이 담보). 하류의 코드 자체는 correction 섹션을 인용하지 않았으므로 리빌드를 기본으로 강제하지 않는다 — verify 실패 시에만 그 태스크를 수정 대상으로 승격.
  - 무영향 태스크는 계속 진행. correction의 design-ref 섹션을 인용한 **미착수** 태스크는 spawn 전에 브리프를 vN+1로 재발급받는다.

### D4. watchdog: deny-블록에서 "캡 내 자동 연장 + 알림"으로

실측에서 대기 25h의 큰 몫이 사용자가 못 본 게이트였다. **변경:** watchdog 초과 시 main은 사용자 동의 없이 **태스크당 1회, 기본 예산의 2×까지** `watchdog-extend --reason auto-cap`으로 연장하고 알림(설치본에 알림 도구가 있으면)을 보낸다. 2× 소진 후에는 현행대로 블록·대기. 러너 폭주라는 원래 위협은 캡으로 계속 막히고(무한 연장 불가), 밤샘 블록만 제거된다. 리시트·seal/seal-verify·Stop 훅은 **무변경**(불변식 ② 의존). "리시트 대체" 방향은 채택하지 않는다: 리시트는 토큰 비용이 아니라 JSON 파일이며, 제거 시 false-done 차단이 사라진다.

### D5. 태스크 브리프 — 설계 발췌의 디스크 아티팩트화 + 전달 경계

A5 승인 직후 main이 태스크마다 `.harnie/plan/<slug>/tasks/t<id>-brief.md`를 생성한다: 머리말(rev-N·planHash·**인용 섹션 목록** — D3 영향 전파의 키) + ① manifest 엔트리(스코프·verification·난이도 모델) ② 승인 rev-N 해당 섹션 **원문 발췌**(요약 금지 — 전사 변질 방지) ③ notepad 관련 항목 ④ 빌더 위임 계약 문구. **전달 계약(DR-010):** main → 러너에는 브리프 **경로**를 전달(러너는 Read 도구로 읽는다 — 읽기 전용, run 권위 상태 아님); 러너 → 빌더에는 브리프 **원문을 codex 프롬프트에 인라인**하고 rev를 명기한다 — 빌더는 `.harnie` 경로를 일절 수령하지 않는다(기존 Builder exception 그대로, 불변식 ⑦). correction 반영 시 **새 파일**(`t<id>-brief.v2.md`)로 재발급(덮어쓰기 금지 — 러너가 어느 판을 읽었는지 귀속). ACE류 증분 플레이북은 이 브리프+errata 조합이 최소 구현 — 별도 포맷은 만들지 않는다(비목표).

### D6. 재개 프로토콜 (FR7 — 러너·main 중단 시 디스크 상태만으로 재진입)

재개 판정 입력: `execution.json`(태스크 status·threadId), 태스크 워크트리 존재·git 상태(브랜치 분기점 SHA = `harnie/<slug>` 병합기저), `<taskWt>/.harnie/review/code/`(ledger/state/round-N/baseline-N.json/thread.json), run의 review-archive(D7). 단계별 규칙:

| 관측 상태 | 재진입 |
|---|---|
| 워크트리 없음 | 러너 처음부터(create는 idempotent) |
| 워크트리 있음 · threadId unbound · 트리 clean | ③부터(baseline 재캡처 후 빌드) — 첫 codex 호출이 다시 부트스트랩 |
| threadId bound · 리뷰 상태 없음(빌드 중 사망) | baseline-1.json이 있으면 그 SHA로 delta 산출 후 ⑤ 리뷰부터; **baseline 기록도 없으면 브랜치 분기점 SHA를 baseline으로** delta(태스크 전체 변경 = 분기점 대비 diff — 워크트리는 태스크 전용이라 안전) |
| 리뷰 상태 있음 · state=REVISING | **폴백 모드면 먼저 thread.json → `bind-thread` 멱등 재바인딩으로 execution.json 등록을 복원**한 뒤, 마지막 round의 open 이슈로 `codex-reply` 수정부터 — 등록 복원 없이는 재호출이 거부된다(라운드 2 지적) |
| state=APPROVED · 미커밋 | ⑥ scope 커밋부터 |
| 커밋됨 · 미통합 | main의 통합 큐로(러너 재spawn 불필요) |
| STALLED | 기존 계약: 사용자 보고 후 `--reentry`로만 |
| *(correction 라운드)* marker pending · unbound · 트리 clean | 부트스트랩 codex 호출 재발행(마커가 대상을 계속 지정 — 바인딩 성공까지 pending 유지) |
| *(correction 라운드)* marker pending · unbound · 트리 dirty(수정이 디스크에 일부 존재) | 기록된 baseline으로 delta 산출 → 디스크 상태를 생산자 출력으로 리뷰. REJECT(추가 수정 필요)면 부트스트랩 재발행(프롬프트에 "부분 수정이 이미 트리에 있음" 명기 — baseline 영속로 귀속 유지). **APPROVE면 새 thread가 영영 필요 없으므로 `rebind-task --cancel --task <id> --reason approved-artifact:<postSHA>`로 마커를 감사 기록과 함께 취소**한 뒤 확인 리뷰·verify로 진행 — 취소 전이는 APPROVE된 라운드의 artifact에 결부되어 기록되며, 이것 없이 마커가 잔존하면 다음 run-root 호출 오귀속·후속 rebind 영구 거부가 발생한다(라운드 6 지적) |
| *(correction 라운드)* marker 소거됨 · bound · 트리 dirty(bind 후 수정 중 중단) | 일반 REVISING과 동일: bound threadId로 `codex-reply` 재개 |
| *(correction 라운드)* marker pending · bound | 존재 불가 조합(바인딩+소거가 원자 트랜잭션) — 관측되면 상태 손상으로 STOP·보고 |

main 자신의 재개는 기존 계약 그대로(모든 권위가 디스크): 새 세션이 manifest·execution.json·review 디렉터리·notepad에서 무손실 재개. 러너 재spawn은 **항상 안전해야 한다** — 위 표의 모든 진입점이 멱등이도록 러너 본문에 "시작 시 상태 판정 표를 먼저 실행"을 계약한다. W1에 중단 지점별 테스트(빌드 중·리뷰 중·커밋 전) 포함.

### D7. 유닛 리뷰 상태 보존 — `worktree.mjs remove`의 review-archive 이관

현행 remove는 태스크 워크트리의 `.harnie`를 스태시 후 **삭제**한다 — 그러면 harness-digest(FR6)의 핵심 입력(유닛별 ledger 라운드 추이·delta 사이드카 changedCount)이 run 종료 전에 소실된다(DR-008). **변경:** `worktree.mjs remove`에 **명시적 목적지 인자 `--archive-to <run workroot>`**를 추가한다 — 워크스페이스 run에서 `--repo`는 멤버 레포 workroot라 run workroot를 명령이 스스로 알 수 없기 때문(라운드 2 지적). 엔진 검증(source–target 관계까지, 라운드 3 지적): ⓐ `--archive-to`는 활성 run workroot(센티널 대조), ⓑ `--repo`가 **그 센티널이 가리키는 run의** 단일 레포 루트이거나 `repos` 레지스트리에 등록된 멤버 workroot, ⓒ `--branch`의 slug가 그 run의 slug와 일치하고 t`<id>`가 그 run의 manifest 태스크 — 셋 중 하나라도 어긋나면 fail-closed(활성 run이 복수일 때 타 run으로 리뷰 증거가 이관된 뒤 원본이 삭제되는 사고 차단). 목적지는 `<archive-to>/.harnie/plan/<slug>/review-archive/t<id>/` 고정. W1 테스트: 활성 run 2개 오지정·워크스페이스 멤버 케이스. **멱등·크래시 복구:** 이관은 임시 디렉터리로 move 후 원자 rename; 재호출 시 목적지가 이미 있고 `<taskWt>/.harnie/review/`가 없으면 "이관 완료"로 간주하고 제거만 재시도, 둘 다 있으면(중단 잔반) 임시본을 폐기하고 원본에서 재이관. 이관 실패 시 원위치 복원 후 에러(기존 스태시-복원 안전장치와 동일 원칙). `--archive-to` 미지정 시 현행 삭제 동작 유지(직렬 경로·구버전 호환). 새 포맷 없음: 이미 존재하는 ledger/state/round/사이드카/baseline 파일을 그대로 옮긴다. 아카이브는 읽기 전용 취급(guards 보호 목록의 기존 `.harnie` 쓰기 차단이 그대로 덮는다). B3 확인 리뷰가 참조하는 "태스크 리뷰 verdict·라운드 수"도 notepad 요약 대신 아카이브를 정본으로 가리킬 수 있게 된다.

### D8. 빌더 가용성 fail-fast (애든덤, 2026-08-24 fcl-hmm 인시던트 근거)

관측 사고: fcl-hmm run에서 Codex 빌더 호출이 **정확히 30분 idle timeout × 3회 연속** 무응답(코드 변경 0, `codexCalls` 0)으로 90분+watchdog 연장 2회가 소실됐다 — 세션에 붙은 codex MCP 서버 프로세스의 wedge로 추정(같은 시각 다른 세션의 codex 호출은 정상). 대응 두 겹, 새 메커니즘 최소:

- **프로브(기존 스크립트 재사용):** 러너는 첫 codex 호출 전 `node <ROOT>/scripts/probe-codex-mcp.mjs`를 1회 실행한다(20s 캡, 모델 호출 없음) — 스폰·설정·인증 계열 실패를 30분 대신 20초에 검출. 한계 명시: 프로브는 **fresh 서버**를 띄우므로 세션 서버 wedge·백엔드 장애는 못 잡는다(tools/list는 모델을 호출하지 않음).
- **재시도 캡 + 장애 분류:** idle timeout + 델타 0(트리 무변경)의 빌더 호출 실패는 기존 driver 계약(1회 재시도)까지만. **2연속 동일 패턴이면 인프라 장애로 분류** — 러너는 즉시 실패 보고로 종료하고, main은 남은 러너들의 신규 빌더 호출 spawn을 중단하고 사용자에게 알림(권고: 세션 재시작 — MCP 서버는 세션 프로세스에 붙어 있어 러너 재spawn으로는 회복되지 않는다). 블라인드 3회 재시도로 90분을 태우는 관측 사고의 재발 방지가 이 규칙이 막는 구체 사고다.

`skills/harness-digest/SKILL.md`(+ko). quality-digest와 동일한 반자동 원칙(제안만, 자동 적용 금지, rule of three)을 하네스 자체에 적용한다.

- **입력(전부 기존 산출물, 새 계측 없음):** `execution.json`(태스크별 시각·watchdog 연장), run 리뷰 유닛 + **review-archive(D7)의 태스크 유닛** ledger/state(라운드 수·blocking 추이), delta 사이드카(changedCount — 유닛 크기), errata 목록, (있으면) 세션 JSONL 토큰 통계. 읽기는 sanctioned 경로(Read 도구, `loop.mjs export`)로만.
- **절차:** ① 유닛별 비용 프로파일(라운드 수 × 크기 × 모델 티어) → ② 이상 클러스터 식별(극소 유닛 풀 루프, 라운드 3+ 반복 유형, watchdog 연장 반복, 발화 없는 지침·게이트) → ③ 후보 제안: {근거 실측 · 제안 변경(지침 문구/manifest 규칙/모델 티어) · 예상 절감 · 리스크(불변식 저촉 여부 명시)} → ④ 사람 게이트.
- **하드 가드:** NFR4 불변식에 걸리는 제안은 자동 제외가 아니라 **"불변식 저촉" 라벨로 제시만**. 스킬은 어떤 파일도 수정하지 않는다.
- 첫 입력: fcl-hmm run + 0.10.0 첫 run(전후 비교로 NFR1·2 회귀 측정 — 존재 증명 케이스).

## 4. 데이터·상태 변경 요약

- 신규: `.harnie/plan/<slug>/tasks/t<id>-brief[.vN].md`(main 작성·러너 읽기 전용), `.harnie/plan/<slug>/review-archive/t<id>/`(D7), `<taskWt>/.harnie/review/code/baseline-N.json`·`thread.json`(폴백 시), `agents/harnie-task-runner.md`(+ko), `skills/harness-digest/`(+ko).
- 변경: `execution.mjs`(D2 등록 로직·withStateLock 전면화·errata 서브커맨드·watchdog auto-cap), `guards.mjs`(복수 building 허용·errata 보호), 훅(cwd→task 매핑 또는 폴백 생략, errata-arm 바인딩), `worktree.mjs remove`(review-archive 이관), `loop.mjs capture --record`. manifest 스키마·planHash·승인 경로·loop.mjs 상태 기계(apply/ledger)는 **무변경**.
- 문서 재편: `phase-b.md`+`phase-b-parallel.md` → 러너 프로토콜 중심 재작성(B1 기본값 반전, D1 결정적 순서, D6 재개표 포함). 기계 강제와 중복인 근거 산문은 `docs/`로 이동(이동 전 항목별 "어느 훅/CLI가 강제하는가" 대응표 작성 — 2026-08-24 인계 조건 준수). 불변식 문장은 삭제·이동 금지. 영문 정본 수정 시 ko 미러 동시 갱신, plugin.json에는 영문만 등록, 버전 0.10.0.

## 5. 작업 분해 (granularity 규칙 적용 — 소형은 인접 병합)

| ID | 이름 | 산출물 | 선행 | 완료 조건 | 크기 |
|---|---|---|---|---|---|
| W0 | PoC: 러너 컨텍스트 검증 | 검증 기록 — ⓐ 서브에이전트 codex 호출의 **PreToolUse와 PostToolUse를 각각** 검증(발화 여부·cwd 페이로드 — 라운드 2 지적: Pre만 발화하는 조합에서 폴백 바인딩 순서가 관건) ⓑ 러너 frontmatter tools로 codex MCP 실호출 가능 여부 | — | D2 본선/폴백 확정 + D1 tools 계약 확정 | S |
| W1 | 엔진: D2(확정안)+D3+D4+D6+D7+`capture --record` | `execution.mjs`·`guards.mjs`·훅·`worktree.mjs`·`loop.mjs` 수정 + 테스트(동시 갱신 경합, 무승인 errata 전이 차단, 중단 지점별 재개, 아카이브 이관) | W0 | `node --test scripts/*.test.mjs hooks/*.test.mjs` 전체 통과 | L |
| W2 | 에이전트·스킬 문서 재편 | `harnie-task-runner.md`(+ko), `phase-b*.md` 재작성, SKILL.md 갱신, 브리프 생성 계약(phase-a), 산문 docs/ 이동+대응표, model-matrix·architecture.md 정합, plugin.json 0.10.0 | W1 | ko 미러 동등성, 문서 상호참조 무결(깨진 경로 0) | L |
| W3 | harness-digest 스킬 | `skills/harness-digest/SKILL.md`(+ko) | W1(D7 산출물 형태 확정 후) | fcl-hmm run을 입력으로 시범 실행해 제안 ≥1건 산출 | S |

리스크: W0 부정 결과 시 D2 폴백으로 W1 범위 소폭 증가(bind-thread + thread.json 계약). W1이 최대 유닛으로 승격(rev-1 대비 — 동시성·재개 테스트가 추가된 결과)이며, 엔진 변경은 전부 기존 파일 수정이라 신규 표면은 서브커맨드 4개(errata 3+bind-thread 조건부)와 플래그 2개에 한정된다.

## 6. [미결정]·[가정] 목록

- `[미결정]` W0 ⓐⓑ: 서브에이전트 컨텍스트의 PostToolUse 발화 여부, 러너의 codex MCP 호출 가능 여부. **양쪽 경로 모두 본 설계에 완전 명세돼 있어(W0은 선택만 한다) 구현 착수를 막는 미결정은 아니다.**
- `[미결정]` 알림 도구: 설치본별 가용성이 달라 D4 알림은 "있으면" 계약 유지.
- `[가정]` NFR2의 태스크당 러너 소요 40~80분.
- `[가정]` `rg` 설치는 사용자가 수행(0.9.1 정책 전제). 미설치여도 러너·main은 시스템 grep 폴백으로 동작하나 grep-guard 거부 메시지 마찰이 남는다.
- `[가정]` 유닛 리뷰 티어 모델을 따르는 러너의 인라인 리뷰가 별도 harnie-reviewer 위임과 동등 품질 — 첫 run의 Final Wave REJECT율로 검증, 저하 시 러너와 리뷰를 다시 분리하는 되돌림 경로(main이 reviewer 서브에이전트 위임)를 문서에 남긴다.

## 7. 아키텍처 변경 요청 (ACR — `docs/architecture.md` 대비)

| ACR | 변경 | 근거·영향 |
|---|---|---|
| ACR-1 | §5 PHASE B: "오케스트레이터가 직렬/병렬 경로를 직접 실행" → "main=플랜·통합, 태스크 실행=harnie-task-runner 서브에이전트, 병렬 기본" | 실측 지배 비용(누적 컨텍스트 재유입) 제거. B2′ 태스크별 설계 루프 제거 포함. |
| ACR-2 | §1 역할 로스터에 `harnie-task-runner` 추가(유닛 리뷰 인라인 수행, 유닛 리뷰 티어 모델) | 크로스모델 불변식은 "생산자=Codex ↔ 리뷰자=Claude"로 유지됨을 명문화. |
| ACR-3 | §7 실행 상태 강제에 errata v2(control 파일·훅 귀속 disposition)·watchdog auto-cap·review-archive 반영 | 불변식 ②(false-done)와 리시트는 무변경. |

승인 시 architecture.md 갱신은 W2에 포함된다.

## 8. (rev-1과 동일) 비목표 재확인

Agent Teams 도입 없음(실험·재개 불가), dev-quick 변경 없음, 스케줄러·의존그래프 실행기·자동 재시도 없음, 리뷰어 티어 값 변경 없음, 전역 CLAUDE.md 압축 별도, 새 추상화 계층·별도 플레이북 포맷 없음.

## 9. Revision Notes (rev-2 — DR-001~010 반영)

| ID | 처리 | 추가된 메커니즘과 그것이 막는 구체 사고 |
|---|---|---|
| DR-001 | 수용 | D1에 결정적 순서 명시(set-task는 main이 spawn 직전, baseline은 빌드 **전** `capture --record`, apply-before-next-producer 재확인, seal은 통합 시점만). 사고: 빌드 후 캡처 → 빈 델타로 리뷰 없는 라운드가 APPROVE. |
| DR-002 | 수용 | `withStateLock` 전면화 + 경합 테스트. 사고: 병렬 러너 훅 동시 발화 → 마지막-쓰기-승리로 타 태스크 threadId 유실 → codex-reply 귀속 불능. |
| DR-003 | 수용 | D6 재개 규칙표 + `capture --record`(baseline 영속화). 사고: 빌드 중 러너 사망 → baseline 소실 → 재개 시 델타 기준 부재로 전체 재빌드 또는 무검토 통합. |
| DR-004 | 수용 | 러너 모델 = 유닛 리뷰 티어(easy=sonnet, medium/hard=opus)로 정정 — "티어 값 변경 없음" 비목표와 정합. rev-1의 sonnet 고정 철회. |
| DR-005 | 수용 | frontmatter tools에 codex MCP 양 네임스페이스 명기 + W0 범위 확장(실호출 검증). 사고: allowlist 누락 → 러너가 빌드 불능인 채 배포. |
| DR-006 | 수용 | `errata-arm` + A5 동일 one-shot 훅 바인딩; CLI 단독 전이는 note만. 사고: 과잉 실행 main이 무승인으로 pending blocker를 approved 전이 → FR2·completion 동시 우회. |
| DR-007 | 수용 | 브리프 머리말의 인용 섹션 목록을 키로 한 영향 전파 규칙(실행 중/미통합/통합 3분기). 사고: correction 승인 후 구 브리프로 빌드된 태스크가 그대로 통합. |
| DR-008 | 수용 | D7 review-archive 이관(remove 확장, 기존 파일 이동뿐 새 포맷 없음). 사고: 워크트리 제거가 digest 입력을 삭제 → FR6 수행 불능. |
| DR-009 | 수용 | 폴백(bind-thread) 계약 완전 명세(검증 4항 + thread.json 전달 + 잔여 리스크 한정 근거) — W0은 구현 분기 "선택"만 남기고 미결정 아님을 §6에 명시. |
| DR-010 | 수용 | D5 전달 계약: 러너=경로 Read, 빌더=원문 인라인(rev 명기) — 빌더의 `.harnie` 비수령 불변식 ⑦로 승격. 사고: 브리프 경로를 빌더에 전달 → run 권위 디렉터리 접근 경계 붕괴. |

### rev-3 (라운드 2 잔여 반영)

| ID | 처리 | 반영 내용 |
|---|---|---|
| DR-003 | 수용 | D2에 set-task 상태 전이 시맨틱 신설: watchdog 이력(startedAt·codexCalls·extensions)은 최초 pending→building에서만 초기화, 재호출·재spawn은 보존(멱등). 사고: 재spawn 반복만으로 D4 2× 캡 우회. |
| DR-006 | 수용 | errata-arm이 disposition+correction을 함께 봉인, 훅이 원자 기록. completion은 correction 없는 approved-workaround를 blocker로 계산(이중 안전). CLI 전이는 note 전용으로 축소. 사고: 승인~correction 기록 사이 중단 → 기준 없는 항목이 해소로 계산. |
| DR-007 | 수용 | 미통합 분기 순서 정정(baseline capture → 수정 → delta). 통합 완료 태스크는 워크트리 복구 대신 **직렬 경로 수정 라운드 재사용**(기존 B2/B3 계약, 새 장치 없음) + Final Wave 게이트의 전체-트리 artifact 바인딩이 기계적으로 무효화됨을 명시. 미착수 영향 태스크는 spawn 전 브리프 재발급. |
| DR-008 | 수용 | `remove --archive-to <run workroot>`(센티널 대조 검증, 목적지 고정) + 임시-이관·원자 rename·재호출 멱등 복구 규칙. 미지정 시 현행 동작(호환). 사고: 워크스페이스 run에서 목적지 도출 불능 → FR6 입력 삭제. |
| DR-009 | 수용 | 폴백 바인딩을 **러너가 첫 codex 호출 직후·모든 codex-reply 전에** 실행하도록 이동(+thread.json은 재개용 사본, 동일 값 재바인딩 멱등). D6 REVISING 재개에 바인딩 복원 선행 명시. W0을 Pre/PostToolUse 분리 검증으로 확장. 사고: 미등록 thread의 REJECT 수정 라운드 거부·재개 불능. |

### rev-4 (라운드 3 잔여 반영)

| ID | 처리 | 반영 내용 |
|---|---|---|
| DR-007 | 수용 | 통합 완료 태스크의 correction에 **`rebind-task` 스레드 전환**(해제 이력 append 기록) → 직렬 경로 부트스트랩 재사용. 사고: 전환 경로 부재 → correction 적용할 producer 없음. **의존 폐쇄** 신설: 영향 집합에 manifest deps 하류 포함 — 미착수는 브리프 재발급, 진행·완료는 상류 병합 후 B4 verify 재실행(실패 시 수정 대상 승격). |
| DR-008 | 수용 | `--archive-to` 검증을 source–target 관계로 확장: repo가 그 run의 루트/등록 멤버인지, branch slug·task가 그 run 소속인지 fail-closed. 사고: 활성 run 2개에서 타 run으로 증거 이관 후 원본 삭제. |
| DR-011 | 수용 | 폴백 3분기 계약: Pre+Post 발화=본선 / Post만 미발화=러너가 호출마다 `record-builder-call`(시간 캡은 훅 유지) / Pre도 미발화=병렬 러너 경로 지원 불가 선언·직렬 폴백. 사고: 호출 캡 미증가·시간 캡 소실로 폭주 방어 무력화. |

### rev-5 (라운드 4 잔여 반영)

| ID | 처리 | 반영 내용 |
|---|---|---|
| DR-007 | 수용 | `rebind-task`가 `pendingRunRootBootstrap` 마커로 다음 run-root 부트스트랩의 대상 태스크를 결정적으로 지정 — 마커 없는 run-root 등록은 병렬 building 존재 시 fail-closed, 이중 rebind 거부(한 번에 하나). 사고: 병렬 진행 중 correction 부트스트랩 등록이 단일-unbound 폴백에서 모호 → no-op → codex-reply 거부. |

### rev-6 (라운드 5 잔여 반영)

| ID | 처리 | 반영 내용 |
|---|---|---|
| DR-007 | 수용 | ① 바인딩 전 cwd(해소된 git root)–마커 태스크 manifest repo workroot 일치 검증(fail-closed) — 타 멤버 레포 thread 오귀속 차단. ② 바인딩+마커 소거를 락 아래 원자 트랜잭션화(bound∧pending 조합 소거). ③ correction 부트스트랩 전 baseline `capture --record` 영속화 + D6에 correction 라운드 재개 4행(clean/dirty × bound/unbound) 추가 — FR7 충족. |

### rev-7 (라운드 6 잔여 반영)

| ID | 처리 | 반영 내용 |
|---|---|---|
| DR-007 | 수용 | 마커 종료 전이를 완결: 정상 종료 = 바인딩 시 원자 소거 또는 `rebind-task --cancel --reason approved-artifact:<postSHA>`(디스크 상태 리뷰가 새 thread 없이 APPROVE된 분기 — APPROVE artifact에 결부된 감사 기록). 사고: 마커 잔존 → 다음 run-root 호출 오귀속·후속 rebind 영구 거부. |
| DR-012 | 수용 | `capture --record`의 컨테인먼트를 이원화: positional repo의 `.harnie` 또는 활성 run workroot(센티널 검증)의 `.harnie` — 기존 R4 apply split-containment와 동일 패턴. 사고: 워크스페이스 run에서 correction baseline 기록이 컨테인먼트 검사에 막혀 FR7 재개 기준 소실. |

## 10. W0 검증 결과 (2026-08-24, PoC 완료 — D2 본선 확정)

헤드리스 Claude Code 세션(훅 로거 장착, `--mcp-config`로 codex 서버 로드) + 데스크톱 세션 이중 검증:

- **ⓐ 훅 발화:** 서브에이전트(general-purpose)가 실행한 `mcp__codex__codex` 호출에 **PreToolUse·PostToolUse 모두 발화**. 페이로드에 `agent_id`·`agent_type`(서브에이전트 식별)과 `tool_input.cwd`(codex 호출의 cwd 파라미터 원문), 최상위 `cwd`, `session_id`, `tool_use_id` 확인 — 훅 로그 원본은 PoC 스크래치(`w0/hook-log.jsonl`), 요지는 본 절이 정본.
- **ⓑ 러너의 codex 호출:** 데스크톱 세션 서브에이전트에서 실호출 SUCCESS(threadId 수신, 응답 "OK"). 헤드리스에서도 서브에이전트 호출 SUCCESS — 단 MCP 도구가 deferred 상태라 **서브에이전트가 ToolSearch로 스키마를 로드한 뒤 호출**했다 → W2의 러너 에이전트 문서에 "codex 도구가 deferred면 ToolSearch로 먼저 로드"를 1줄 계약으로 반영한다.

**판정: D2 본선(cwd→task 매핑) 확정.** 폴백(bind-thread·thread.json·record-builder-call, DR-011 분기 ⓘⓘ/ⓘⓘⓘ)은 구현하지 않는다 — 설계에는 W0 부정 결과였을 경우의 계약으로만 남긴다(사용 조건 미충족 명시). 잔여 확인 1건: 첫 0.10.0 실전 run의 A0에서 플러그인 네임스페이스(`mcp__plugin_harnie_codex__*`) 환경의 훅 발화를 같은 방식으로 1회 재확인(로거 없이 execution.json의 threadId 자동 바인딩 성공 여부로 판정 — 실패 시 그 run만 직렬 경로 폴백).
