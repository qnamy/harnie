# harnie — 개발 진행 중 (STATUS 상시 로드)

> 플러그인/repo 이름 = **harnie**(AI 서브에이전트 개발 하네스 + 스킬 허브). 크로스-모델 빌드/리뷰 루프 = 커맨드 `/harnie:dev`(라우터), 트랙 스킬 `dev-full`·`dev-quick`(직접 진입 `/harnie:dev-full`·`/harnie:dev-quick`), 에이전트 `harnie-scout`·`harnie-designer`·`harnie-builder`. 상태 디렉터리 = `.harnie/`.

이 repo는 아직 완성 전이다. harnie에서 작업하는 모든 세션은 **아래 진행 상황·요구사항 문서를 항상 먼저 참조**한다. 문서 안의 "관련 문서 인덱스"(§5)는 필요할 때 on-demand로 읽는다(전부 상시 로드하지 않는다).

**repo 완성 시 `docs/PROJECT-STATUS.md`를 제거한다.**

## 언어 정책 — 영문 정본 + 한국어 미러 (필수)

`agents/`·`commands/`·`instructions/`·`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 그러나 각 영문 문서는 **한국어 미러(`*-ko.md`)를 항상 쌍으로 유지**해 사용자가 한국어로 읽을 수 있게 한다.

- **동시 갱신 필수**: `agents/foo.md`, `commands/foo.md`, `instructions/foo.md`, `skills/<name>/SKILL.md`(및 스킬 내 하위 문서)를 수정하면 **같은 변경을 대응 `*-ko.md`에도 반영**한다(내용 동등성 유지). 한쪽만 고쳐 두 버전이 어긋나게 두지 않는다.
- **신규 추가**: 새 에이전트·커맨드·지침·스킬 문서를 만들 때도 **영문 정본 + 한국어 미러를 쌍으로** 만든다.
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 사람이 읽기 위한 번역이다.
- **실행 대상 제한**: `agents/`·`commands/`의 `*-ko.md`가 별도 플러그인 컴포넌트로 자동 등록되지 않도록 `.claude-plugin/plugin.json`의 `agents`·`commands` 목록에는 영문 정본만 명시한다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신). 단 **진행상황 문서 로딩 방식만** 프로바이더별로 다르다 — `CLAUDE.md`는 말미 `@docs/PROJECT-STATUS.md`(Claude 자동 import), `AGENTS.md`는 명시적 읽기 지침(Codex는 `@` import 미보장).

@docs/PROJECT-STATUS.md
