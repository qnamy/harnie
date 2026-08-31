# harnie

> 플러그인/repo 이름 = **harnie**(AI 서브에이전트 개발 하네스 + 스킬 허브). 크로스-모델 빌드/리뷰 루프 = **단일 파이프라인** 커맨드 `/harnie:dev` + 스킬 `dev`(크기 S/M로 스테이지 스킵 — 0.13에서 L 파이프라인 완전 삭제, M보다 큰 작업은 사람+orca로 인계), Codex 단독 스킬 `dev-solo`, 에이전트 `harnie-scout`·`harnie-designer`·`harnie-builder`·`harnie-reviewer`. 상태 디렉터리 = `.harnie/`, 툴 네임스페이스 = `mcp__plugin_harnie_codex__*`.

런타임 계약의 정본은 `instructions/`, 설계 근거는 `docs/`(architecture · execution-state · enforcement-map · design-0.13-L-dismantle · m-pipeline-kill-criteria · bootstrap-adherence · codex-mechanisms · permission-prompt-reduction)와 git 히스토리를 참조한다(필요할 때 on-demand로 읽는다). **`docs/`에는 현행 계약의 근거만 둔다** — 폐기된 구조의 서사는 git 히스토리가 보관하므로 문서에 "이력" 절로 남기지 않는다.

**디스패치·워크트리 수명주기는 orca 소유다** — harnie는 품질·증거·강제화를 소유하며 둘은 경쟁하지 않는다. S/M을 포함한 모든 run의 워크트리 수명주기와, M보다 큰 작업의 분해·병렬 실행·통합은 사람 + orca가 오케스트레이션한다(`orca worktree create` · `orca terminal create` · `orca worktree rm`). harnie가 조립 가이드나 디스패처를 다시 들이지 않는다.

## 열린 판정 (해소되면 이 절을 통째로 지운다)

0.14가 run root를 사용자 git 작업 트리로 옮겼다. 이 레포에서 작업을 시작하는 세션은 이 절을 읽었으므로, **해당 상황이 오면 사용자에게 한 줄로 상기시킨다** — 별도 루틴이나 알림 장치를 만들지 않는다.

- **Codex에서 harnie 훅이 `exit 1`로 죽는다 — 원인 미조사(2026-08-31 관측 4회).** `PreToolUse hook (failed) error: hook exited with code 1`, `Stop hook (failed)`가 대화형 Codex 세션에서 반복해 찍혔다. 훅은 정상 경로에서 exit 0(허용)이나 exit 2(차단)로 끝나므로 어딘가에서 예외가 던져지는 것이다. **왜 중요한가**: Codex가 훅 실패를 무시한다면 승인 前 소스 쓰기 차단·control 파일 보호·Stop 완료 강제가 그 세션에서 조용히 꺼진다. `approve` 차단이 발화한 것은 확인했으니 전부 죽은 것은 아니지만 어느 경로가 죽는지 모른다. 훅을 손으로 한 번 실행해 stderr를 보는 것이 첫 단계다(Codex 페이로드에만 있는 필드 처리에서 나는 것일 수 있다). 해소하면 이 항목을 지운다.
- **M 파이프라인 킬 기준 — 표본 0/3, 마감 2026-11-27.** 비교축은 디스패치된 유닛 중 `/harnie:dev`(`dev`/`dev-solo`)로 돈 것과 plain 세션으로 돈 것이다(`docs/design-0.14-user-tree-handoff.md` U4가 재정의). run을 돌릴 때마다 총 토큰·벽시계·사용자 개입 횟수·재작업 라운드 수를 `docs/m-pipeline-kill-criteria.md`에 한 줄 기록한다. 3건이 모이거나 마감이 지나면 판정하고, 판정 후 이 항목을 지운다. **표본이 안 모인 채 마감을 넘기면 그 자체가 해체 근거다** — 마감일 이후 이 문서를 읽는 세션은 그 사실을 사용자에게 알린다.

## 언어 정책 — 영문 정본 + 한국어 미러는 요청 시에만 (2026-08-27 확정)

`agents/`·`commands/`·`instructions/`·`skills/` 문서는 **영문(`*.md`)이 실행 정본**이다 — 에이전트·플러그인은 이 영문을 로드·실행한다. 한국어 미러(`*-ko.md`)는 **사람이 명시적으로 요청할 때만** 갱신하는 on-demand 번역이다.

- **동시 갱신 안 함**: 영문 문서를 고칠 때 대응 `*-ko.md`를 같이 갱신하지 않는다. ko 미러가 영문보다 **오래된 상태로 남는 것이 정상**이며, 세션이 이를 자동으로 동기화하지 않는다.
- **삭제는 예외**: 영문 정본 파일을 삭제할 때는 대응 `*-ko.md`도 같이 삭제한다(고아 문서 금지).
- **정본 우선**: 충돌·모호 시 영문(`*.md`)이 실행 기준이고, `*-ko.md`는 갱신 시점이 다를 수 있는 참고 번역이다.
- **실행 대상 제한**: `agents/`·`commands/`의 `*-ko.md`가 별도 플러그인 컴포넌트로 자동 등록되지 않도록 `.claude-plugin/plugin.json`의 `agents`·`commands` 목록에는 영문 정본만 명시한다.
- **CLAUDE.md ↔ AGENTS.md 미러**: 두 파일은 **동일 내용 미러**다(한쪽 수정 시 다른 쪽도 반드시 같이 갱신) — 이 규칙은 ko 미러 예외와 무관하게 유지된다.

## 릴리스 후속 — 플러그인 동기화 (필수)

**계약 문서만 고쳐도 패치 범프가 필요하다.** Claude Code와 대화형 Codex 둘 다 실행 사본을 `plugin.json` 버전 키로 갱신한다. 버전이 그대로면 마켓플레이스 클론에 새 내용이 들어와도 실행 캐시(`~/.claude/plugins/cache/harnie/harnie/<version>`)로 복사되지 않고 `claude plugin update`가 "already at the latest version"으로 끝난다(force 플래그 없음). 2026-08-28 0.13.2 릴리스에서 실측했다.

버전을 올려 `main`에 push한 뒤 각 플랫폼에서 1회씩 실행한다.

- **Claude Code**: `claude plugin marketplace update harnie` + `claude plugin update harnie@harnie`. 적용은 재시작 후다. 대화형 세션에서는 `/plugin marketplace update harnie` + `/plugin update harnie@harnie`.
- **Codex**: `codex plugin marketplace upgrade`. 대화형 Codex는 스냅샷(`~/.codex/.tmp/marketplaces/harnie`)을 실행 경로로 직접 쓴다.

헤드리스 루틴은 `~/Tradlinx/harnie` 절대경로를 읽으므로 `main` 머지 시점에 반영된다.
