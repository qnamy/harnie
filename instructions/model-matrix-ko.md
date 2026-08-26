# 모델 매트릭스 (canonical) — 설계 고도, run 난이도, 모델 배정

`harnie:dev` 파이프라인의 세 가지 결정을 소유한다: ① 설계 고도 경계, ② run 난이도 루브릭(진입 시 판정, 이후 두 체크포인트에서 재판정 — §2), ③ 이들로부터 각 스테이지가 도출하는 모델. 호출 지점은 편의상 구체 이름을 재서술한다; 충돌 시 이 파일이 이긴다.

## 1. 설계 고도 (3개 레이어, 한 문서·한 루프에서 절대 섞지 않는다)

- **ARCH** — 경계, 신규 컴포넌트, 데이터 소유권, 기술 선정, 크로스 모듈/레포 계약, SPOF/스케일링 결정. L 스테이지의 아키텍처 단계에서만 생산된다(정식 프로필 `design-authoring-arch.md`, formal); 그 트리거 체크리스트가 S/M/L의 L 승격도 구동한다.
- **CONTRACT** — 태스크 분해 + 태스크 간 계약(`design-authoring-contract.md`), L 전용; 승인 게이트 산출물.
- **TASK-DETAIL** — 확정된 경계 안의 구현 설계(`design-authoring-detail.md`): L 각 태스크의 설계(그 러너가 작성)와 M의 단일 설계.

## 2. Run 난이도 — 진입 시 판정, 두 체크포인트에서 재판정

**easy / medium / hard / very hard**를 진입 시(잠정 크기와 함께) 판정한다. 이후 두 체크포인트에서 재판정한다: ① 그라운딩 직후 — 진입 시 추측과 다른 폭발 반경이 새 증거로 드러날 수 있다; ② M/L은 승인 게이트 직전; S(승인 게이트 없음)는 빌드 호출 직전 — 그 크기가 소스에 쓰기 시작하기 전 마지막 "고치기 싼" 경계다. 크기(S/M/L)와 난이도는 독립 축이다.

- **easy** — 국소 변경, 알려진 패턴, 새 로직 설계 없음. *기계적(mechanical) 하위 유형:* 판단이 필요 없는 rename/미러/반복 편집.
- **medium** — 다중 파일, 기존 패턴 안의 새 로직, 중간 폭발 반경.
- **hard** — 새 모듈 또는 복잡한 로직; 동시성/보안/데이터 정합성 우려; 높은 폭발 반경 또는 비싼 롤백.
- **very hard** — hard의 우려가 hard 자신의 모델 티어·워치독 예산으로도 부족하다고 판단되는 규모(예: 폭발 반경이 유난히 넓은 크로스커팅 엔진 변경, 또는 이 run에서 이미 뒤늦게 잡으면 비싸다고 드러난 결함 클래스). 근거를 명시했을 때만 이 등급으로 올린다 — M/L은 플랜에, S(플랜 문서 없음)는 아래 필수 한 줄 사용자 통보 자체가 근거 기록이다. "커 보이는" 작업의 기본값이 아니다.

**상향**(더 어려운 티어로)은 두 체크포인트 어디서든 자동이다: 사용자에게 한 줄로 통보하고, `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>`로 기록한다(wire 값은 하이픈을 쓴다 — 위 산문의 `very hard`가 아니라 `very-hard`; `validateManifest`/`set-difficulty`는 그 외 값을 거부한다). 이후 스테이지에만 적용된다 — `resolveTaskDifficulty()`가 매 호출마다 `execution.json`/`manifest.json`을 디스크에서 새로 읽고(캐시하지 않음), `decideWatchdog()`가 그 값으로 `guards.mjs`의 정적 테이블 `WATCHDOG_TIERS`를 조회하므로 워치독 예산 티어도 별도 배선 없이 반영된다. 즉 승인 이후 재판정("승인 이후에는 `set-difficulty`가 유일한 기록 지점" 문단의 경우)은 이미 `building` 중인 태스크의 워치독 예산에도 즉시 반영된다 — 하향 조정이 이미 사용한 호출 수보다 `maxCodexCalls`/wall-clock을 더 작게 만들면 다음 빌더 호출이 곧바로 deny될 수 있다(advisory이며 `watchdog-extend`로 복구 가능하지만 조용한 무동작은 아니다). 모델 티어의 상향은 절대 소급되지 않는다 — 체크포인트 이전에 이미 APPROVED된 리뷰 유닛은 그때 리뷰받은 모델 티어를 그대로 유지한다 — 진행 중 태스크에서 흔들릴 수 있는 것은 워치독 예산뿐, 모델은 아니다.

**하향**(더 쉬운 티어로)은 절대 자동이 아니다 — 기록된 난이도가 바뀌기 전에 명시적 `AskUserQuestion` 확인이 필요하다. 잘못된 하향은 이후 모든 스테이지의 모델/워치독 티어를 조용히 낮추기 때문이다.

`set-difficulty`는 `execution.json`의 `difficulty` 필드만 쓴다 — `manifest.json`은 절대 건드리지 않는다(그 `difficulty`는 일단 승인되면 `planHash`에 봉인된다). `taskWatchdogUsage`는 `execution.json.difficulty`를 먼저 읽고, 재판정을 한 번도 안 한 run은 승인된 `manifest.json.difficulty`로 폴백한다. **M/L은 두 체크포인트 모두 A5 승인 이전이다 — arming 전에 재판정 값을 `plan.md` 자체**(난이도 표기 + `harnie-manifest` 블록의 `"difficulty"` 필드)**에 먼저 동기화한다**: 봉인되는 manifest가 사용자가 실제로 승인하는 내용과 일치해야 하기 때문이다 — 승인 전에는 `set-difficulty`만으로 충분하지 않다(arm-approval은 `execution.json`이 아니라 `plan.md`를 읽는다). 승인 이후의 추가 재판정은 `set-difficulty`가 유일한 기록 지점이다(`plan.md`는 승인 후 다시 고치지 않는다 — 고치면 `planHash`가 어긋난다). 난이도는 생산자 모델을, 그리고 보수적으로 Claude 코드 리뷰어를 티어링한다. 리뷰 게이트는 절대 sonnet 아래로 내려가지 않고, 최상위 티어는 miss가 가장 비싼 곳에 둔다.

## 3. 모델 배정

**생산자 (난이도별):**

| 생산자 역할 | easy | medium | hard | very hard |
|---|---|---|---|---|
| Codex builder (모든 크기) | `gpt-5.6-luna` — 순수 기계적이면 `gpt-5.3-codex-spark` | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` (effort high) |
| Claude designer, TASK-DETAIL (M 인라인/designer; L 러너 작성) | sonnet | sonnet | opus | opus (effort high) |
| Claude designer, CONTRACT (L) | sonnet | sonnet | opus | opus (effort high) |
| Claude designer, ARCH (L, 트리거 시) | opus | opus | opus (effort high) | **fable**(폴백 opus, effort high — 플랜에 기록) |

**리뷰어 (절대 sonnet 미만 금지):**

| 리뷰어 역할 | easy | medium | hard | very hard |
|---|---|---|---|---|
| 코드 유닛 리뷰 (S/M 인라인 루프; L 러너 인라인) | sonnet | opus | opus | opus (effort high) |
| 확인 리뷰 (이미 게이트를 통과한 코드의 머지 후 재확인) | sonnet | sonnet | opus | opus |
| Final Review (L, 단일 유닛 — 최후 방어선) | **opus** | **opus** | **opus** | **opus** (effort high) |
| 설계 리뷰어 (Codex, 모든 `DR` 루프) | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` (effort high) |

**티어 명명 범례**(약칭 오버레이일 뿐 — 위 표가 정본): T1 = haiku/luna, T2 = sonnet/terra, T3 = opus/sol, T4 = fable/sol+high.

**고정:** `harnie-scout` = haiku (frontmatter 고정).

**effort 오버라이드 각주:** Claude 서브에이전트 스폰별 effort 오버라이드와 이에 상당하는 Codex MCP reasoning-effort 파라미터 지원 여부는 미검증이다 — 호출 지점이 둘 중 하나를 지원하지 않으면 very-hard 열은 그 지점에서 모델 상향만으로 낮춰진다(존재하지 않는 플래그를 지어내지 않는다).

**dev-solo(Codex 단독) 역전:** 모든 스테이지에서 생산자가 Codex이고, 리뷰어도 마찬가지다 — **fresh `codex exec --sandbox read-only -m gpt-5.6-sol` 셀프리뷰 서브프로세스**(very-hard에서만 effort high)가 모든 고도의 설계·코드 리뷰 전체 경로다; 대체할 크로스모델 리뷰어가 없다. 이것은 격하된 폴백이 아니다: dev-solo는 Claude 사용량/토큰이 소진됐을 때도 Codex 단독으로 개발을 이어가기 위해 존재하며, 그 시나리오에서는 크로스모델 리뷰어가 구조적으로 불가능하다 — 수용되고 문서화된 트레이드오프다(`skills/dev-solo/SKILL.md` 참고).

**메커니즘:** Codex 모델은 `codex` 호출의 `model` 파라미터(`codex-reply`는 스레드의 것을 유지); Claude 서브에이전트 티어는 지원되는 곳에서 Task 모델 오버라이드(frontmatter `opus`가 폴백). 오케스트레이터/세션 모델은 여기서 배정하지 않는다 — 품질을 짊어지는 모든 역할이 독립적으로 고정되므로, **세션 모델은 sonnet으로 충분하며 권장된다**(실측 run에서 오케스트레이터 자신의 호출이 총 토큰의 절반을 훨씬 넘었다 — 단일 최대 비용 레버).
