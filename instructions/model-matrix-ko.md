# 모델 매트릭스 (canonical) — 설계 altitude · run 난이도 · 모델 배정

이 파일은 `/harnie:dev`·`dev-quick`·`dev-full`이 공유하는 세 가지 결정을 소유한다: ① **설계 altitude** 경계(아키텍처 vs 상세), ② **run 난이도** rubric(run당 1회 판정), ③ 각 단계가 거기서 도출하는 **모델 배정**. 호출 지점들은 편의상 구체 모델명을 재기술한다; 충돌 시 이 파일이 우선한다.

## 1. 설계 altitude — 아키텍처 vs 상세 (고정 경계)

두 altitude는 한 문서·한 리뷰 루프에서 절대 섞지 않는다:

- **ARCH (아키텍처 설계):** 시스템 경계, 신규 컴포넌트/모듈/서비스, 데이터 소유권·저장소 선택, 기술 선택, 모듈 간·레포 간 계약, SPOF/확장성/가용성 결정. **dev-full A3**에서만 생산(정식 프로필, `design-authoring-arch.md`)하고 `design-review.md`의 아키텍처-altitude 렌즈로 `review/design-arch/`에서 리뷰한다.
- **DETAIL (상세 설계):** 확정된 경계 안의 구현 설계 — 특정 모듈·API·DB 스키마·처리 로직, 요구사항 추적, 작업 분해. **dev-full A4**(정식 프로필) 또는 **dev-quick Step 3**(경량 프로필, 둘 다 `design-authoring-detail.md`)에서 생산하고 상세-altitude 렌즈로 `review/design-detail/`(full) 또는 `review/design/`(quick)에서 리뷰한다.

라우팅 귀결:

- ARCH-altitude 트리거(`phases/phase-a.md`의 A3 트리거 체크리스트)가 하나라도 있으면 그 작업은 **plan 트랙**으로 간다. `dev-quick`은 구조상 DETAIL altitude만 지원한다.
- dev-full 안에서도 A3는 ARCH 트리거가 실제로 존재할 때**만** 실행한다; 아니면 곧장 A4로 간다. 근거 없는 정식 아키텍처 단계는 스코프 인플레이션이다.

## 2. run 난이도 — 1회 판정, run 전체 적용

**easy / medium / hard**를 run당 정확히 1회 판정하고 이후 고정한다:

- `/harnie:dev` 라우터 경유: 라우터가 분류 단계에서 난이도를 판정하고 트랙과 함께 announce한다.
- 직접 진입(`/harnie:dev-quick`, `/harnie:dev-full`): 트랙 스킬이 첫 단계(quick Step 1 / full A0)에서 판정하고 announce한다. dev-full은 `plan.md`에도 기록한다.
- 트랙 스킬은 라우터의 판정을 계승하고 재판정하지 않는다. 사용자가 스코프·목표를 바꿀 때(`replace` 또는 스코프를 바꾸는 `add`)만, 그 경우 이미 요구되는 스코프 재계산과 함께 재판정한다.

트랙과 난이도는 **독립 축**이다: quick 트랙 버그픽스가 medium일 수 있고, full 트랙 run이 hard가 아니라 medium일 수 있다.

Rubric (어느 신호든 정당화하는 가장 높은 티어를 선택):

- **easy** — 한 모듈·소수 파일의 국소 변경; 알려진 패턴 적용; 신규 로직 설계 없음. *기계적 하위유형:* 리네임, 미러 번역, 판단이 필요 없는 반복 편집.
- **medium** — 다파일 변경; 기존 패턴 안의 신규 로직; 일부 판단 필요; 중간 blast radius.
- **hard** — 신규 모듈 또는 복잡한 로직; 동시성·보안·데이터 정합성 우려; 열린 설계 결정 다수; 높은 blast radius 또는 비싼 롤백.

난이도는 **생산자 모델만** 티어링한다. **리뷰어 모델은 절대 티어링하지 않는다** — 리뷰는 품질 게이트이고, 게이트의 모델을 낮추면 게이트가 잡으라고 존재하는 바로 그것을 잡는 힘이 약해진다.

## 3. 모델 배정

**생산자 (run 난이도로 티어링):**

| 생산자 역할 | easy | medium | hard |
|---|---|---|---|
| Codex 빌더 (quick Step 4; full B2/B2′) | `gpt-5.6-luna` — 작업이 순수 기계적이면 `gpt-5.3-codex-spark` | `gpt-5.6-terra` | `gpt-5.6-sol` |
| Claude 설계자, DETAIL altitude (`harnie-designer`: quick Step 3; full A4) | sonnet | sonnet | opus |
| Claude 설계자, ARCH altitude (full A3 전용) | **fable** | **fable** | **fable** |

> ARCH-altitude 설계는 run 난이도와 무관하게 항상 최상위 티어(fable)를 쓴다: A3는 정확히 시스템에서 가장 비싼 결정을 위해 존재하고, A3가 트리거된 run은 이미 그 비용선을 넘었다.

**고정 역할 (티어링 없음):**

| 역할 | 모델 |
|---|---|
| 설계 리뷰어 (Codex, `DR` 루프) | `gpt-5.6-sol` |
| 코드 리뷰어 (`harnie-reviewer`, Final Wave 포함 `CR` 루프) | opus (에이전트 frontmatter에 고정) |
| 스카우트 (`harnie-scout`) | haiku (에이전트 frontmatter에 고정) |

**선택 메커니즘과 폴백:**

- **Codex 모델:** Codex MCP `codex` 호출의 `model` 파라미터로 지정한다(`codex-reply`는 스레드의 모델을 이어간다). 설치본이 모델 선택을 노출하지 않으면 설치 기본값을 쓴다 — 그것 때문에 단계를 실패시키지 않는다.
- **Claude 서브에이전트 모델:** `harnie-reviewer`·`harnie-scout`는 에이전트 frontmatter로 고정된다. `harnie-designer`(frontmatter 기본 `opus`)는 설치본이 지원하면 Task 호출의 모델 오버라이드로 티어 모델을 전달하고, 지원하지 않으면 frontmatter 기본값이 적용된다.
- **fable 폴백:** 이 설치본에서 서브에이전트에 fable을 선택할 수 없으면 A3에 `opus`를 쓰고 그 대체 사실을 `plan.md`에 기록한다.
