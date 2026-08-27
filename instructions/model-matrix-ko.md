# 모델 매트릭스 (canonical) — 설계 고도, run 난이도, 모델 배정

`harnie:dev` 파이프라인의 세 가지 결정을 소유한다: ① 설계 고도 경계, ② run 난이도 루브릭(진입 시 판정, 이후 두 체크포인트에서 재판정 — §2), ③ 이들로부터 각 스테이지가 도출하는 모델. 호출 지점은 편의상 구체 이름을 재서술한다; 충돌 시 이 파일이 이긴다.

## 1. 설계 고도 (2개 레이어, 한 문서·한 루프에서 절대 섞지 않는다)

- **ARCH** — 경계, 신규 컴포넌트, 데이터 소유권, 기술 선정, 크로스 모듈/레포 계약, SPOF/스케일링 결정(정식 프로필 `design-authoring-arch.md`). 어떤 run 밖에서도 독립 `design-authoring` 스킬이 생산한다; 그 트리거 체크리스트는 `harnie:dev`에 어떤 작업이 **M보다 크고** 사람 + orca 프로세스 소관임을 알리는 역할도 겸한다.
- **TASK-DETAIL** — 확정된 경계 안의 구현 설계(`design-authoring-detail.md`): M의 단일 설계, 그리고 임의의 독립 상세 설계.

## 2. Run 난이도 — 진입 시 판정, 두 체크포인트에서 재판정

**easy / medium / hard / very hard**를 진입 시(잠정 크기와 함께) 판정한다. 이후 두 체크포인트에서 재판정한다: ① 그라운딩 직후; ② M은 승인 게이트 직전 — S(승인 게이트 없음)는 빌드 호출 직전. 크기(S/M)와 난이도는 독립 축이다.

- **easy** — 국소 변경, 알려진 패턴, 새 로직 설계 없음. *기계적(mechanical) 하위 유형:* 판단이 필요 없는 rename/미러/반복 편집.
- **medium** — 다중 파일, 기존 패턴 안의 새 로직, 중간 폭발 반경.
- **hard** — 새 모듈 또는 복잡한 로직; 동시성/보안/데이터 정합성 우려; 높은 폭발 반경 또는 비싼 롤백.
- **very hard** — hard의 우려가 hard 자신의 모델 티어·워치독 예산으로도 부족하다고 판단되는 규모. 근거를 명시했을 때만 이 등급으로 올린다 — M은 플랜에, S는 아래 필수 한 줄 사용자 통보 자체가 근거 기록이다. "커 보이는" 작업의 기본값이 아니다.

**MUST**

- 더 어려운 티어로 상향할 때: 사용자에게 한 줄로 통보한 뒤, `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>`로 기록한다(wire 값은 하이픈을 쓴다 — `very-hard`; 그 외 값은 거부된다).
- M은 두 체크포인트 모두 A5 승인 이전이다: **arming 전에** 재판정 값을 `plan.md` 자체(난이도 표기 + `harnie-manifest` 블록의 `"difficulty"`)에 먼저 동기화한다 — 승인 전에는 `set-difficulty`만으로는 바인딩되지 않는다.

**NEVER**

- 명시적 `AskUserQuestion` 확인 없이 더 쉬운 티어로 하향하지 않는다 — 잘못된 하향은 이후 모든 스테이지의 모델·워치독 티어를 조용히 낮춘다.
- 승인 후 `plan.md`를 다시 고치지 않는다(`planHash`가 어긋난다); 승인 후에는 `set-difficulty`가 유일한 기록 지점이다.
- 이미 APPROVED된 리뷰 유닛에 재판정을 소급 적용하지 않는다 — 그 유닛은 리뷰받았던 티어를 유지한다.

난이도는 생산자 모델을, 그리고 보수적으로 Claude 코드 리뷰어를 티어링한다; 리뷰 게이트는 절대 sonnet 아래로 내려가지 않는다. 위 내용의 **엔진 배선**(어느 파일에 어느 명령이 쓰는지, 워치독 재판독 시맨틱, 진행 중 태스크에 하향 변경이 미치는 즉시 효과)은 `docs/execution-state.md` §12에 있다.

## 3. 모델 배정

**이 파일이 티어 → (Claude 모델, Codex 모델) 매핑을 단독 소유한다.** 에이전트 본문(`agents/*.md`)과 스킬 본문(`skills/*/SKILL.md`)은 구체 모델명이 아니라 **티어 심볼 T1~T4만** 쓴다 — 모델 세대 교체가 이 파일 한 곳의 편집으로 끝나게 하기 위해서다. 유일한 예외는 에이전트 frontmatter의 `model:` 필드다 — 이는 산문이 아니라 Claude 디스패치 어댑터이며 구체 이름을 쓴다.

| 티어 | Claude | Codex |
|---|---|---|
| T1 | haiku | `gpt-5.6-luna`(순수 기계적이면 `gpt-5.3-codex-spark`) |
| T2 | sonnet | `gpt-5.6-terra` |
| T3 | opus | `gpt-5.6-sol` |
| T4 | fable(폴백: opus, effort high) | `gpt-5.6-sol` (effort high) |

**생산자 (난이도별):**

| 생산자 역할 | easy | medium | hard | very hard |
|---|---|---|---|---|
| Codex builder (모든 크기) | `gpt-5.6-luna` — 순수 기계적이면 `gpt-5.3-codex-spark` | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` (effort high) |
| Claude designer, TASK-DETAIL (M 인라인/designer; 독립 상세 설계) | sonnet | sonnet | opus | opus (effort high) |
| Claude designer, ARCH (독립 `design-authoring`) | opus | opus | opus (effort high) | **fable**(폴백 opus, effort high — 플랜에 기록) |

**리뷰어 (절대 sonnet 미만 금지):**

| 리뷰어 역할 | easy | medium | hard | very hard |
|---|---|---|---|---|
| 코드 유닛 리뷰 (S/M 인라인 루프) | sonnet | opus | opus | opus (effort high) |
| 확인 리뷰 (이미 게이트를 통과한 코드의 머지 후 재확인) | sonnet | sonnet | opus | opus |
| 설계 리뷰어 (Codex, 모든 `DR` 루프) | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` (effort high) |

**탐색(`harnie-scout`):** 기본 **T1**; 탐색에 의미적/구조적 판단이 필요하면 **T2**. 축은 검색량이 아니라 판단 밀도다 — 호출자가 콜마다 티어를 고른다.

**effort 오버라이드:** Codex 호출 지점에서만 가능(`config: {model_reasoning_effort: "high"}`); Claude 서브에이전트는 effort 필드가 없어 Claude very-hard 티어는 모델 승급으로만 표현한다. 실측과 오타 주의사항: `docs/codex-mechanisms.md`.

**dev-solo(Codex 단독):** 생산자와 리뷰어가 둘 다 Codex다 — fresh `codex exec --sandbox read-only -m gpt-5.6-sol` 셀프리뷰 서브프로세스(effort high는 very-hard에서만)가 모든 고도에서 리뷰 경로 전체를 담당한다. 크로스모델 리뷰어가 없는 이유: `skills/dev-solo/SKILL.md`.

**메커니즘:** Codex 모델은 `codex` 호출의 `model` 파라미터(`codex-reply`는 스레드의 것을 유지); Claude 서브에이전트 티어는 지원되는 곳에서 Task 모델 오버라이드(frontmatter `opus`가 폴백). 오케스트레이터/세션 모델은 여기서 배정하지 않는다 — 품질을 짊어지는 모든 역할이 독립적으로 고정되므로 **세션 모델은 sonnet으로 충분하며 권장된다**.
