# harnie

> 플러그인/repo 이름 = **harnie**(AI 서브에이전트 개발 하네스 + 스킬 허브). 크로스-모델 빌드/리뷰 루프 = **단일 파이프라인** 커맨드 `/harnie:dev` + 스킬 `dev`(크기 S/M로 스테이지 스킵 — 0.13에서 L 파이프라인 완전 삭제, M보다 큰 작업은 사람+orca로 인계), Codex 단독 스킬 `dev-solo`, 에이전트 `harnie-scout`·`harnie-designer`·`harnie-builder`·`harnie-reviewer`. 상태 디렉터리 = `.harnie/`, 툴 네임스페이스 = `mcp__plugin_harnie_codex__*`.

런타임 계약의 정본은 `instructions/`, 설계 근거는 `docs/`(architecture · execution-state · enforcement-map · design-0.13-L-dismantle · m-pipeline-kill-criteria · bootstrap-adherence · codex-mechanisms · permission-prompt-reduction)와 git 히스토리를 참조한다(필요할 때 on-demand로 읽는다). **`docs/`에는 현행 계약의 근거만 둔다** — 폐기된 구조의 서사는 git 히스토리가 보관하므로 문서에 "이력" 절로 남기지 않는다.

**디스패치·worktree 수명주기는 orca 소유다** — harnie는 품질·증거·강제화를 소유하며 둘은 경쟁하지 않는다. M보다 큰 작업의 분해·병렬 실행·통합은 사람 + orca가 오케스트레이션한다(`orca worktree create` · `orca terminal create` · `orca worktree rm`). harnie가 조립 가이드나 디스패처를 다시 들이지 않는다.

## 열린 판정 (해소되면 이 절을 통째로 지운다)

0.13은 릴리스됐지만 아직 닫히지 않은 판정이 둘 있다. 이 레포에서 작업을 시작하는 세션은 이 절을 읽었으므로, **해당 상황이 오면 사용자에게 한 줄로 상기시킨다** — 별도 루틴이나 알림 장치를 만들지 않는다.

- **0.13.x 실런 검증 0회.** 0.13.0이 엔진에서 errata·workspace 모드·mode L 배선을 대량 제거했고, 0.13.1이 훅의 root 해석(`resolveRoot` ③ 폴백)과 worktree 폐기 경로(`remove --abandon`)를 바꿨다. 테스트 288은 통과하지만 실제 run은 한 번도 돌지 않았다(설계 §10 R1이 이 위험을 medium·high로 기록). **다른 레포에서 M 규모 작업을 시작할 때 `/harnie:dev`로 한 번 돌려 카나리아로 삼는다.** 성공하면 이 항목을 지운다.
- **M 파이프라인 킬 기준 — 표본 0/3, 마감 2026-11-27.** `/harnie:dev` run을 돌릴 때마다 총 토큰·벽시계·사용자 개입 횟수·재작업 라운드 수를 `docs/m-pipeline-kill-criteria.md`에 한 줄 기록한다. 3건이 모이거나 마감이 지나면 판정하고, 판정 후 이 항목을 지운다. **표본이 안 모인 채 마감을 넘기면 그 자체가 해체 근거다** — 마감일 이후 이 문서를 읽는 세션은 그 사실을 사용자에게 알린다.

## 언어 정책 — 영문 정본 + 한국어 미러는 요청 시에만 (2026-08-27 확정)

`agents/`·`commands/`·`instructions/`·`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 한국어 미러(`*-ko.md`)는 **사람이 명시적으로 요청할 때만** 갱신하는 on-demand 번역이다.

- **동시 갱신 안 함**: 영문 문서를 고칠 때 대응 `*-ko.md`를 같이 갱신하지 않는다. ko 미러가 영문보다 **오래된 상태로 남는 것이 정상**이며, 세션이 이를 자동으로 동기화하지 않는다.
- **삭제는 예외**: 영문 정본 파일을 삭제할 때는 대응 `*-ko.md`도 같이 삭제한다(고아 문서 금지).
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 갱신 시점이 다를 수 있는 참고 번역이다.
- **실행 대상 제한**: `agents/`·`commands/`의 `*-ko.md`가 별도 플러그인 컴포넌트로 자동 등록되지 않도록 `.claude-plugin/plugin.json`의 `agents`·`commands` 목록에는 영문 정본만 명시한다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신) — 이 규칙은 ko 미러 예외와 무관하게 유지된다.

## 릴리스 후속 — Codex 플러그인 동기화 (필수)

플러그인 버전을 올려 `main`에 push한 뒤에는 **`codex plugin marketplace upgrade`를 1회 실행**한다. Codex(데스크톱/CLI)의 harnie 플러그인은 마켓플레이스 스냅샷(`~/.codex/.tmp/marketplaces/harnie`)을 실행 경로로 직접 사용하므로, 이 한 명령으로 대화형 Codex의 pr-review 등 스킬이 최신 버전으로 반영된다. (헤드리스 루틴은 `~/Tradlinx/harnie` 절대경로를 읽으므로 무관. Claude Code 쪽은 기존대로 `/plugin marketplace update harnie` + `/plugin update harnie@harnie`.)
