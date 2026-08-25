# harnie

> 플러그인/repo 이름 = **harnie**(AI 서브에이전트 개발 하네스 + 스킬 허브). 크로스-모델 빌드/리뷰 루프(0.11) = **단일 파이프라인** 커맨드 `/harnie:dev` + 스킬 `dev`(크기 S/M/L로 스테이지 스킵; `dev-full`·`dev-quick`은 0.12 제거 예정 alias), Codex 단독 스킬 `dev-solo`, 에이전트 `harnie-scout`·`harnie-designer`·`harnie-builder`·`harnie-reviewer`·`harnie-task-runner`. 상태 디렉터리 = `.harnie/`, 툴 네임스페이스 = `mcp__plugin_harnie_codex__*`.

런타임 계약의 정본은 `instructions/`, 설계 근거·이력은 `docs/`(architecture · execution-state · enforcement-map · design-0.11-process/-detail · design-0.10-restructure · bootstrap-adherence · codex-mechanisms · permission-prompt-reduction)와 git 히스토리를 참조한다(필요할 때 on-demand로 읽는다).

## 언어 정책 — 영문 정본 + 한국어 미러 (필수)

`agents/`·`commands/`·`instructions/`·`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 그러나 각 영문 문서는 **한국어 미러(`*-ko.md`)를 항상 쌍으로 유지**해 사용자가 한국어로 읽을 수 있게 한다.

- **동시 갱신 필수**: `agents/foo.md`, `commands/foo.md`, `instructions/foo.md`, `skills/<name>/SKILL.md`(및 스킬 내 하위 문서)를 수정하면 **같은 변경을 대응 `*-ko.md`에도 반영**한다(내용 동등성 유지). 한쪽만 고쳐 두 버전이 어긋나게 두지 않는다.
- **신규 추가**: 새 에이전트·커맨드·지침·스킬 문서를 만들 때도 **영문 정본 + 한국어 미러를 쌍으로** 만든다.
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 사람이 읽기 위한 번역이다.
- **실행 대상 제한**: `agents/`·`commands/`의 `*-ko.md`가 별도 플러그인 컴포넌트로 자동 등록되지 않도록 `.claude-plugin/plugin.json`의 `agents`·`commands` 목록에는 영문 정본만 명시한다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신).

## 릴리스 후속 — Codex 플러그인 동기화 (필수)

플러그인 버전을 올려 `main`에 push한 뒤에는 **`codex plugin marketplace upgrade`를 1회 실행**한다. Codex(데스크톱/CLI)의 harnie 플러그인은 마켓플레이스 스냅샷(`~/.codex/.tmp/marketplaces/harnie`)을 실행 경로로 직접 사용하므로, 이 한 명령으로 대화형 Codex의 pr-review 등 스킬이 최신 버전으로 반영된다. (헤드리스 루틴은 `~/Tradlinx/harnie` 절대경로를 읽으므로 무관. Claude Code 쪽은 기존대로 `/plugin marketplace update harnie` + `/plugin update harnie@harnie`.)
