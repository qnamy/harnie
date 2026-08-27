# harnie

**AI 서브에이전트 개발 하네스 + 스킬 허브** — Claude Code 플러그인. 한 세션에서 Claude와 Codex(GPT)를 조합해 **설계 → 설계 리뷰 → 개발 → 코드 리뷰**를 돌린다. 구독 로그인만으로 동작하며 API 키는 필요 없다.

`v0.13.0` · 테스트 282 pass / 0 fail (`node --test scripts/*.test.mjs hooks/*.test.mjs`) · MIT

핵심 전제는 하나다. **같은 모델이 자기 산출물을 리뷰하면 같은 맹점을 공유한다.** 그래서 harnie는 producer와 리뷰어를 항상 다른 프로바이더로 두고, 그 분리가 지켜졌는지를 부탁이 아니라 훅과 CLI로 강제한다.

> 이 도구들을 일상 업무에서 어떻게 운영하는가(지침 정본 단일화 · Claude/Codex 동기화 · 자동화 루틴 · 토큰 경제)는 자매 레포 [agent-ops](https://github.com/qnamy/agent-ops)에 있다.

---

## 1. 서브에이전트

각 에이전트는 `agents/`에 자기완결 문서 한 장으로 존재한다. **frontmatter는 Claude 디스패치 어댑터(모델·도구)이고 본문은 플랫폼 중립 페르소나**라서, Codex 단독 경로(`dev-solo`)는 같은 본문을 프롬프트로 주입해 쓴다. 읽기 전용 역할은 `tools` allowlist로 기계 강제된다 — 리뷰어는 파일을 쓸 수단 자체가 없다.

| 에이전트 | 역할 | 프로바이더 | 쓰기 |
|---|---|---|---|
| `harnie-scout` | 코드 탐색 — 관련 파일·심볼·패턴을 병렬로 찾아 실행 가능한 형태로 반환 | Claude (T1 기본) | ✕ |
| `harnie-designer` | 설계 producer — 경계·데이터 소유권·고비용 결정에 집중, 구현하지 않음 | Claude (T3) | 설계 문서만 |
| `harnie-builder` | 구현 — 요구를 만족하는 가장 단순하고 견고한 코드. 역스왑(Claude 개발) 구성용 | Claude | ✍️ |
| `harnie-reviewer` | 코드 리뷰어 — 크리티컬만 blocking, 스키마 형식으로 verdict 반환 | Claude | ✕ |

역할 분리의 실제 배선은 이렇다.

| 단계 | producer | 리뷰어 |
|---|---|---|
| 설계 | **Claude** (`harnie-designer`) | **Codex** (설계 리뷰) |
| 개발 | **Codex** (codex MCP, workspace-write) | **Claude** (`harnie-reviewer`) |

**모델은 본문에 이름으로 박지 않는다.** 에이전트·스킬 본문은 티어 심볼 T1~T4만 쓰고, 티어 → (Claude 모델, Codex 모델) 매핑은 [instructions/model-matrix.md](instructions/model-matrix.md) §3이 단독 소유한다. 모델 세대가 바뀌면 그 파일 하나만 고친다. 난이도가 올라가면 producer와 리뷰어가 같이 올라가되, **리뷰어는 어떤 난이도에서도 하한 아래로 내려가지 않는다.**

## 2. 스킬

`skills/`에는 실무 방법론이 누적된다. 각 스킬은 **판단·작성에만 집중하고**, 플랫폼 API 호출·투표·상태 전환 같은 실행 절차는 호출자가 담당한다. 이 분리 덕에 같은 판단 기준을 사람 리뷰와 자동 루틴이 함께 쓴다.

| 스킬 | 하는 일 |
|---|---|
| `cross-review` | 크로스모델 리뷰 계약(루프·출력 스키마·발견 수용 정책·티어 배정). 사람 주도 세션과 `dev` 파이프라인이 **같은 계약**을 공유한다 |
| `pr-review` | PR을 시니어 기준으로 리뷰해 `issue:`/`discuss:`/`nit:`로 분류하고 승인 권고를 낸다 |
| `comment-resolve` | 내가 남긴 리뷰 지적에 대한 응답이 실제 해소인지 검증해 resolve·재투표를 권고한다 |
| `deploy-approval` | 배포 승인 요청의 대상 변경을 검토해 승인/보류를 판정하고 정족수 도달 시 전진을 권고한다 |
| `quality-digest` | 누적된 리뷰 지적을 클러스터링해 lint·CI·리뷰 기준으로 승격할 후보를 제안한다(제안만) |
| `pr-delivery` | 주입된 Delivery Profile에 따라 PR 제목·본문과 리뷰요청 내용을 작성한다 |
| `confluence-doc` | 개발 문서를 Confluence 페이지로 구조화하고 Mermaid를 네이티브 렌더링해 발행한다 |
| `design-authoring` | 루프 밖 독립 설계 요청을 정본 계약으로 라우팅하는 얇은 래퍼 |
| `dev` · `dev-solo` | 개발 파이프라인 — §3 |

## 3. dev 파이프라인

`/harnie:dev "결제 실패 재시도 큐 도입"` 한 줄로 시작한다. 크기(S/M)가 스테이지 스킵의 유일한 축이다 — S는 국소 수정(설계·승인 게이트 없음), M은 설계 판단이 필요한 단일 리뷰 유닛. 판정은 잠정 → 그라운딩 후 확정이고 **상향 승격만** 존재한다.

**M보다 큰 작업은 harnie의 몫이 아니다.** ARCH 트리거가 있거나 독립 리뷰 가치가 있는 태스크가 2개 이상이면 파이프라인은 크기 판정에서 멈추고 사람 + [orca](https://github.com/stablyai/orca) 프로세스로 인계한다. 분해·디스패치·워크트리 수명주기·통합은 orca가, 품질·증거·강제화는 harnie가 소유한다.

| 시점 | 일어나는 일 (M 기준; S는 해당 스테이지 스킵) | 남는 것 |
|---|---|---|
| **진입** | bootstrap 훅이 전용 git worktree를 만들고 sentinel과 `execution.json`을 심는다. 크기·난이도를 판정하고, 그라운딩 직후·승인 직전 두 체크포인트에서 재판정한다 | 격리된 워크루트 |
| **승인 게이트(1회)** | `plan.md`의 manifest 블록 → `arm-approval` → 실제 `AskUserQuestion` one-shot 바인딩. **여기까지 소스 쓰기는 훅이 막는다** | planHash 고정 manifest |
| **상세설계 + 설계리뷰** | `harnie-designer`가 설계를 쓰고 Codex 설계 리뷰 루프를 돈다 | `review/design/design.md` |
| **빌드 + 코드리뷰** | 빌더 스레드 바인딩·워치독을 켜고 baseline/seal 후 Codex 빌드(스코프 테스트만) → 인라인 Claude 코드리뷰 루프 | 리뷰 ledger + delta |
| **검증** | `verify --task` 후 `verify --integration` — 전체 스위트는 여기서 1회, 최종 트리에 바인딩된 성공 receipt 하나만 | task/integration receipt |
| **완료** | `completion`이 완료를 재도출하고 Stop 훅이 독립 검증한다 | `HARNIE_STATUS` 정직 보고 |

`dev-solo`는 Codex 단독 완주 경로다. 생산도 리뷰도 Codex이며, 리뷰는 fresh `codex exec --sandbox read-only` 셀프리뷰 서브프로세스가 맡는다 — 크로스모델이 아니라는 점을 감수한 설계다(Claude 사용량이 소진돼도 완주하기 위한 경로).

### 무엇이 권위인가

지침이 아니라 기계다. 위협모델은 적대적 세션이 아니라 **일을 빨리 끝내려다 절차를 생략하는 over-eager 오케스트레이터의 실수**다.

- 승인 게이트 전에는 `PreToolUse` 훅이 소스 쓰기를 막는다.
- `Stop` 훅이 디스크의 권위 상태에서 완료를 독립 재도출하므로, 미완료 run을 done으로 확정할 수 없다.
- 권위는 `planHash`로 고정된 immutable manifest, 리뷰 ledger, verification receipt다. `execution.json`은 advisory 캐시일 뿐이다.
- 실제 `AskUserQuestion` 호출 관찰로만 승인을 바인딩해 자기승인을 막는다. 승인 등록은 CLI로 노출되지 않아 sanctioned Bash로도 우회할 수 없다.
- receipt가 검증 출력 증거를 캡처하므로, 테스트 0건인데 성공으로 끝나는 vacuous 성공은 완료 재도출에서 거부된다.
- 빌드 위임 직전 `seal`로 권위 스냅샷을 뜨고 `seal-verify`가 빌더의 권위 파일 훼손을 fail-closed로 잡는다.

### 자율에는 상한이 붙는다

태스크별 예산은 난이도 티어를 따른다(30분/15회 → 60분/25회). 100%에서 다음 빌더 호출을 deny하고, 태스크당 **1회에 한해 자동 연장**(총 ≤ 2×)한 뒤 사용자에게 알린다. 그 캡을 넘으면 사람이 상황을 확인해야만 계속된다.

막히면 조용히 우회하지 않는다. human-gated blocking 이슈는 정체 카운터를 태우지 않고 **즉시 escalate**하고, 결정을 못 받으면 INCOMPLETE로 끝낸다. 완료를 흉내 내지 않는다.

### 리뷰 발견을 전부 수용하지 않는다

수용/기각은 심각도가 아니라 **필요성**으로 판단한다. 구체적 실수 시나리오 없이 메커니즘 추가를 요구하거나 현재 고도를 벗어난 finding은 수정 대신 이의를 제기하고(contest), 리뷰어의 다음 응답 1회로 판정이 끝난다. 고수하면 즉시 사용자에게 올라간다. 정확성·안전 finding은 기각 대상이 아니며 종결 권한은 언제나 리뷰어와 사용자에게 있다.

---

## 이 repo는 harnie로 개발됐다

harnie의 상당 부분은 harnie 자신의 루프로 만들어졌다. 현재 히스토리 기준 **커밋 128개 중 91개가 AI co-authored**이고, 리뷰를 거친 머지 39건이 main에 들어갔다. 도구를 만드는 과정 자체가 그 도구의 E2E 테스트였던 셈이다.

이 방식으로 실제 잡힌 것들:

- 실행 상태 엔진이 Codex 리뷰 12라운드에서 승인 우회·symlink 탈출·중복 플래그 경로를 지적받고 수정됐다.
- 0.13에서 L 파이프라인을 삭제하자 Codex 리뷰가 그 삭제가 만든 fail-closed 구멍 3개를 잡았다 — 프로토타입 키를 유효 mode로 인정하던 검사, 허용집합을 검증하지 않던 컨텍스트 로더, 삭제된 경로를 계속 허용하던 빌더 cwd 가드.
- codex MCP의 on-request 승인정책이 무한대기를 유발하는 것을 찾아 서버 기동 시 `never`로 고정했다.

반대로 **걷어낸 것**도 기록해 둔다. 초기 가드 계층은 위협모델 밖의 방어까지 쌓아 올렸다가 리뷰를 거쳐 슬림화했고, 0.13에서는 실행 이력이 0인 L 파이프라인 전체를 삭제했다. 강제는 많을수록 좋은 게 아니라 위협모델에 정확히 맞아야 한다는 게 이 프로젝트에서 얻은 가장 비싼 교훈이다.

## 한계

- **적대적 세션은 막지 못한다.** 위협모델은 절차 생략이지 우회를 의도하는 공격자가 아니다.
- **워치독은 advisory이며 fail-open이다.** 예산 읽기·계산·기록이 실패하면 통과시킨다. 권위 가드의 fail-closed 동작과 다르다.
- **구독 두 개가 필요하다.** Claude Code와 `codex` CLI 로그인이 모두 있어야 크로스모델 루프가 성립한다(예외 = `dev-solo`).
- **M 파이프라인 자체가 존폐 판정 대상이다.** plain 세션 대비 우위가 없으면 해체하고 `cross-review` 스킬만 남긴다 — 기준과 마감은 [docs/m-pipeline-kill-criteria.md](docs/m-pipeline-kill-criteria.md)에 적어 두었다.

## 설치

Claude Code 플러그인이다. repo 루트가 플러그인(`.claude-plugin/plugin.json`)이고, `codex` MCP 서버(`.mcp.json`)를 함께 선언한다. 요구사항은 **Claude Code**(최신 stable)와 **`codex` CLI**(구독 로그인, API 키 불필요)다.

```bash
/plugin marketplace add qnamy/harnie
```

```bash
/plugin install harnie@harnie
```

업데이트는 `/plugin marketplace update harnie` 후 `/plugin update harnie@harnie`(적용에 재시작 필요). 터미널에서는 `claude plugin ...`으로 동일하게 실행한다. clone한 저장소는 `claude --plugin-dir ./harnie`로 바로 띄울 수 있다.

## 구성

```
harnie/
├── .claude-plugin/   # plugin.json + marketplace.json
├── .mcp.json         # codex MCP 서버 선언
├── commands/         # /harnie:dev 단일 진입점
├── agents/           # scout · designer · builder · reviewer
├── skills/           # dev · dev-solo · cross-review + 방법론 스킬
├── instructions/     # canonical 런타임 계약 (영문이 실행 정본)
├── scripts/          # loop / ledger / delta / execution / worktree / guards
├── hooks/            # 실행 상태 강제 훅 (PreToolUse · Stop · PostToolUse)
└── docs/             # 현행 계약의 설계 근거
```

영문 `*.md`가 실행 정본이고, `*-ko.md` 미러는 요청 시에만 갱신한다(영문보다 뒤처진 상태가 정상이다).

## 문서

- [docs/architecture.md](docs/architecture.md) — 에이전트·스킬·크로스모델 리뷰 루프 설계
- [docs/execution-state.md](docs/execution-state.md) — 실행 상태, 강제 훅, 권위 재도출
- [docs/enforcement-map.md](docs/enforcement-map.md) — 지침 문장 ↔ 기계 강제 대응표
- [docs/design-0.13-L-dismantle.md](docs/design-0.13-L-dismantle.md) — L 파이프라인 완전 삭제 설계
- [docs/m-pipeline-kill-criteria.md](docs/m-pipeline-kill-criteria.md) — M 파이프라인 존폐 기준
- [docs/codex-mechanisms.md](docs/codex-mechanisms.md) — codex MCP·플러그인 메커니즘과 재현 방법
- [docs/bootstrap-adherence.md](docs/bootstrap-adherence.md) — ADR: 부트스트랩 강제 · run 수명주기
- [docs/permission-prompt-reduction.md](docs/permission-prompt-reduction.md) — ADR: 좁은 훅 auto-allow

실행 규칙의 정본은 [`instructions/`](instructions/)다. 설계 문서는 이를 재서술하지 않는다.

## 라이선스

[MIT](LICENSE).
