# harnie

> 플러그인/repo 이름 = **harnie**(AI 서브에이전트 개발 하네스 + 스킬 허브). 크로스-모델 빌드/리뷰 루프 = **단일 파이프라인** 커맨드 `/harnie:dev` + 스킬 `dev`(크기 S/M로 스테이지 스킵 — 0.13에서 L 파이프라인 완전 삭제, M보다 큰 작업은 사람+orca로 인계), Codex 단독 스킬 `dev-solo`, 에이전트 `harnie-scout`·`harnie-designer`·`harnie-builder`·`harnie-reviewer`. 상태 디렉터리 = `.harnie/`, 툴 네임스페이스 = `mcp__plugin_harnie_codex__*`.

런타임 계약의 정본은 `instructions/`, 설계 근거는 `docs/`(architecture · execution-state · enforcement-map · design-0.13-L-dismantle · m-pipeline-kill-criteria · bootstrap-adherence · codex-mechanisms · permission-prompt-reduction)와 git 히스토리를 참조한다(필요할 때 on-demand로 읽는다). **`docs/`에는 현행 계약의 근거만 둔다** — 폐기된 구조의 서사는 git 히스토리가 보관하므로 문서에 "이력" 절로 남기지 않는다.

**디스패치·워크트리 수명주기는 orca 소유다** — harnie는 품질·증거·강제화를 소유하며 둘은 경쟁하지 않는다. S/M을 포함한 모든 run의 워크트리 수명주기와, M보다 큰 작업의 분해·병렬 실행·통합은 사람 + orca가 오케스트레이션한다(`orca worktree create` · `orca terminal create` · `orca worktree rm`). harnie가 조립 가이드나 디스패처를 다시 들이지 않는다.

## 열린 판정 (해소되면 이 절을 통째로 지운다)

0.14가 run root를 사용자 git 작업 트리로 옮겼다. 이 레포에서 작업을 시작하는 세션은 이 절을 읽었으므로, **해당 상황이 오면 사용자에게 한 줄로 상기시킨다** — 별도 루틴이나 알림 장치를 만들지 않는다.

- **M 파이프라인 킬 기준 — 표본 0/3, 마감 2026-11-27.** 비교축은 디스패치된 유닛 중 `/harnie:dev`(`dev`/`dev-solo`)로 돈 것과 plain 세션으로 돈 것이다(`docs/design-0.14-user-tree-handoff.md` U4가 재정의). run을 돌릴 때마다 총 토큰·벽시계·사용자 개입 횟수·재작업 라운드 수를 `docs/m-pipeline-kill-criteria.md`에 한 줄 기록한다. 3건이 모이거나 마감이 지나면 판정하고, 판정 후 이 항목을 지운다. **표본이 안 모인 채 마감을 넘기면 그 자체가 해체 근거다** — 마감일 이후 이 문서를 읽는 세션은 그 사실을 사용자에게 알린다.

## 언어 정책 — 영문 정본 + 한국어 미러는 요청 시에만 (2026-08-27 확정)

`agents/`·`commands/`·`instructions/`·`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 한국어 미러(`*-ko.md`)는 **사람이 명시적으로 요청할 때만** 갱신하는 on-demand 번역이다.

- **동시 갱신 안 함**: 영문 문서를 고칠 때 대응 `*-ko.md`를 같이 갱신하지 않는다. ko 미러가 영문보다 **오래된 상태로 남는 것이 정상**이며, 세션이 이를 자동으로 동기화하지 않는다.
- **삭제는 예외**: 영문 정본 파일을 삭제할 때는 대응 `*-ko.md`도 같이 삭제한다(고아 문서 금지).
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 갱신 시점이 다를 수 있는 참고 번역이다.
- **실행 대상 제한**: `agents/`·`commands/`의 `*-ko.md`가 별도 플러그인 컴포넌트로 자동 등록되지 않도록 `.claude-plugin/plugin.json`의 `agents`·`commands` 목록에는 영문 정본만 명시한다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신) — 이 규칙은 ko 미러 예외와 무관하게 유지된다.

## 스킬·지침 작성 규약 (Claude · Codex 공용, 2026-09-03 조사 기반)

여기서 쓰는 스킬·지침은 **Claude Code와 Codex가 같이 읽는다**. 새 스킬이나 지침 문서를 쓰거나 고칠 때 이 절을 적용한다. 수치·출처·측정은 [docs/skill-authoring-canon.md](docs/skill-authoring-canon.md)에 있고, 필요할 때만 읽는다.

**이식되는 것은 본문과 `name`·`description` 두 필드뿐이다.** Agent Skills는 벤더 중립 표준이라 Codex도 같은 `SKILL.md`를 읽지만, 나머지는 갈린다.

- Claude 전용 프론트매터(`context: fork`, `agent`, `hooks`, `model`, `allowed-tools`, `argument-hint`)를 쓰지 않는다. Codex가 조용히 무시한다.
- `${CLAUDE_PLUGIN_ROOT}`를 쓰지 않는다. Codex 대응물이 없다. 참조가 필요하면 스킬 루트 기준 상대 경로로, **한 단계 깊이까지만** 둔다(중첩하면 Claude가 `head -100`으로 부분만 읽는다).
- 본문 산문에 호출 문법(`/name` 대 `$name`)과 도구 이름(`Read`·`Grep`·`Bash`·`WebFetch`)을 쓰지 않는다. 한쪽에서 틀린 안내가 된다.
- **조사 능력을 전제하지 않는다.** Codex 내장 웹검색은 기본 `cached` 스니펫뿐이고 전체 페이지 fetch 대응물이 없으며, 샌드박스 네트워크는 `workspace-write`에서도 기본 off다. "스킬이 서브에이전트를 띄운다"도 계약이 못 된다(Codex는 위임이 기본 수동). 능력이 있으면 쓰고 없으면 `[미결정]`으로 남기는 강등 경로로 쓴다.
- **모순을 남기지 않는다.** GPT-5 가이드가 모호·상충 지침은 GPT-5에 더 해롭다고 명시한다. Claude가 알아서 메울 자리가 Codex에서는 사고가 된다.

**길이는 줄 수가 아니라 규칙 개수로 관리한다.** 본문 상한은 500줄 / 5k토큰(양쪽 공식 동일)이지만, 준수율을 깎는 축은 **동시 지시 개수**다(80개에서 완전준수율 사실상 0%). 임계 규칙은 문서 앞과 뒤에 둔다(중간 배치 시 30% 이상 저하). 마크다운 구조가 준수율을 올린다는 증거는 없으므로, 표는 내용이 실제로 표일 때만 쓴다.

**작성 스타일.**

- `description`은 3인칭으로 무엇을·언제 쓸지에 더해 **언제 쓰지 말지**까지 적는다. 앞이 절단되므로 핵심 유스케이스를 먼저 둔다.
- 자유도를 작업 취약성에 맞춘다. 판단이 필요한 곳은 산문 휴리스틱, 틀리면 비싼 곳은 정확한 절차와 금지.
- 왜가 아니라 무엇을 적는다. 유효한 선택지를 나열하지 말고 기본 하나와 탈출구 하나만 둔다. 시점 의존 문장을 넣지 않고, 한 개념에는 한 용어만 쓴다.
- Claude Code는 스킬 본문을 한 번 주입하면 이후 턴에 다시 읽지 않는다. 지침은 1회 절차가 아니라 **상주 규칙 문장**으로 쓴다.
- 배포 대상 모델 전부로 점검한다. Haiku(지침이 충분한가) · Sonnet(명확·효율적인가) · Opus(과설명 아닌가).

**스킬 체이닝은 공식 규약이 없다.** Anthropic 문서에 "Combine Skills" 한 줄뿐이고 스태킹은 지침 동시 로드지 출력 파이프가 아니다. 요구사항 → 설계 → 설계리뷰 → 개발 연결은 **약속된 파일 경로**로 잇는다. 앞 단계의 파일 경로를 뒷 단계 입력으로 받고, `[미결정]` 마커를 단계 사이에 승계한다.

## 릴리스 후속 — 플러그인 동기화 (필수)

**계약 문서만 고쳐도 패치 범프가 필요하다.** Claude Code와 대화형 Codex 둘 다 실행 사본을 `plugin.json` 버전 키로 갱신한다. 버전이 그대로면 마켓플레이스 클론에 새 내용이 들어와도 실행 캐시(`~/.claude/plugins/cache/harnie/harnie/<version>`)로 복사되지 않고 `claude plugin update`가 "already at the latest version"으로 끝난다(force 플래그 없음). 2026-08-28 0.13.2 릴리스에서 실측했다.

버전을 올려 `main`에 push한 뒤 각 플랫폼에서 1회씩 실행한다.

- **Claude Code**: `claude plugin marketplace update harnie` + `claude plugin update harnie@harnie`. 적용은 재시작 후다. 대화형 세션에서는 `/plugin marketplace update harnie` + `/plugin update harnie@harnie`.
- **Codex**: `codex plugin marketplace upgrade`. 실행 사본은 `~/.codex/plugins/cache/harnie/harnie/<version>`이다(`~/.codex/.tmp/marketplaces/harnie`는 마켓플레이스 클론이지 실행 경로가 아니다).

헤드리스 루틴은 `~/Tradlinx/harnie` 절대경로를 읽으므로 `main` 머지 시점에 반영된다.

**업그레이드는 열려 있던 Codex 세션의 훅을 죽인다.** Codex 세션은 시작 시점의 버전 디렉터리를 절대경로로 고정하고(훅 커맨드도 skill roots도), 업그레이드는 이전 버전 디렉터리를 지운다. 그 시점부터 그 세션의 harnie 훅은 전부 `MODULE_NOT_FOUND`로 exit 1이 되고, 승인 前 소스 쓰기 차단·control 파일 보호·Stop 완료 강제가 함께 꺼진다. Codex는 `PreToolUse hook (failed)` 배너를 띄우되 도구 호출은 그대로 진행하므로, 실패는 보이지만 막지는 못한다. **버전을 올렸으면 열려 있던 Codex 세션을 재시작하라.** Claude Code는 옛 버전 디렉터리를 지우지 않으므로(캐시에 0.3.1부터 남아 있다) 같은 문제가 없다. 2026-08-31 확인: 세션 `01a05645`가 0.14.5에 고정된 채 15:44의 0.14.7 설치를 넘겨 16:14까지 살아 있었고, 그 고정 경로로 훅을 손실행하면 지금도 exit 1이 난다.
