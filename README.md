# harnie

**AI 서브에이전트 개발 하네스 + 스킬 허브** — Claude Code 플러그인. 한 세션에서 Claude와 Codex(GPT)를 조합해 **설계 → 설계 리뷰 → 개발 → 코드 리뷰**를 돌린다. 구독 로그인만으로 동작하며 API 키는 필요 없다.

> 상태: **v0 완료**. GitHub 공개, 마켓플레이스 설치, 라이브 E2E 검증을 마쳤다.

## 왜

같은 모델이 자기 산출물을 리뷰하면 같은 맹점을 공유한다. harnie는 producer와 리뷰어를 항상 다른 프로바이더로 둔다.

| 단계 | producer | 리뷰어 |
|---|---|---|
| 설계 | **Claude** (`harnie-designer`) | **Codex** (설계 리뷰) |
| 개발 | **Codex** (codex MCP, workspace-write) | **Claude** (`harnie-reviewer`, 코드 리뷰) |

리뷰어는 diff만 보지 않고 공유 컨텍스트(계획·의도·제약) 위에서 판단한다. 승인(open blocking 0)까지 반복하되, 재리뷰는 전체 재탐색이 아닌 증분 fix-델타와 필요한 문맥에 한정한다. 계획·상태·리뷰 receipt는 `.harnie/`에 남아 다음 단계와 resume이 읽는다.

## 무엇이 다른가 — 지침이 아니라 기계

오케스트레이터 LLM이 지침을 건너뛰어도 훅과 CLI가 실행 상태를 강제한다. 위협모델은 적대적 세션이 아니라, 일을 빨리 끝내려다 절차를 생략하는 **over-eager 오케스트레이터의 실수**다.

- 승인 게이트 전에는 `PreToolUse` 훅이 소스 쓰기를 막는다.
- `Stop` 훅은 디스크의 권위 상태에서 완료를 독립 재도출하므로, 미완료 run을 done으로 확정할 수 없다.
- 권위는 `planHash`로 고정된 immutable manifest, 리뷰 ledger, verification receipt다.
- 실제 `AskUserQuestion` 호출 관찰로만 승인을 바인딩해 자기승인을 막는다.
- receipt는 검증 출력 증거를 캡처한다. 그래서 테스트가 0건인데 성공으로 끝나는 식의 vacuous 성공은 완료 재도출에서 거부된다.

리뷰 전이도 LLM의 선언이 아니라 `scripts/loop.mjs`가 fail-closed로 고정한다: `REVIEWING → APPROVED | REVISING | STALLED`. ledger 정합을 확인하고, 리뷰어에게는 증분 fix-델타만 다시 보낸다.

각 run은 별도 git worktree에서 실행되어 세션 간 충돌 없이 병렬로 진행할 수 있다. `dev-full`은 스코프가 겹치지 않는 태스크를 태스크별 worktree에서 병렬 빌드한 뒤 순차 merge한다. 난이도(easy/medium/hard)는 run마다 한 번만 판정해 producer 모델(designer·builder)에만 티어링하고, 리뷰어 모델은 티어링하지 않아 리뷰 품질을 고정한다.

이 강제 계층도 크로스-모델 리뷰로 다듬었다. 실행 상태 엔진은 Codex 코드리뷰 12라운드에서 승인 우회, symlink 탈출, 중복 플래그 같은 실제 우회 경로를 발견·수정한 뒤 승인됐고, 위협모델 밖의 과잉 방어는 가드 슬림화로 걷어냈다. 설치된 플러그인으로 full cycle(승인 게이트·크로스-모델 루프·완료 재도출)과 태스크 2개 병렬 빌드 E2E를 통과했으며, 테스트 스위트는 `node --test scripts/*.test.mjs hooks/*.test.mjs` 기준 **229 pass**다.

## 빌드/리뷰 루프

| 진입점 | 동작 |
|---|---|
| `/harnie:dev "<작업>"` | 라우터 커맨드 — 크기를 분류해 `dev-quick`/`dev-full`로 자동 라우팅하고 사용자 override를 받음 |
| `/harnie:dev-quick "<작업>"` | 작은 작업(장애·수정)용 스킬: 인라인 경량 실행 + 단계별 크로스-모델 리뷰 |
| `/harnie:dev-full "<작업>"` | 큰 작업(신규·구조변경)용 스킬: 계획 → 설계 리뷰 → 승인 게이트 → 오케스트레이션 → 코드 리뷰 → 최종 웨이브(Coverage·Quality·Runtime·Scope) |

`quick`과 `plan`은 내부 track 값으로만 남고, 사용자가 직접 호출하는 트랙 스킬은 `dev-quick`과 `dev-full`이다.

## 스킬 허브

빌드 루프 외에도 실무 방법론 스킬이 `skills/`에 누적된다. 판단·작성 역할에 집중하며, 실행 절차는 호출자와 환경 지침이 담당한다.

`pr-review` · `comment-resolve` · `deploy-approval` · `quality-digest` · `pr-delivery` · `confluence-doc` · 트랙 오케스트레이터 `dev-quick` · `dev-full`

## 설치

Claude Code 플러그인이다. repo 루트가 플러그인(`.claude-plugin/plugin.json`)이고, `codex` MCP 서버(`.mcp.json`)를 함께 선언한다.

**마켓플레이스 설치:**

```bash
/plugin marketplace add qnamy/harnie
/plugin install harnie@harnie
```

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
├── commands/                    # /harnie:dev 라우터 (영문 정본 + *-ko.md 미러)
├── skills/                      # dev-full·dev-quick 오케스트레이터 + 방법론 스킬
├── agents/                      # harnie-scout · designer · builder · reviewer (영문 정본 + *-ko.md 미러)
├── instructions/                # canonical 런타임 계약(영문 실행 정본), 한국어 미러 포함
├── scripts/                     # loop / ledger / delta / execution / worktree / guards
├── hooks/                       # 실행 상태 강제 훅(PreToolUse · Stop · PostToolUse)
└── docs/                        # 설계·ADR 문서
```

## 문서

- [docs/architecture.md](docs/architecture.md) — 스킬·에이전트·크로스-모델 리뷰 루프 설계
- [docs/execution-state.md](docs/execution-state.md) — 실행 상태, 강제 훅, 권위 재도출
- [docs/codex-mechanisms.md](docs/codex-mechanisms.md) — codex MCP·플러그인 메커니즘과 재현 방법
- [docs/bootstrap-adherence.md](docs/bootstrap-adherence.md) — ADR: 진입점 재편과 부트스트랩 강제
- [docs/permission-prompt-reduction.md](docs/permission-prompt-reduction.md) — ADR: 좁은 훅 auto-allow

실행 규칙의 정본은 [`instructions/`](instructions/)다. 이 디렉터리의 영문 문서가 런타임 계약이며, 설계 문서는 이를 재서술하지 않는다.
