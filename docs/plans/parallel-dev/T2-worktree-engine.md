# T2 — worktree 런 엔진 + 멀티레포 진입 (R1·R2)

> 이 프롬프트는 자기완결이다. 새 Claude Code 세션(cwd = harnie repo 루트)에 그대로 붙여 실행한다.

## 컨텍스트

- repo: `~/Tradlinx/harnie`. `main` 최신에서 브랜치 `claude/harnie-T2-worktree-engine` 생성 후 작업.
- 현 구조: `.harnie/active.json`이 **repo 루트당 활성 run 1개**를 가리키는 싱글턴. 훅의 `findRoot`는 가장 가까운 `.harnie/active.json` 또는 첫 `.git`에 바인딩 → **git worktree는 각자 독립 루트가 되므로 싱글턴 모델을 바꾸지 않고 worktree를 늘려 동시성을 얻는다**(설계 결정 DEC-001). 상태 모델 개편 금지.
- 병렬 진행 주의: 별도 세션 T1이 `execution.mjs`에서 park/lock 등을 제거 중이다. **park·lock 토큰·route failed-latch에 새 의존을 만들지 말 것.** merge 충돌은 통합 세션이 해결한다.

## 목표

1. **worktree-per-run**: dev 부트스트랩이 run마다 worktree+브랜치를 만들고 run 상태를 worktree 안에 둔다 → 같은 repo에서 동시 run ≥3.
2. **멀티레포 진입**: cwd가 git repo가 아닌 워크스페이스(예: `~/Tradlinx`)여도 하위 repo를 해석해 부트스트랩 가능.

## 구현 사양

### 1. 신규 `scripts/worktree.mjs` (+ `worktree.test.mjs`)

- `create --repo <abs> --branch <name> [--from <ref>]` → `<repo>/.harnie-wt/<sanitized-branch>` 에 `git worktree add -b <name>`(이미 있으면 attach), worktree 경로를 stdout으로. 최초 생성 시 `<repo>/.git/info/exclude`에 `.harnie-wt/`·`.harnie/` 자동 등록(멱등).
- `merge --repo <abs> --branch <name> --into <ref>` → `<ref>` 체크아웃된 트리(run worktree)에서 `git merge --no-ff <name>`. 충돌 시 exit 3 + 충돌 파일 목록 stdout(merge는 중단하지 않고 남겨 오케스트레이터가 해결).
- `remove --repo <abs> --branch <name> [--keep-branch]` → worktree 제거(+기본은 브랜치 유지).
- fail-closed·원자성 원칙은 기존 `execution.mjs` 스타일을 따르되 방어 계층은 최소(단순 인자 검증 + git 종료코드 전파).

### 2. 부트스트랩 통합 (`hooks/bootstrap.mjs` + `scripts/execution.mjs`의 init 진입부)

- dev-full 부트스트랩 순서 변경: slug 확정 → `worktree.mjs create --branch harnie/<slug> --from <현재 브랜치>` → **worktree 경로를 `--root`로 `execution.mjs init`** → run 상태(`.harnie/`)는 worktree 안에 생성.
- **세션→run 바인딩**: 세션 cwd는 main 작업트리이므로 훅이 활성 run을 찾도록 `<main repo>/.harnie/sessions/<session_id>.json` = `{"workroot": "<abs worktree 경로>"}` 를 부트스트랩이 기록한다. 훅 컨텍스트 해석 순서 = ① cwd 상향 `findRoot`(worktree 안에서 시작한 세션) ② 세션 바인딩 파일. Stop·PreToolUse 모두 이 순서로. run 종료(completion) 시 바인딩 파일 삭제.
- 이로써 main repo의 `.harnie/`에는 **세션 바인딩·pending-route만** 남고 run 데이터는 각 worktree가 소유한다. 서로 다른 세션이 같은 repo에서 각자 run을 갖는 것이 자연히 허용된다.
- **한 세션 = 한 run** (v1 고정). 이미 바인딩된 세션이 새 run을 요청하면 fail-closed + 안내.

### 3. 멀티레포 진입 (`commands/dev.md` + `commands/dev-ko.md` + bootstrap)

- cwd가 git repo가 아니면: 직계 하위 git repo 목록(depth 1~2)을 나열해 AskUserQuestion으로 **1개 선택** → 그 repo를 대상으로 위 부트스트랩 진행.
- 작업 중 다른 repo(B) 작업이 필요해지면: 이 세션에서 run을 늘리지 않는다. 오케스트레이터가 B repo용 **새 세션 시작 프롬프트**(작업 내용 요약 포함)를 생성해 사용자에게 제시하는 지침을 `commands/dev.md`에 추가.
- cross-repo 단일 run은 비목표 — 구현하지 말 것.

### 4. 문서 동기화

- `commands/dev.md`(+`-ko.md`)에 worktree run 모델·멀티레포 진입 절차 반영. `skills/` 문서는 T3 소유이므로 건드리지 않는다(필요 변경은 보고서에 목록만).

## 검증 (완료 기준)

1. 단위테스트: worktree create/merge(충돌 exit 3 포함)/remove, exclude 등록 멱등성, **worktree 내부에서의 `findRoot` 해석**(중첩 `.git` 파일 케이스), 세션 바인딩 해석 순서.
2. 라이브 스모크(throwaway repo): 같은 repo에서 run 2개를 서로 다른 worktree로 부트스트랩 → 두 `.harnie` 상태가 독립인지, 훅이 각 세션에서 자기 run에 바인딩되는지 확인.
3. `node --test scripts/*.test.mjs hooks/*.test.mjs` 전체 그린.
4. Opus 5 리뷰 APPROVE 후 커밋(push는 사용자 확인 후). 보고서: 바인딩 규약 요약 + T1/T3와의 인터페이스 변경점.

## 진행 방식·모델 배선 (공통)

- 읽기·조사: codex MCP read-only, model `gpt-5.6-luna`(불가 시 Haiku 서브에이전트).
- 구현: codex MCP, model `gpt-5.6-sol`, sandbox `workspace-write`, cwd=repo 루트. 오케스트레이터는 지시·검증만.
- 코드리뷰: Opus 5 read-only 서브에이전트(REJECT-bias, `instructions/code-review.md` 기준) → REJECT면 codex-reply 수정 루프.

## 원칙 (전 태스크 공통)

- 요청 범위만 정확히(surgical). 새 방어 계층·추측성 옵션 추가 금지(위협모델 §0.1: 적대적 세션 비목표).
- 언어 정책: `commands/*.md` 수정 시 `*-ko.md` 미러 동시 갱신.
