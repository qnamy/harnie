# harnie

> 플러그인/repo 이름 = **harnie**(개발 체인 스킬 허브). 개발 체인 6단계 = `requirements` → `software-design` → `software-design-review` → `implementation` → `implementation-review` → `acceptance-verification`. 요구사항·설계·검증은 스킵할 수 있다(예: 설계 → 구현 → 구현리뷰, 구현 → 구현리뷰). 체인과 무관한 스킬 = `pr-review` · `comment-resolve` · `deploy-approval` · `pr-delivery` · `quality-digest` · `confluence-doc`. 에이전트·커맨드·`instructions/`·run-state 훅은 없다 — 스킬 본문이 계약의 전부다. 훅은 `hooks/skill-guard.mjs` 하나로, Claude Code에서 체인이 대체하는 번들 스킬(`code-review`·`simplify`) 호출을 막는다.

설계 근거는 `docs/`(design-artifact-references · skill-authoring-canon · codex-mechanisms · skill-feedback-software-design-review)와 git 히스토리를 참조한다(필요할 때 on-demand로 읽는다). **`docs/`에는 현행 계약의 근거만 둔다** — 폐기된 구조의 서사는 git 히스토리가 보관하므로 문서에 "이력" 절로 남기지 않는다.

**리뷰어와 검증자는 별도 세션이고, 그 세션은 orca가 연다.** 리뷰는 코디네이터(설계·구현을 한 세션)가 orca로 다른 프로바이더의 대화형 세션 하나를 열어 돌리며, 요청·결과는 파일로 주고받는다. 자율 라운드 상한은 2, 이후는 사용자가 푼다. 체인 산출물은 워크트리 루트 `_chain/` 하나에 두고(한 워크트리에 한 체인), 커밋도 `.gitignore`도 하지 않는다. 디스패치·워크트리 수명주기는 orca 소유다. 강제 훅은 두지 않는다(근거: `docs/design-artifact-references.md` §14).

## 언어 정책 — 영문 정본 + 한국어 미러는 요청 시에만 (2026-08-27 확정)

`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 한국어 미러(`*-ko.md`)는 **사람이 명시적으로 요청할 때만** 갱신하는 on-demand 번역이다.

- **동시 갱신 안 함**: 영문 문서를 고칠 때 대응 `*-ko.md`를 같이 갱신하지 않는다. ko 미러가 영문보다 **오래된 상태로 남는 것이 정상**이며, 세션이 이를 자동으로 동기화하지 않는다.
- **삭제는 예외**: 영문 정본 파일을 삭제할 때는 대응 `*-ko.md`도 같이 삭제한다(고아 문서 금지).
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 갱신 시점이 다를 수 있는 참고 번역이다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신) — 이 규칙은 ko 미러 예외와 무관하게 유지된다.

## 스킬·지침 작성 규약 (Claude · Codex 공용, 2026-09-03 조사 기반)

여기서 쓰는 스킬은 **Claude Code와 Codex가 같이 읽는다**. 새 스킬을 쓰거나 고칠 때 이 절을 적용한다. 수치·출처·측정은 [docs/skill-authoring-canon.md](docs/skill-authoring-canon.md)에 있고, 필요할 때만 읽는다.

**이식되는 것은 본문과 `name`·`description` 두 필드뿐이다.** Agent Skills는 벤더 중립 표준이라 Codex도 같은 `SKILL.md`를 읽지만, 나머지는 갈린다.

- Claude 전용 프론트매터(`context: fork`, `agent`, `hooks`, `model`, `allowed-tools`, `argument-hint`)를 쓰지 않는다. Codex가 조용히 무시한다.
- `${CLAUDE_PLUGIN_ROOT}`를 쓰지 않는다. Codex 대응물이 없다. 참조가 필요하면 스킬 루트 기준 상대 경로로, **한 단계 깊이까지만** 둔다(중첩하면 Claude가 `head -100`으로 부분만 읽는다).
- 본문 산문에 호출 문법(`/name` 대 `$name`)과 도구 이름(`Read`·`Grep`·`Bash`·`WebFetch`)을 쓰지 않는다. 한쪽에서 틀린 안내가 된다.
- **조사 능력을 전제하지 않는다.** Codex 내장 웹검색은 기본 `cached` 스니펫뿐이고 전체 페이지 fetch 대응물이 없으며, 샌드박스 네트워크는 `workspace-write`에서도 기본 off다. "스킬이 서브에이전트를 띄운다"도 계약이 못 된다(Codex는 위임이 기본 수동, 에이전트 정의는 두 플랫폼이 다르고 Codex 플러그인은 에이전트를 배포하지 못한다). 능력이 있으면 쓰고 없으면 `[미결정]`으로 남기는 강등 경로로 쓴다.
- **모순을 남기지 않는다.** GPT-5 가이드가 모호·상충 지침은 GPT-5에 더 해롭다고 명시한다. Claude가 알아서 메울 자리가 Codex에서는 사고가 된다.

**길이는 줄 수가 아니라 규칙 개수로 관리한다.** 본문 상한은 500줄 / 5k토큰(양쪽 공식 동일)이지만, 준수율을 깎는 축은 **동시 지시 개수**다(80개에서 완전준수율 사실상 0%). 임계 규칙은 문서 앞과 뒤에 둔다(중간 배치 시 30% 이상 저하). 마크다운 구조가 준수율을 올린다는 증거는 없으므로, 표는 내용이 실제로 표일 때만 쓴다. Codex의 8,000자는 선택 전 목록 예산이고 선택된 본문은 절단되지 않는다.

**작성 스타일.**

- `description`은 3인칭으로 무엇을·언제 쓸지에 더해 **언제 쓰지 말지**까지 적는다. 앞이 절단되므로 핵심 유스케이스를 먼저 둔다.
- 자유도를 작업 취약성에 맞춘다. 판단이 필요한 곳은 산문 휴리스틱, 틀리면 비싼 곳은 정확한 절차와 금지.
- 왜가 아니라 무엇을 적는다. 유효한 선택지를 나열하지 말고 기본 하나와 탈출구 하나만 둔다. 시점 의존 문장을 넣지 않고, 한 개념에는 한 용어만 쓴다.
- Claude Code는 스킬 본문을 한 번 주입하면 이후 턴에 다시 읽지 않는다. 지침은 1회 절차가 아니라 **상주 규칙 문장**으로 쓴다.
- 배포 대상 모델 전부로 점검한다. Haiku(지침이 충분한가) · Sonnet(명확·효율적인가) · Opus(과설명 아닌가).

**스킬 체이닝은 공식 규약이 없다.** Anthropic 문서에 "Combine Skills" 한 줄뿐이고 스태킹은 지침 동시 로드지 출력 파이프가 아니다. 체인 6단계는 **약속된 파일 경로**(`_chain/requirements.md` · `_chain/design.md` · `_chain/design-review-N.md` · `_chain/implementation-review-N.md` · `_chain/acceptance-verification.md`)로 잇는다. 앞 단계의 파일 경로를 뒷 단계 입력으로 받고, `[미결정]` 마커를 단계 사이에 승계한다.

## 릴리스 후속 — 플러그인 동기화 (필수)

**스킬 본문만 고쳐도 패치 범프가 필요하다.** Claude Code와 대화형 Codex 둘 다 실행 사본을 `plugin.json` 버전 키로 갱신한다. 버전이 그대로면 마켓플레이스 클론에 새 내용이 들어와도 실행 캐시(`~/.claude/plugins/cache/harnie/harnie/<version>`)로 복사되지 않고 `claude plugin update`가 "already at the latest version"으로 끝난다(force 플래그 없음). 2026-08-28 0.13.2 릴리스에서 실측했다.

버전을 올려 `main`에 push한 뒤 각 플랫폼에서 1회씩 실행한다.

- **Claude Code**: `claude plugin marketplace update harnie` + `claude plugin update harnie@harnie`. 적용은 재시작 후다. 대화형 세션에서는 `/plugin marketplace update harnie` + `/plugin update harnie@harnie`.
- **Codex**: `codex plugin marketplace upgrade`. 실행 사본은 `~/.codex/plugins/cache/harnie/harnie/<version>`이다(`~/.codex/.tmp/marketplaces/harnie`는 마켓플레이스 클론이지 실행 경로가 아니다).

헤드리스 루틴은 `~/Tradlinx/harnie` 절대경로를 읽으므로 `main` 머지 시점에 반영된다.

**업그레이드는 열려 있던 Codex 세션의 플러그인 경로를 죽인다.** Codex 세션은 시작 시점의 버전 디렉터리를 절대경로로 고정하고(훅 커맨드도 skill roots도), 업그레이드는 이전 버전 디렉터리를 지운다. 그 시점부터 그 세션의 플러그인 훅은 `MODULE_NOT_FOUND`로 exit 1이 되고, Codex는 `PreToolUse hook (failed)` 배너를 띄우되 도구 호출은 그대로 진행한다. **버전을 올렸으면 열려 있던 Codex 세션을 재시작하라.** Claude Code는 옛 버전 디렉터리를 지우지 않으므로 같은 문제가 없다(2026-08-31 실측).
