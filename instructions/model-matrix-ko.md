# 모델 매트릭스 (canonical) — 설계 고도, run 난이도, 모델 배정

`harnie:dev` 파이프라인의 세 가지 결정을 소유한다: ① 설계 고도 경계, ② run 난이도 루브릭(run당 1회 판정), ③ 이들로부터 각 스테이지가 도출하는 모델. 호출 지점은 편의상 구체 이름을 재서술한다; 충돌 시 이 파일이 이긴다.

## 1. 설계 고도 (3개 레이어, 한 문서·한 루프에서 절대 섞지 않는다)

- **ARCH** — 경계, 신규 컴포넌트, 데이터 소유권, 기술 선정, 크로스 모듈/레포 계약, SPOF/스케일링 결정. L 스테이지의 아키텍처 단계에서만 생산된다(정식 프로필 `design-authoring-arch.md`, formal); 그 트리거 체크리스트가 S/M/L의 L 승격도 구동한다.
- **CONTRACT** — 태스크 분해 + 태스크 간 계약(`design-authoring-contract.md`), L 전용; 승인 게이트 산출물.
- **TASK-DETAIL** — 확정된 경계 안의 구현 설계(`design-authoring-detail.md`): L 각 태스크의 설계(그 러너가 작성)와 M의 단일 설계.

## 2. Run 난이도 — 1회 판정, run 전체 적용

**easy / medium / hard**를 (진입 시, 잠정 크기와 함께) 한 번 판정하고 고정한다; 재판정은 사용자 범위 변경 시에만. 크기(S/M/L)와 난이도는 독립 축이다.

- **easy** — 국소 변경, 알려진 패턴, 새 로직 설계 없음. *기계적(mechanical) 하위 유형:* 판단이 필요 없는 rename/미러/반복 편집.
- **medium** — 다중 파일, 기존 패턴 안의 새 로직, 중간 폭발 반경.
- **hard** — 새 모듈 또는 복잡한 로직; 동시성/보안/데이터 정합성 우려; 높은 폭발 반경 또는 비싼 롤백.

난이도는 생산자 모델을, 그리고 보수적으로 Claude 코드 리뷰어를 티어링한다. 리뷰 게이트는 절대 sonnet 아래로 내려가지 않고, 최상위 티어는 miss가 가장 비싼 곳에 둔다.

## 3. 모델 배정

**생산자 (난이도별):**

| 생산자 역할 | easy | medium | hard |
|---|---|---|---|
| Codex builder (모든 크기) | `gpt-5.6-luna` — 순수 기계적이면 `gpt-5.3-codex-spark` | `gpt-5.6-terra` | `gpt-5.6-sol` |
| Claude designer, TASK-DETAIL (M 인라인/designer; L 러너 작성) | sonnet | sonnet | opus |
| Claude designer, CONTRACT (L) | sonnet | sonnet | opus |
| Claude designer, ARCH (L, 트리거 시) | **fable** | **fable** | **fable** (폴백 opus, 플랜에 기록) |

**리뷰어 (절대 sonnet 미만 금지):**

| 리뷰어 역할 | easy | medium | hard |
|---|---|---|---|
| 코드 유닛 리뷰 (S/M 인라인 루프; L 러너 인라인) | sonnet | opus | opus |
| 확인 리뷰 (이미 게이트를 통과한 코드의 머지 후 재확인) | sonnet | sonnet | opus |
| Final Review (L, 단일 유닛 — 최후 방어선) | **opus** | **opus** | **opus** |
| 설계 리뷰어 (Codex, 모든 `DR` 루프) | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` |

**고정:** `harnie-scout` = haiku (frontmatter 고정).

**dev-solo(Codex 단독) 역전:** 모든 스테이지에서 생산자가 Codex이므로 리뷰어는 `claude -p --model <tier>`를 통한 Claude다 — **설계 리뷰(모든 고도) = opus, 잠정**(고정 Codex 설계 리뷰어와 같은 근거: 적은 볼륨, 가장 비싼 결함 클래스; 첫 solo run의 비용 실측으로 확정 또는 재티어링 예정 — design-0.11-detail.md의 open item U-3); **코드 리뷰 = 위 코드-리뷰어 행**. 자기 리뷰 폴백은 `codex exec -m gpt-5.6-sol`을 실행한다.

**메커니즘:** Codex 모델은 `codex` 호출의 `model` 파라미터(`codex-reply`는 스레드의 것을 유지); Claude 서브에이전트 티어는 지원되는 곳에서 Task 모델 오버라이드(frontmatter `opus`가 폴백). 오케스트레이터/세션 모델은 여기서 배정하지 않는다 — 품질을 짊어지는 모든 역할이 독립적으로 고정되므로, **세션 모델은 sonnet으로 충분하며 권장된다**(실측 run에서 오케스트레이터 자신의 호출이 총 토큰의 절반을 훨씬 넘었다 — 단일 최대 비용 레버).
