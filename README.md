# harnie

**AI 서브에이전트 개발 하네스 + 스킬 허브** — Claude Code 플러그인. 한 세션에서 Claude와 Codex(GPT)를 조합해 **설계 → 설계 리뷰 → 개발 → 코드 리뷰**를 돌린다. 구독 로그인만으로 동작하고 API 키는 쓰지 않는다.

`v0.13.2` · 테스트 288 pass / 0 fail (`node --test scripts/*.test.mjs hooks/*.test.mjs`) · MIT

산출물의 producer와 리뷰어는 서로 다른 프로바이더에 배정한다. 자기 산출물을 리뷰하는 모델은 자기 맹점을 그대로 통과시킨다. 배정 자체는 스킬 본문과 [instructions/model-matrix.md](instructions/model-matrix.md)가 정하는 규약이고, 리뷰어가 파일을 쓰지 못하는 것은 `agents/*.md` frontmatter의 `tools` allowlist가 기계로 막는다.

> 이 도구들을 일상 업무에서 어떻게 운영하는가(지침 정본 단일화 · Claude/Codex 동기화 · 자동화 루틴 · 토큰 경제)는 자매 레포 [agent-ops](https://github.com/qnamy/agent-ops)에 있다.

---

## 1. 서브에이전트

에이전트는 `agents/`에 문서 한 장으로 존재한다. **frontmatter가 Claude 디스패치 어댑터(모델·도구)이고 본문이 플랫폼 중립 페르소나**라서, Codex 단독 경로(`dev-solo`)는 같은 본문을 프롬프트로 주입해 쓴다.

| 에이전트 | 역할 | 프로바이더 | 쓰기 |
|---|---|---|---|
| `harnie-scout` | 코드 탐색 — 관련 파일·심볼·패턴을 병렬로 찾아 실행 가능한 형태로 반환 | Claude (T1 기본) | ✕ |
| `harnie-designer` | 설계 producer — 경계·데이터 소유권·고비용 결정에 집중, 구현하지 않음 | Claude (T3) | 설계 문서만 |
| `harnie-builder` | 구현 — 요구를 만족하는 가장 단순하고 견고한 코드 | Claude | ✍️ |
| `harnie-reviewer` | 코드 리뷰어 — 크리티컬만 blocking, 스키마 형식으로 verdict 반환 | Claude | ✕ |

파이프라인의 기본 조합은 설계 = Claude 산출 → Codex 리뷰, 개발 = Codex 산출(codex MCP, `workspace-write`) → Claude 리뷰다. `harnie-builder`는 역방향 구성용으로 남아 있고 기본 흐름에서 호출되지 않는다.

에이전트·스킬 본문에는 구체 모델명을 쓰지 않고 티어 심볼 T1~T4만 쓴다. 티어 → (Claude 모델, Codex 모델) 매핑은 `model-matrix.md` §3이 단독으로 소유하므로, 모델 세대 교체는 그 파일 한 곳을 고치는 일이 된다. 난이도가 올라가면 producer와 리뷰어가 함께 올라가고, 리뷰어를 난이도에 따라 낮추는 방향은 그 표가 막는다. 문서 규약이며 훅 강제는 아니다.

## 2. 스킬

`skills/`에는 실무 방법론이 누적된다. 각 스킬은 판단과 작성만 담당하고, 플랫폼 API 호출·투표·상태 전환은 호출자에게 남긴다. 그래서 같은 판단 기준을 사람 리뷰와 자동 루틴이 함께 쓴다.

| 스킬 | 하는 일 |
|---|---|
| `cross-review` | 크로스모델 리뷰 계약(루프·출력 스키마·발견 수용 정책·티어 배정). 사람 주도 세션과 `dev` 파이프라인이 같은 계약을 참조한다 |
| `pr-review` | PR을 시니어 기준으로 리뷰해 `issue:`/`discuss:`/`nit:`로 분류하고 승인 권고를 낸다 |
| `comment-resolve` | 내가 남긴 리뷰 지적에 대한 응답이 실제 해소인지 검증해 resolve·재투표를 권고한다 |
| `deploy-approval` | 배포 승인 요청의 대상 변경을 검토해 승인/보류를 판정하고 정족수 도달 시 전진을 권고한다 |
| `quality-digest` | 누적된 리뷰 지적을 클러스터링해 lint·CI·리뷰 기준으로 승격할 후보를 제안한다(제안까지만) |
| `pr-delivery` | 주입된 Delivery Profile에 따라 PR 제목·본문과 리뷰요청 내용을 작성한다 |
| `confluence-doc` | 개발 문서를 Confluence 페이지로 구조화하고 Mermaid를 네이티브 렌더링해 발행한다 |
| `design-authoring` | 루프 밖 독립 설계 요청을 정본 계약으로 라우팅하는 얇은 래퍼 |
| `dev` · `dev-solo` | 개발 파이프라인 — §3 |

## 3. dev 파이프라인

`/harnie:dev "결제 실패 재시도 큐 도입"` 한 줄로 시작한다. 크기(S/M)가 스테이지 스킵의 유일한 축이다. S는 국소 수정(설계·승인 게이트 없음), M은 설계 판단이 필요한 단일 리뷰 유닛이다. 판정은 잠정으로 시작해 그라운딩 후 확정하고, 상향 승격만 있다.

M보다 큰 작업은 이 파이프라인이 받지 않는다. ARCH 트리거가 있거나 독립 리뷰 가치가 있는 태스크가 2개 이상이면 크기 판정에서 멈추고 사람 + [orca](https://github.com/stablyai/orca)로 인계한다. 이 경계는 `execution.mjs`의 `set-mode`가 `S|M` 외의 값을 fail-closed로 거부해 닫는다. 분해·디스패치·워크트리 수명주기·통합은 S/M을 포함한 모든 run에서 orca가 소유하고, 품질·증거·강제화는 harnie가 소유한다.

| 시점 | 일어나는 일 (M 기준; S는 해당 스테이지 스킵) | 남는 것 |
|---|---|---|
| **진입** | bootstrap 훅이 sentinel과 `execution.json`을 심는다. run root는 사용자 git repo root다. 크기·난이도를 판정하고, 그라운딩 직후·승인 직전 두 체크포인트에서 재판정한다 | 사용자 작업 트리에 놓인 run 상태 |
| **승인 게이트(1회)** | `plan.md`의 manifest 블록 → `arm-approval` → 실제 `AskUserQuestion` one-shot 바인딩. 여기까지 소스 쓰기는 훅이 막는다 | planHash 고정 manifest |
| **상세설계 + 설계리뷰** | `harnie-designer`가 설계를 쓰고 Codex 설계 리뷰 루프를 돈다 | `review/design/design.md` |
| **빌드 + 코드리뷰** | 빌더 스레드 바인딩·워치독을 켜고 baseline/seal 후 Codex 빌드(스코프 테스트만) → 인라인 Claude 코드리뷰 루프 | 리뷰 ledger + delta |
| **검증** | `verify --task` 후 `verify --integration`. 전체 스위트는 여기서 1회, 최종 트리에 바인딩된 성공 receipt 하나만 남는다 | task/integration receipt |
| **완료** | `completion`이 완료를 재도출하고 Stop 훅이 독립 검증한다 | `HARNIE_STATUS` 보고 |

`dev-solo`는 Codex 단독 완주 경로다. 생산도 리뷰도 Codex이고, 리뷰는 fresh `codex exec --sandbox read-only` 셀프리뷰 서브프로세스가 맡는다. 크로스모델 리뷰어가 없다는 것을 감수한 설계이며, Claude 사용량이 소진된 상황을 위해 존재한다.

중단된 run의 흔한 재개는 인자 없는 `/harnie:dev`다 — 활성 run의 원 프롬프트를 그대로 이어 쓴다. 소급으로 미완료 처리된 과거 run을 되살리거나 런타임을 바꿔 이어받을 때는 `/harnie:dev-resume`이 트리의 재개 가능한 run 목록과 각 run의 다음 블로커를 보여준 뒤 선택한 run으로 넘어간다.

### 권위와 강제

위협모델은 일을 빨리 끝내려다 절차를 생략하는 over-eager 오케스트레이터다(작정한 우회는 §한계).

| 막는 것 | 강제 주체 |
|---|---|
| 승인 게이트 전 소스 쓰기 | `PreToolUse` 훅 |
| 미완료 run을 done으로 확정 | `Stop` 훅이 디스크의 권위 상태에서 완료를 다시 계산 |
| 자기승인 | `AskUserQuestion` 호출 관찰로만 바인딩. 승인 등록은 CLI에 없어 허용된 Bash로도 우회 불가 |
| 테스트 0건인데 성공으로 끝나는 vacuous 성공 | receipt의 검증 출력 증거 + 완료 재도출 |
| 빌더의 권위 파일 훼손 | 빌드 위임 직전 `seal` 스냅샷, `seal-verify`가 mismatch를 fail-closed |

권위 집합은 `planHash`로 고정된 immutable manifest, 리뷰 ledger, verification receipt다. `execution.json`은 advisory 캐시이고 판정 근거로 쓰지 않는다. 어느 규범 문장이 어느 훅·CLI에 대응하는지는 [docs/enforcement-map.md](docs/enforcement-map.md)에 표로 있고, 그 표에 "문서만"으로 남은 항목은 강제되지 않는다.

### 예산

태스크별 예산은 난이도 티어를 따른다(30분/빌더 호출 15회 → 60분/25회). 100%에서 다음 빌더 호출을 deny하고, 태스크당 1회에 한해 자동 연장(총 ≤ 2×)한 뒤 사용자에게 알린다. 그 캡을 넘는 진행은 사람이 상황을 확인한 뒤에만 열린다. 워치독은 advisory이며 fail-open이다. 예산 읽기·계산·기록이 실패하면 통과시킨다.

### 리뷰 발견 처리

발견마다 고칠 필요가 있는지로 수용을 판단한다. 심각도 라벨은 근거로 쓰지 않는다. 구체적 실수 시나리오 없이 메커니즘 추가를 요구하거나 현재 고도를 벗어난 finding은 수정하는 대신 이의를 제기하고(contest), 리뷰어의 다음 응답 하나로 판정이 끝난다. 리뷰어가 고수하면 사용자에게 올라간다. 정확성·안전 finding은 기각 대상에서 빠지고, 종결 권한은 리뷰어와 사용자에게 있다. 기각한 발견은 사유와 함께 다음 라운드에 전달해 재리뷰 범위에서 뺀다.

사람 손이 필요한 blocking 이슈는 정체 카운터를 태우지 않고 즉시 escalate한다. 결정을 받지 못하면 우회하는 대신 `INCOMPLETE`로 끝낸다.

---

## 이 repo는 harnie로 개발됐다

커밋 128개 중 91개가 AI co-authored이고, 리뷰를 거친 머지 39건이 main에 들어갔다.

리뷰가 잡아낸 것:

- 실행 상태 엔진이 Codex 리뷰 12라운드에서 승인 우회·symlink 탈출·중복 플래그 경로를 지적받고 수정됐다.
- 0.13에서 L 파이프라인을 삭제하자 Codex 리뷰가 그 삭제로 열린 fail-closed 구멍 3개를 잡았다 — 프로토타입 키를 유효 mode로 인정하던 검사, 허용집합을 검증하지 않던 컨텍스트 로더, 삭제된 경로를 계속 허용하던 빌더 cwd 가드.
- codex MCP의 on-request 승인정책이 무한대기를 유발하는 것을 찾아 서버 기동 시 `never`로 고정했다.

걷어낸 것도 있다. 초기 가드 계층은 위협모델 밖의 방어까지 쌓았다가 리뷰를 거쳐 슬림화했고, 0.13에서는 어느 버전에서도 실행 이력이 0이던 L 파이프라인을 문서·엔진·테스트까지 삭제했다.

## 한계

- **적대적 세션은 막지 못한다.** 위협모델이 절차 생략이라서, 작정하고 우회하는 세션은 설계상 범위 밖이다.
- **워치독은 fail-open이다.** 승인·완료 재도출 가드만 fail-closed다.
- **구독 두 개가 필요하다.** Claude Code와 `codex` CLI 로그인이 모두 있어야 크로스모델 루프가 성립한다. 하나만 있으면 `dev-solo` 경로로 내려간다.
- **M 파이프라인 자체가 존폐 판정 대상이다.** plain 세션 대비 우위가 없으면 파이프라인을 해체하고 `cross-review` 스킬만 남긴다. 측정 항목·판정 기준·마감은 [docs/m-pipeline-kill-criteria.md](docs/m-pipeline-kill-criteria.md)에 있다.

## 설치

Claude Code 플러그인이다. repo 루트가 플러그인(`.claude-plugin/plugin.json`)이고 `codex` MCP 서버(`.mcp.json`)를 함께 선언한다. **Claude Code**(최신 stable)와 **`codex` CLI**(구독 로그인)가 필요하다.

```bash
/plugin marketplace add qnamy/harnie
```

```bash
/plugin install harnie@harnie
```

업데이트는 `/plugin marketplace update harnie` 후 `/plugin update harnie@harnie`이고 적용에 재시작이 필요하다. 터미널에서는 `claude plugin ...`으로 같은 일을 한다. clone한 저장소는 `claude --plugin-dir ./harnie`로 바로 띄운다.

## 구성

```
harnie/
├── .claude-plugin/   # plugin.json + marketplace.json
├── .mcp.json         # codex MCP 서버 선언
├── commands/         # /harnie:dev 단일 진입점 + /harnie:dev-resume(재개)
├── agents/           # scout · designer · builder · reviewer
├── skills/           # dev · dev-solo · cross-review + 방법론 스킬
├── instructions/     # canonical 런타임 계약
├── scripts/          # loop / ledger / delta / execution / guards
├── hooks/            # 실행 상태 강제 훅 (PreToolUse · Stop · PostToolUse)
└── docs/             # 현행 계약의 설계 근거
```

영문 `*.md`가 실행 정본이고 `*-ko.md` 미러는 요청 시에만 갱신한다. 미러가 영문보다 뒤처진 상태는 정상이다.

## 문서

- [docs/architecture.md](docs/architecture.md) — 에이전트·스킬·크로스모델 리뷰 루프 설계
- [docs/execution-state.md](docs/execution-state.md) — 실행 상태, 강제 훅, 권위 재도출
- [docs/enforcement-map.md](docs/enforcement-map.md) — 지침 문장 ↔ 기계 강제 대응표
- [docs/design-0.13-L-dismantle.md](docs/design-0.13-L-dismantle.md) — L 파이프라인 완전 삭제 설계
- [docs/m-pipeline-kill-criteria.md](docs/m-pipeline-kill-criteria.md) — M 파이프라인 존폐 기준
- [docs/codex-mechanisms.md](docs/codex-mechanisms.md) — codex MCP·플러그인 메커니즘과 재현 방법
- [docs/bootstrap-adherence.md](docs/bootstrap-adherence.md) — ADR: 부트스트랩 강제 · run 수명주기 · 언제 self-init이 정당한가(훅 없는 런타임의 `init`, 재개의 `handoff`)
- [docs/permission-prompt-reduction.md](docs/permission-prompt-reduction.md) — ADR: 좁은 훅 auto-allow

실행 규칙의 정본은 [`instructions/`](instructions/)다. 설계 문서는 이를 재서술하지 않는다.

## 라이선스

[MIT](LICENSE).
