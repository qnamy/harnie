# harnie

> 플러그인/repo 이름 = **harnie**(AI 서브에이전트 개발 하네스 + 스킬 허브). 크로스-모델 빌드/리뷰 루프 = **단일 파이프라인** 커맨드 `/harnie:dev` + 스킬 `dev`(크기 S/M로 스테이지 스킵 — 0.13에서 L 파이프라인 완전 삭제, M보다 큰 작업은 사람+orca로 인계), Codex 단독 스킬 `dev-solo`, 에이전트 `harnie-scout`·`harnie-designer`·`harnie-builder`·`harnie-reviewer`. 상태 디렉터리 = `.harnie/`, 툴 네임스페이스 = `mcp__plugin_harnie_codex__*`.

런타임 계약의 정본은 `instructions/`, 설계 근거·이력은 `docs/`(architecture · execution-state · enforcement-map · design-0.11-process/-detail · design-0.10-restructure · bootstrap-adherence · codex-mechanisms · permission-prompt-reduction)와 git 히스토리를 참조한다(필요할 때 on-demand로 읽는다).

## 언어 정책 — 영문 정본 + 한국어 미러는 요청 시에만 (2026-08-27 확정)

`agents/`·`commands/`·`instructions/`·`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 한국어 미러(`*-ko.md`)는 **사람이 명시적으로 요청할 때만** 갱신하는 on-demand 번역이다.

- **동시 갱신 안 함**: 영문 문서를 고칠 때 대응 `*-ko.md`를 같이 갱신하지 않는다. ko 미러가 영문보다 **오래된 상태로 남는 것이 정상**이며, 세션이 이를 자동으로 동기화하지 않는다.
- **삭제는 예외**: 영문 정본 파일을 삭제할 때는 대응 `*-ko.md`도 같이 삭제한다(고아 문서 금지).
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 갱신 시점이 다를 수 있는 참고 번역이다.
- **실행 대상 제한**: `agents/`·`commands/`의 `*-ko.md`가 별도 플러그인 컴포넌트로 자동 등록되지 않도록 `.claude-plugin/plugin.json`의 `agents`·`commands` 목록에는 영문 정본만 명시한다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신) — 이 규칙은 ko 미러 예외와 무관하게 유지된다.

## 릴리스 후속 — Codex 플러그인 동기화 (필수)

플러그인 버전을 올려 `main`에 push한 뒤에는 **`codex plugin marketplace upgrade`를 1회 실행**한다. Codex(데스크톱/CLI)의 harnie 플러그인은 마켓플레이스 스냅샷(`~/.codex/.tmp/marketplaces/harnie`)을 실행 경로로 직접 사용하므로, 이 한 명령으로 대화형 Codex의 pr-review 등 스킬이 최신 버전으로 반영된다. (헤드리스 루틴은 `~/Tradlinx/harnie` 절대경로를 읽으므로 무관. Claude Code 쪽은 기존대로 `/plugin marketplace update harnie` + `/plugin update harnie@harnie`.)
