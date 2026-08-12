# harnie

**AI 서브에이전트 개발 하네스 + 스킬 허브** (Claude Code 플러그인). 한 세션 안에서 **설계 → 리뷰 → 개발 → 리뷰**를 진행하되, **매 단계를 반대 모델이 리뷰**해 맹점을 없앤다 — 구독 auth만으로, Claude와 Codex를 한 세션에서 조합한다.

> 상태: 🚧 v0. 빌드/리뷰 루프 코어 + plan 트랙 실행-상태 강제(승인 게이트·완료 재도출)까지 구현·검증됨. 스킬 허브는 계속 확장 중.

## 왜

같은 모델이 자기 산출물을 리뷰하면 **같은 맹점을 공유**한다. harnie는 producer와 리뷰어를 **항상 다른 프로바이더**로 두어 이 사각을 없앤다:

| 단계 | producer | 리뷰어 |
|---|---|---|
| 설계 | **Claude** (`harnie-designer`) | **Codex** (설계 리뷰) |
| 개발 | **Codex** (codex MCP, workspace-write) | **Claude** (`harnie-reviewer`, 코드 리뷰) |

리뷰어는 diff만 맨눈으로 보지 않고 **공유 컨텍스트(계획·의도·제약)** 위에서 판단하며, 전체 재탐색 없이 **증분 fix-델타 + 필요한 문맥만** 재리뷰하고 승인(open blocking 0)까지 반복한다. 계획·상태·리뷰 receipt는 `.harnie/`에 남아 다음 단계와 재개(resume)가 읽는다.

## 빌드/리뷰 루프

| 진입점 | 동작 |
|---|---|
| `/harnie:dev "<작업>"` | 라우터 **커맨드** — 크기를 분류해 dev-quick/dev-full로 자동 라우팅(announce + 사용자 override) |
| `/harnie:dev-quick "<작업>"` | 작은 작업(장애·수정) **스킬**(직접 진입): 인라인 경량 + 실행 + 단계별 크로스-모델 리뷰 |
| `/harnie:dev-full "<작업>"` | 큰 작업(신규·구조변경) **스킬**(직접 진입): 계획 → 설계 리뷰 → 승인 게이트 → 오케스트레이션 → 코드 리뷰 → 최종 웨이브(Coverage·Quality·Runtime·Scope) |

- 루프 코어(`scripts/loop.mjs`·`ledger.mjs`·`delta.mjs`)는 **프로바이더 무관** — 상태머신·ledger 정합·델타 캡처만 결정적으로 처리하므로 스왑에 코드 변경이 없다.
- **plan 트랙 강제 훅**: 두 불변식을 기계화한다 — ① 승인 게이트 전 소스 쓰기 금지 ② 미승인·미완료를 done으로 확정 금지. 권위 = `planHash`로 고정된 immutable manifest + 리뷰 ledger + verification receipt(자세히는 [docs/execution-state.md](docs/execution-state.md)).

## 스킬 허브

빌드 루프 외에도 실무 방법론 스킬이 `skills/`에 누적된다(**판단·작성만**, 실행 절차는 호출자·환경 지침이 담당):

`pr-review` · `comment-resolve` · `deploy-approval` · `quality-digest` · `pr-delivery` · `confluence-doc` — 그리고 트랙 오케스트레이터 `quick` · `plan`.

## 설치

Claude Code 플러그인이다. repo 루트가 곧 플러그인(`.claude-plugin/plugin.json`)이며, `codex` MCP 서버(`.mcp.json`)를 함께 선언한다.

**로컬 시험 (지금 동작):** repo를 clone한 뒤 플러그인 디렉터리로 로드한다.

```bash
claude --plugin-dir ./harnie
```

**마켓플레이스 설치 (배포 단계):** GitHub 저장소를 마켓플레이스로 설치하려면 `.claude-plugin/marketplace.json` 매니페스트가 필요하다. 이 매니페스트 추가·라이브 검증은 배포 단계에서 확정되며, 이후 사용자는 다음으로 설치한다:

```bash
/plugin marketplace add qnamy/harnie
/plugin install harnie@harnie
```

### 요구사항

- **Claude Code** (최신 stable)
- **`codex` CLI** — 구독 로그인. 설계 리뷰어 + 코드 빌더로 `codex mcp-server`를 사용한다(API 키 불필요).

## 구성

```
harnie/
├── .claude-plugin/plugin.json   # 플러그인 정체성(name: harnie)
├── .mcp.json                    # codex MCP 서버 선언
├── commands/                    # /harnie:dev 라우터 (영문 정본 + *-ko.md 미러)
├── skills/                      # dev-full·dev-quick 오케스트레이터(직접 진입) + 방법론 스킬
├── agents/                      # harnie-scout · designer · builder · reviewer (영문 정본 + *-ko.md 미러)
├── instructions/                # canonical 런타임 계약(영문 실행 정본). *-ko.md는 한국어 미러
├── scripts/                     # loop / ledger / delta / execution / guards (루프·상태 코어)
├── hooks/                       # plan 트랙 강제 훅(PreToolUse · Stop · PostToolUse)
└── docs/                        # 설계 문서
```

## 문서

- [docs/architecture.md](docs/architecture.md) — 스킬·에이전트·크로스-모델 리뷰 루프 설계
- [docs/execution-state.md](docs/execution-state.md) — plan 트랙 실행 상태 + 강제 훅 + 권위 재도출
- [docs/codex-mechanisms.md](docs/codex-mechanisms.md) — codex MCP·플러그인 메커니즘 확정 사실(재현 가능)

실행 규칙의 정본은 [`instructions/`](instructions/)(loop · review-loop-driver · verification-tiers · code-review · design-review · design-authoring)이며, 설계 문서는 이를 재서술하지 않는다.
