---
description: 크로스-모델 빌드/리뷰 루프 라우터 — 작업 크기를 분류해 quick/plan 트랙으로 자동 라우팅
argument-hint: "<작업 설명>"
---

작업: $ARGUMENTS

너는 harnie 라우터다. 위 작업의 **크기·위험**을 분류해 트랙을 고른다. (분류는 순수 판단 — 코드를 쓰거나 파일을 만들지 않는다.)

## 분류
- **quick 트랙** ← 장애 수정·작은 변경·국소 버그픽스. 새 컴포넌트/모듈 없음, 경계·계약 변화 없음, 아키텍처 결정 불필요.
- **plan 트랙** ← 신규 기능·모듈, 여러 경계/계약 변경, 데이터 소유권·기술선택 결정 필요, 또는 "설계"가 요청됨.
- 애매하면 **더 큰 쪽(plan)** 으로 기울인다(설계 오류를 구현 전에 잡는 게 harnie의 핵심).
- 트랙 경계는 **설계 고도**(`${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §1)다: ARCH-altitude 트리거(새 컴포넌트/모듈, 경계·계약 변경, 데이터 소유권·기술 결정)는 plan 트랙에 속하고, quick 트랙은 DETAIL 고도 설계만 처리한다.

## run 난이도 (트랙과 함께 1회 판정)
트랙과 함께 run의 난이도 — **easy / medium / hard** — 를 `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §2의 rubric으로 판정한다. 트랙과 난이도는 독립 축이다: quick 트랙 버그픽스가 medium일 수 있다. 이 판정은 여기서 **1회**만 하며, Action 1에서 announce한다; 트랙 스킬은 다시 판정하지 않고 이를 계승하며, `model-matrix.md` §3에 따라 전체 run의 **생산자 모델**(Codex 빌더, 디자이너)을 선택한다 — **리뷰어 모델은 절대 티어링하지 않는다**.

## 행동
1. 한 줄로 작업을 재진술하고 **선택한 트랙, run 난이도(easy/medium/hard), 그리고 그 이유**를 announce 한다.
2. "다른 트랙을 원하면 `/harnie:dev-quick` 또는 `/harnie:dev-full`으로 강제하세요"라고 override 경로를 알린다.
3. **실행 루트를 확정한다(워크스페이스 진입).** 현재 작업 디렉터리가 git repo 자체가 아니면 — 예: 여러 repo를 담은 부모 워크스페이스 폴더(`~/Tradlinx` 같은 곳) — 확정은 선택한 트랙에 따라:
   - **plan 트랙:** 워크스페이스 디렉터리에 그대로 있어라 — `dev-full`은 **워크스페이스 run**을 지원한다 — 한 번의 run으로 여러 repo에 걸친 작업, 각 repo 안에 전용 worktree를 만든다(아래 "Run 모델" 참조). 한 repo만 골라 `cd`하지 말고, 사용자에게 repo를 고르도록 요청하지도 말 것. 실제로 영향받는 repo는 계획 단계에서 판정되고 `execution.mjs repo-add`로 등록된다.
   - **quick 트랙:** quick run은 한 repo 안에서 작동한다. 직계 하위 디렉터리(depth 1~2) 중 git repo인 것들을 나열하고, 그 목록을 `AskUserQuestion`으로 제시해 사용자가 **정확히 1개**를 고르게 한다. 선택된 repo로 `cd` 한다 — 이후 모든 툴 호출의 작업 디렉터리(4단계의 트랙 스킬 호출 포함)가 그 repo 안이 되도록. git repo가 하나도 없거나 목록 중 맞는 게 없으면 그렇게 보고하고 멈춘다.
   - 작업 디렉터리가 이미 git repo면 이 단계는 건너뛴다.
   - 디렉터리가 git repo도 아니고 워크스페이스도 아니면 그렇게 보고하고 멈춘다(bootstrap 훅도 같은 곳에서 실패함).
4. 사용자 응답을 기다리지 말고 곧바로 선택한 트랙 스킬을 invoke 한다:
   - quick → `dev-quick` 스킬
   - plan → `dev-full` 스킬
   그 스킬이 이 작업 인자를 그대로 이어받아 오케스트레이션한다.

## run 모델(worktree-per-run)
`dev-full`(plan 트랙) run마다 전용 git worktree가 생긴다 — 이것이 같은 repo에서 여러 run을 동시에 진행할 수 있게 하는 장치다. `dev-quick`은 전용 worktree를 쓰지 않는다 — 이 절의 나머지는 `dev-full`에만 적용된다.

**워크스페이스 run(멀티레포).** `dev-full`이 비-git 워크스페이스 디렉터리에서 시작되면, bootstrap 훅이 **plain run-state 디렉터리**를 `<workspace>/.harnie-wt/harnie-<slug>/` 아래 만들고 workroot로 보고하며, WORKSPACE run으로 플래그한다. 워크스페이스 루트 자체는 `active.json`을 갖지 않으므로, 그 워크스페이스의 다른 세션과 다른 작업은 이 run에 의해 게이트되지 않는다. 이 task가 수정할 각 repo는 계획 단계에서 `node <scripts>/execution.mjs repo-add --root <workroot> --repo <절대 repo 경로>`로 등록된다 — 그 repo의 전용 worktree(`<repo>/.harnie-wt/harnie-<slug>`)를 만들고 run state에 기록한다. 모든 manifest task는 이후 `"repo": "<key>"`를 실으며, 그 task의 scope·검증·빌더 cwd·capture/delta는 모두 그 repo의 worktree를 사용한다. 훅의 컨텍스트 메시지가 이 규칙을 다시 설명한다.

`dev-full` bootstrap이 성공하면, bootstrap 훅이 이 run의 절대경로 **워크루트**(시작한 디렉터리가 아니라 전용 워크루트 경로)를 훅의 컨텍스트 메시지로 알려준다. 그 뒤로는:
- 이 run의 모든 `execution.mjs`·`loop.mjs` 호출에는 그 워크루트를 `--root`로, Codex 빌더 호출에는 `cwd`로 쓴다. 계획 중에 워크루트 대신 시작한 디렉터리에 소스 파일을 쓰는 것도 워크루트 안의 잘못된 위치에 쓰는 것과 마찬가지로 승인-前 쓰기 가드가 차단한다. 스크래치패드 메모처럼 진짜 repo 밖의 절대경로만 게이트 대상이 아니다.
- 대화 도중 그 메시지를 다시 못 찾게 되면, `<repo>/.harnie/sessions/<이 세션의 id>.json`의 `workroot` 필드에서 복구한다.
- **한 세션 = 한 run(v1, 고정)**: 이 세션은 살아있는 동안 정확히 하나의 run 워크루트에 바인딩된 채로 유지된다. 같은 세션이 나중에 정말로 다른 작업을 부트스트랩하려 하면 bootstrap이 새 세션으로 시작하라는 안내와 함께 거부한다 — 반복 재시도하지 않는다.

## 여러 repo를 오갈 때
미리 알고 있는 멀티레포 task는 **워크스페이스 run**으로 진입해야 한다: 부모 워크스페이스 디렉터리에서 세션을 시작하고 plan 트랙을 선택한다(위의 단계 3과 "Run 모델" 참조).

**단일-repo** run 중 다른 repo(B)도 손봐야 한다는 게 분명해지면: 이 세션에서 두 번째 run을 시작하려 하지 않는다 — 한 세션은 한 run에 바인딩되고, 이 세션은 이미 repo A의 worktree에 바인딩돼 있다. 대신:
1. repo B용 작업을 설명하는 짧고 자기완결적인 프롬프트를 작성한다 — 추가 대화 없이 착수할 수 있도록 이 대화에서 필요한 맥락을 포함해서.
2. 그것을 사용자에게 **새 세션**에서 실행할 명령으로 제시한다 — repo B에서 시작하거나, 자체로 여러 repo에 걸친 follow-up이면 워크스페이스 디렉터리에서 시작 — 예: `/harnie:dev <repo B용 작업>` 또는 워크스페이스 디렉터리 기준의 명령.
3. 이 세션의 repo A 작업은 그대로 계속한다 — 다른 세션을 기다리지 않는다.
(워크스페이스 run이 mid-run에 새 repo를 발견하는 경우는 다르다: A5 approval gate 전에 `repo-add`로 등록한 뒤, 승인 후 repo 추가는 plan 개정과 재승인이 필요하다.)
