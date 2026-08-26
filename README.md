# harnie

**AI 서브에이전트 개발 하네스 + 스킬 허브** — Claude Code 플러그인. 한 세션에서 Claude와 Codex(GPT)를 조합해 **설계 → 설계 리뷰 → 개발 → 코드 리뷰**를 돌린다. 구독 로그인만으로 동작하며 API 키는 필요 없다.

> **v0.12.0** · 테스트 319 pass / 0 fail (`node --test scripts/*.test.mjs hooks/*.test.mjs`) · GitHub 공개, 마켓플레이스 설치 · 0.12는 난이도 4등급화(very hard 신설) + 재판정 체크포인트 + dev-solo Codex 셀프리뷰 전환

이 저장소는 두 가지 목적을 겸한다. 하나는 실제 업무에 쓰는 도구이고, 다른 하나는 **"LLM에게 개발을 맡길 때 무엇을 부탁이 아니라 기계로 강제해야 하는가"에 대한 실험 기록**이다. 아래 문서는 그 두 관점 모두에서 읽히도록 썼다.

> 이 하네스를 포함한 도구들을 일상 업무에서 어떻게 운영하는가(지침 정본 단일화 · Claude/Codex 동기화 · 자동화 루틴 · 토큰 경제)는 자매 레포 [agent-ops](https://github.com/qnamy/agent-ops)에 기록한다.

## 왜

같은 모델이 자기 산출물을 리뷰하면 같은 맹점을 공유한다. harnie는(`harnie:dev` 기준) producer와 리뷰어를 항상 다른 프로바이더로 둔다 — 예외는 dev-solo뿐이다(Codex 단독, fresh 셀프리뷰 서브프로세스로 대체; 아래 "빌드/리뷰 루프" 표 참고).

| 단계 | producer | 리뷰어 |
|---|---|---|
| 설계 | **Claude** (`harnie-designer`) | **Codex** (설계 리뷰) |
| 개발 | **Codex** (codex MCP, workspace-write) | **Claude** (`harnie-reviewer`, 코드 리뷰) |

리뷰어는 diff만 보지 않고 공유 컨텍스트(계획·의도·제약) 위에서 판단한다. 승인(open blocking 0)까지 반복하되, 재리뷰는 전체 재탐색이 아닌 증분 fix-델타와 필요한 문맥에 한정한다. 계획·상태·리뷰 receipt는 `.harnie/`에 남아 다음 단계와 resume이 읽는다.

## 한 번 돌리면 이렇게 흐른다 (0.11 단일 파이프라인)

`/harnie:dev "결제 실패 재시도 큐 도입"` 한 줄로 시작한다. 크기(S/M/L)가 스테이지 스킵의 유일한 축이다 — S는 국소 수정(설계·승인 게이트 없음), M은 설계 판단이 필요한 단일 리뷰 유닛, L은 태스크 분할이 필요한 큰 작업. 판정은 잠정→그라운딩 후 확정이고 **상향 승격만** 존재한다.

| 시점 | 일어나는 일 (L 기준; S/M은 해당 스테이지 스킵) | 남는 것 |
|---|---|---|
| **진입** | bootstrap 훅이 **전용 git worktree**를 만들고 sentinel과 `execution.json`을 심는다(`mode: sizing`). 잠정 크기·난이도를 판정한다; 그라운딩 후 크기는 `set-mode`로 확정(상향 전용)하고, 난이도는 그라운딩 직후·승인 게이트 직전 두 체크포인트에서 재판정해 `set-difficulty`로 갱신한다(상향은 자동, 하향은 `AskUserQuestion` 필요) | 격리된 워크루트 |
| **ARCH 설계** | (ARCH 트리거가 있을 때만) `harnie-designer`(난이도별 opus — hard는 effort high, very-hard만 `fable`·폴백 opus+effort-high, `model-matrix.md` §3)가 아키텍처 설계를 쓰고 **Codex 아키 리뷰 루프**를 돈다 — 아키 고도를 벗어난 finding은 contest로 기각된다 | `design/arch-rev-N.md` |
| **태스크 분할 + CONTRACT** | 분할 초안 → 태스크별 read-only 그라운딩(코드 경로·테스트·드라이버 시맨틱스) → 그 근거 위에서 **CONTRACT 문서**(태스크 간 계약 + 분할표 — 태스크마다 독립 리뷰 가치 근거 필수, 미달은 병합) 작성·Codex 리뷰 | `design/contract-rev-N.md` |
| **승인 게이트(1회)** | `plan.md`의 `harnie-manifest` 블록(검증 argv 증거 포함) → `arm-approval` → 실제 `AskUserQuestion` one-shot 바인딩. **여기까지 소스 쓰기는 훅이 막는다** | planHash 고정 `manifest.json` |
| **러너 병렬 실행** | 태스크마다 `harnie-task-runner`가 전용 worktree에서 끝까지 소유 — 증분 그라운딩 → **태스크별 상세설계 + Codex 설계리뷰** → Codex 빌드(**스코프 테스트만**) → 인라인 Claude 코드리뷰 → 커밋. main엔 exit 리포트만 돌아온다 | 태스크별 커밋 + 리뷰 ledger |
| **순차 통합** | 태스크를 하나씩 merge + 확인 리뷰 + `verify --task`. 리뷰 전이는 `scripts/loop.mjs`가 fail-closed로 고정한다 | merge + receipt + review-archive |
| **통합 검증** | `verify --integration` — **전체 테스트 스위트는 여기서 1회**, 최종 트리에 바인딩된 성공 receipt 하나만 남긴다(무변화 재실행은 엔진이 거부) | integration receipt |
| **Final Review(1유닛)** | opus 리뷰어가 coverage·quality·runtime·scope 4렌즈 체크리스트를 한 번에 본다(테스트 재실행 없음 — receipt 참조) → `completion`이 완료를 **재도출**하고 Stop 훅이 독립 검증한다. 사람이 확인할 항목은 체크리스트로 인계된다 | `HARNIE_STATUS` 정직 보고 |

빌드 위임 직전 `seal`로 권위 스냅샷을 뜨고 `seal-verify`가 빌더의 권위 파일 훼손을 fail-closed로 잡는 것은 모든 경로 공통이다.

**리뷰 기각(contest) 게이트.** 리뷰 finding이 고도를 벗어나거나(예: 아키 리뷰가 태스크 내부 구현을 요구) 구체적 실수 시나리오 없는 메커니즘 추가를 요구하면, 수정하는 대신 이의를 제기한다 — 리뷰어의 다음 응답 1회로 판정이 끝나고, 고수하면 즉시 사용자에게 올라간다. 정확성·안전 finding은 기각 대상이 아니며, 종결 권한은 언제나 리뷰어와 사용자에게 있다.

실행 중 **승인된 설계 자체의 결함**이 드러나면 append-only `design/errata.md`에 기록한다(errata v2). 이 파일은 엔진 소유 control file이라 훅이 직접 쓰기를 막고 모든 변경이 `execution.mjs`를 거치며, blocker/degrade 처분은 승인 게이트와 같은 one-shot 바인딩으로 사용자 승인을 받아야 한다. 미처분 blocker는 `completion`이 남은 블로커로 세어 완료를 막는다.

진행 중 재사용할 지식(발견된 제약·승인된 결정·검증 evidence 경로)은 `notepad.md`에 append-only로 쌓인다. 오래된 항목을 고치지 않고 `supersedes` 정정 항목을 새로 붙여 불변성과 최신성을 함께 지킨다.

## 원칙 4가지

**① 지침이 아니라 기계.** 오케스트레이터 LLM이 지침을 건너뛰어도 훅과 CLI가 실행 상태를 강제한다. 위협모델은 적대적 세션이 아니라, 일을 빨리 끝내려다 절차를 생략하는 **over-eager 오케스트레이터의 실수**다.

**② producer와 리뷰어는 항상 다른 프로바이더(dev-solo 예외), 리뷰어 모델은 절대 sonnet 아래로 내려가지 않는다.** 난이도(easy/medium/hard/very hard)는 진입 시 판정하고 그라운딩 직후·승인 게이트 직전 재판정한다 — **producer 모델**(designer·builder)을 티어링하고, **리뷰어도 이미 코드 유닛 리뷰(sonnet→opus→opus→opus+effort-high)처럼 난이도별로 다르지만, 그 방향은 절대 리뷰어를 낮추지 않는다**: 난이도가 낮아도 리뷰 품질 하한은 sonnet, 난이도가 높을수록 리뷰어도 함께 올라갈 뿐이다. dev-solo는 producer·리뷰어가 둘 다 Codex인 유일한 예외다(교차 프로바이더 리뷰어 자체가 없다).

**③ 자율에는 예산 상한이 붙는다.** 태스크별 예산은 난이도 티어를 따른다 — easy·medium은 wall-clock 30분/빌더 Codex 호출 15회, hard·very hard는 60분/25회. 80%에서 마무리·보고를 경고하고 100%에서 다음 빌더 호출을 deny한다. deny 후에는 태스크당 **1회에 한해 자동 연장**(총 예산 ≤ 2×)하고 사용자에게 알린다. 그 캡을 넘으면 진행 상황과 블로커를 사용자에게 먼저 드러내고 동의 근거를 `--reason`으로 남겨야만 계속된다.

**④ 막히면 조용히 우회하지 않고 사람을 부른다.** human-gated blocking 이슈는 정체 카운터를 태우지 않고 **즉시 사용자에게 escalate**한다. 사용자 결정을 받으면 resolved + needs-human-action으로 보고하고, 못 받으면 INCOMPLETE로 끝낸다. 완료를 흉내 내지 않는다.

## 강제 계층 — 무엇이 권위인가

- 승인 게이트 전에는 `PreToolUse` 훅이 소스 쓰기를 막는다.
- `Stop` 훅은 디스크의 권위 상태에서 완료를 독립 재도출하므로, 미완료 run을 done으로 확정할 수 없다.
- 권위는 `planHash`로 고정된 immutable manifest, 리뷰 ledger, verification receipt다. `execution.json`은 advisory 캐시일 뿐 신뢰하지 않는다.
- 실제 `AskUserQuestion` 호출 관찰로만 승인을 바인딩해 자기승인을 막는다. 승인 등록은 CLI로 노출되지 않아 sanctioned Bash로도 우회할 수 없다.
- receipt는 검증 출력 증거를 캡처한다. 그래서 테스트가 0건인데 성공으로 끝나는 식의 vacuous 성공은 완료 재도출에서 거부된다.
- 테스트 증거 규칙: 변경 후 실패는 baseline 실패의 부분집합이어야 하고, 새로 추가한 테스트는 fail-capability(고장을 실제로 잡는지)를 증명해야 한다. 위반 시 코드 리뷰 게이트가 REJECT한다.

이 강제 계층도 크로스-모델 리뷰로 다듬었다. 실행 상태 엔진은 Codex 코드리뷰 12라운드에서 승인 우회, symlink 탈출, 중복 플래그 같은 실제 우회 경로를 발견·수정한 뒤 승인됐고, 위협모델 밖의 과잉 방어는 가드 슬림화로 걷어냈다.

## 병렬·멀티레포 실행

각 run은 별도 git worktree에서 실행되어 세션 간 충돌 없이 병렬로 진행할 수 있다. L 파이프라인에서는 스코프가 겹치지 않는 태스크마다 `harnie-task-runner`가 **태스크별 worktree**에서 상세설계·빌드·유닛 리뷰를 끝내고, main이 순차 merge한다. 각 태스크는 머지 전에 유닛 리뷰를, 머지 후에 확인 라운드를 통과해야 하며, 유닛 리뷰 기록은 worktree 제거 시 `review-archive/`로 이관돼 `harness-digest`의 입력이 된다.

**워크스페이스 run(멀티레포).** 루트가 git 저장소가 아니어도 직속 하위에 repo가 있으면 진입할 수 있다. 계획이 건드릴 repo를 `repo-add`로 등록하면 repo마다 전용 worktree가 생기고, manifest의 각 task가 `repo` 키에 바인딩된다(all-or-none — 미등록 키는 승인 시 fail-closed). Final Wave 게이트는 등록된 모든 repo의 tree에서 만든 합성 아티팩트(`ws:<sha256>`)에 묶여, 어느 repo가 바뀌든 게이트가 무효화된다. 워크스페이스 루트에는 sentinel을 만들지 않아 다른 세션·작업이 게이트되지 않는다.

## 빌드/리뷰 루프

| 진입점 | 동작 |
|---|---|
| `/harnie:dev "<작업>"` | **단일 파이프라인** — 크기(S/M/L)를 판정해 스테이지를 스킵하며 완주. 유일한 개발 진입점 |
| `dev-solo` (Codex 스킬) | Codex 단독 완주 — 생산도 리뷰도 Codex: 리뷰는 fresh `codex exec --sandbox read-only` 셀프리뷰 서브프로세스(cross-model 아님 — Claude 구독 소진 시에도 완주하기 위한 설계상 트레이드오프) |

## 스킬 허브

빌드 루프 외에도 실무 방법론 스킬이 `skills/`에 누적된다. 각 스킬은 **판단·작성**에 집중하고, 플랫폼 API 호출·투표·상태 전환 같은 실행 절차는 호출자와 환경 지침이 담당한다. 이 분리 덕에 같은 판단 기준을 사람 리뷰와 자동 루틴이 함께 쓴다.

| 스킬 | 하는 일 |
|---|---|
| `dev` | 단일 파이프라인 오케스트레이터 — 그라운딩 → (아키·CONTRACT 설계+리뷰) → 승인 → 실행 → 코드 리뷰 → 통합 검증 → Final Review, 크기별 스테이지 스킵 |
| `dev-solo` | Codex 단독 파이프라인 — 같은 게이트, 리뷰는 fresh Codex 셀프리뷰 서브프로세스(cross-model 리뷰어 없음 — Codex 단독 완주를 위한 설계) |
| `pr-review` | PR을 시니어 기준으로 리뷰해 `issue:`/`discuss:`/`nit:`로 분류하고 승인 권고를 낸다 |
| `comment-resolve` | 내가 남긴 리뷰 지적에 대한 응답이 실제로 해소인지 검증해 resolve·재투표를 권고한다 |
| `deploy-approval` | 배포 승인 요청의 대상 변경을 검토해 승인/보류를 판정하고 정족수 도달 시 전진을 권고한다 |
| `quality-digest` | 누적된 리뷰 지적을 클러스터링해 lint·CI·리뷰 기준으로 승격할 후보를 제안한다 (제안만, 자동 변경 없음) |
| `harness-digest` | 끝난 `harnie:dev` run의 실행 상태·리뷰 ledger·아카이브된 유닛 리뷰를 분석해 하네스 개선(지침 프루닝·granularity·티어 조정)을 실측 근거와 함께 제안한다 (제안만) |
| `pr-delivery` | 주입된 Delivery Profile에 따라 PR 제목·본문과 리뷰요청 내용을 작성한다 |
| `confluence-doc` | 개발 문서를 Confluence 페이지로 구조화하고 Mermaid를 네이티브 렌더링해 발행한다 |
| `design-authoring` | 루프 밖 독립 설계 요청을 정본 계약(`agents/harnie-designer.md` + `instructions/design-authoring-{arch,detail}.md`)으로 라우팅하는 얇은 래퍼 |

## 이 repo는 harnie로 개발됐다

harnie의 상당 부분은 harnie 자신의 루프로 만들어졌다. 현재 히스토리 기준 **커밋 87개 중 58개가 AI co-authored**이고, `claude/*` 브랜치에서 **리뷰를 거친 머지 24건**(GitHub PR 14건 + 로컬 머지 10건)이 main에 들어갔다. 도구를 만드는 과정 자체가 그 도구의 E2E 테스트였던 셈이다.

이 방식으로 실제 잡힌 것들:

- 실행 상태 엔진이 Codex 리뷰 12라운드에서 승인 우회·symlink 탈출·중복 플래그 경로를 지적받고 수정됐다.
- 컨텍스트 오버플로가 드러나 `dev-full` SKILL을 phase별 파일로 분할하고, 위임 프롬프트 인라인 주입을 경로+Read 지시로 전환했다.
- codex MCP의 on-request 승인정책이 무한대기를 유발하는 것을 찾아 서버 기동 시 `never`로 고정했다.
- owner 미기록 stale run이 무관한 세션의 쓰기를 잠그는 버그가 나와 폴백을 고쳤다.

반대로 **걷어낸 것**도 기록해 둔다. 초기 가드 계층은 위협모델(over-eager 오케스트레이터의 실수) 밖의 방어까지 쌓아 올렸다가, 리뷰를 거쳐 슬림화했다. 강제는 많을수록 좋은 게 아니라 위협모델에 정확히 맞아야 한다는 게 이 프로젝트에서 얻은 가장 비싼 교훈이다.

## 한계와 비용

솔직한 경계선이다.

- **적대적 세션은 막지 못한다.** 위협모델은 절차를 생략하는 실수이지 우회를 의도하는 공격자가 아니다. 작정하면 뚫리는 지점이 있고, 그건 설계상 감수한 범위다.
- **워치독은 advisory이며 fail-open이다.** 예산 읽기·계산·기록이 실패하면 통과시킨다. 권위 가드(승인·완료 재도출)의 fail-closed 동작과 다르다.
- **구독 두 개가 필요하다(`harnie:dev`).** Claude Code와 `codex` CLI 로그인이 모두 있어야 크로스-모델 루프가 성립한다. 하나만으로는 producer/리뷰어 분리가 무너진다. **예외 = dev-solo**: Codex 로그인만으로 완주한다(리뷰도 fresh Codex 셀프리뷰) — Claude 사용량/토큰이 소진됐을 때를 위한 경로다.
- **태스크 하나의 상한은 티어 기본 30분/15회(hard·very hard 60분/25회), 자동 연장을 합쳐 최대 2×다.** 이보다 큰 태스크는 분해 대상이지 예산 연장 대상이 아니다. 캡 밖의 연장은 사람이 상황을 확인한 뒤에만 열린다.
- **작은 수정에 설계·승인 게이트는 과하다.** 크기 판정이 S로 확정되면 두 게이트를 스킵한다 — 대신 리뷰와 정직 보고는 S에서도 생략되지 않는다.
- **Codex 빌더는 `.harnie/`를 읽지 않는다.** 승인된 계약은 태스크 브리프로 발췌해 빌더 프롬프트에 인라인 주입하고, 표준 빌더 규칙은 플러그인 경로의 `builder-contract.md`를 Read하게 한다(경로 참조 — 실측 검증됨).
- **워크스페이스 run은 직속 하위 repo만 본다.** 임의 깊이의 중첩 구조는 대상이 아니다.
- **resume은 디스크 상태 재도출 기준이다.** 살아 있는 세션의 연속성은 최적화일 뿐 보장 대상이 아니다. 러너·main 어느 쪽이 중단돼도 디스크 상태만으로 재진입하며, 러너 respawn은 임의 중단 지점에서 안전하도록 설계돼 있다.

## 설치

Claude Code 플러그인이다. repo 루트가 플러그인(`.claude-plugin/plugin.json`)이고, `codex` MCP 서버(`.mcp.json`)를 함께 선언한다.

**마켓플레이스 설치:**

```bash
/plugin marketplace add qnamy/harnie
```

```bash
/plugin install harnie@harnie
```

**업데이트:** 새 버전이 push되면 마켓플레이스 메타데이터를 갱신한 뒤 플러그인을 업데이트한다. 적용에는 Claude Code 재시작이 필요하다.

```bash
/plugin marketplace update harnie
```

```bash
/plugin update harnie@harnie
```

터미널에서는 `claude plugin marketplace update harnie` · `claude plugin update harnie@harnie`로 동일하게 실행할 수 있다.

**로컬 로드:** clone한 저장소에서 다음처럼 실행할 수도 있다.

```bash
claude --plugin-dir ./harnie
```

### 요구사항

- **Claude Code** (최신 stable)
- **`codex` CLI** — 구독 로그인. 설계 리뷰어와 코드 빌더로 `codex mcp-server`를 사용한다(API 키 불필요).

## 구성

```
harnie/
├── .claude-plugin/             # plugin.json + 라이브 marketplace.json
├── .mcp.json                    # codex MCP 서버 선언
├── commands/                    # /harnie:dev 단일 진입점 (영문 정본 + *-ko.md 미러)
├── skills/                      # dev(단일 파이프라인)·dev-solo + 방법론 스킬
├── agents/                      # harnie-scout · designer · builder · reviewer · task-runner (영문 정본 + *-ko.md 미러)
├── instructions/                # canonical 런타임 계약(영문 실행 정본), 한국어 미러 포함
├── scripts/                     # loop / ledger / delta / execution / worktree / guards
├── hooks/                       # 실행 상태 강제 훅(PreToolUse · Stop · PostToolUse)
└── docs/                        # 설계·ADR 문서
```

## 모델 교체

스테이지별 모델 배정의 단일 정본은 [instructions/model-matrix.md](instructions/model-matrix.md) §3이다. 같은 provider 안에서 모델을 갈아끼우려면(예: Codex 빌더의 medium 티어 변경, 설계자 sonnet → opus) **이 파일의 표만 수정하면 된다** — 콜사이트는 이 파일을 참조할 뿐이며 충돌 시 이 파일이 이긴다. 수정 시 두 가지만 지킨다.

- **리뷰어 모델은 난이도에 따라 낮아지는 방향으로는 절대 티어링하지 않는다.** 코드 유닛 리뷰는 이미 난이도별로(sonnet→opus→opus→opus+effort-high) 달라지고, very hard 신설이 그 상한을 더 뚜렷하게 만들 뿐이다(`model-matrix.md` §3). `agents/harnie-reviewer.md` frontmatter의 `opus`는 **고정값이 아니라, Task 모델 오버라이드가 적용되지 않는 호출 지점의 폴백값**이다(`model-matrix.md`의 Mechanics 문단 참고) — 그쪽을 바꾸려면 오버라이드가 실제로 적용되는지부터 확인한다.
- **한국어 미러(`model-matrix-ko.md`)를 같이 갱신한다.**

provider 자체를 바꾸는 것(다른 AI CLI 추가)은 이 범위가 아니다 — 루프 코어는 provider-agnostic이지만 리뷰어 호출과 빌더 호출 지점의 배선 작업이 필요하다.

## 문서

- [docs/architecture.md](docs/architecture.md) — 스킬·에이전트·크로스-모델 리뷰 루프 설계
- [docs/execution-state.md](docs/execution-state.md) — 실행 상태, 강제 훅, 권위 재도출
- [docs/enforcement-map.md](docs/enforcement-map.md) — 지침 문장 ↔ 기계 강제 대응표 (문서 경량화의 선행 산출물)
- [docs/design-0.11-process.md](docs/design-0.11-process.md) · [docs/design-0.11-detail.md](docs/design-0.11-detail.md) — 0.11 단일 파이프라인 재설계(아키텍처 + 상세; 각 5라운드 Codex 리뷰 APPROVE)
- [docs/design-0.10-restructure.md](docs/design-0.10-restructure.md) — 상세 설계: dev-full 0.10 플랜-분배-병렬-통합 재편(0.11로 대체, 이력)
- [docs/codex-mechanisms.md](docs/codex-mechanisms.md) — codex MCP·플러그인 메커니즘과 재현 방법
- [docs/bootstrap-adherence.md](docs/bootstrap-adherence.md) — ADR: 진입점 재편과 부트스트랩 강제
- [docs/permission-prompt-reduction.md](docs/permission-prompt-reduction.md) — ADR: 좁은 훅 auto-allow

실행 규칙의 정본은 [`instructions/`](instructions/)다. 이 디렉터리의 영문 문서가 런타임 계약이며, 설계 문서는 이를 재서술하지 않는다.

## 라이선스

[MIT](LICENSE).
