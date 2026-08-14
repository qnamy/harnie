---
name: dev-full
description: 신규 기능·모듈·구조 변경 등 큰 작업을 풀 라이프사이클로 처리하는 오케스트레이터 — 계획(그라운딩+라우팅)→설계→크로스-모델 설계 리뷰(코드 前)→승인 게이트→오케스트레이션 실행→크로스-모델 코드 리뷰→최종 웨이브(Coverage·Quality·Runtime·Scope). 대칭 크로스-모델 방식으로 설계는 Claude→Codex 리뷰, 개발은 Codex→Claude 리뷰를 적용한다. `/harnie:dev-full` 또는 라우터 `/harnie:dev`가 호출한다. (내부 track 값은 그대로 `plan`.)
---

# plan 오케스트레이터 (class B: 신규·큰 변경)

너(main)는 계획 단계에서 실행 단계로 전환한다. 에이전트 전환이 아니라 한 세션의 국면 전환이다. 워크플로 규율은 이 스킬 + (P2 배송 시) 최소 강제 훅으로 지킨다.

## 매 사용자 메시지: 의도 재분류 (실행 권한 승계 금지)
새 사용자 메시지가 오면 **이번 실행 모드를 자동 승계하지 말고** 메시지를 `replace|add|status|question`으로 다시 분류한다. **status·question·단순 add**는 승인된 실행 권한을 취소하지 않는다(진행 유지). 그러나 **범위·목표가 바뀌면**(replace, 또는 범위를 바꾸는 add) 실행을 멈추고 `execution.json`·plan·리뷰 범위를 재계산한 뒤 필요한 재승인을 받고 이어간다. (실행 권한 리셋이 아니라 **메시지 의도·범위 리셋**.)

## Step 0 — 런타임 계약 주입 (필수, 먼저)
아래 canonical 파일을 **지금 Read** 한다(경로 참조만으론 부족 — 실제 내용을 이 세션에 올린다). 재서술하지 말고 조율만 한다.
- `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md` — 리뷰 루프 상태머신 + 출력 스키마 + ledger 규칙
- `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md` — 루프 CLI·codex 배선(R1~R5)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-arch.md` — 아키 작성 프로필(경량/정식 분기)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md` — 상세 작성 프로필(경량/정식 분기)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-review.md` — 설계 리뷰 기준(코드 前, namespace `DR`, 아키·상세 두 고도에 적용)
- `${CLAUDE_PLUGIN_ROOT}/instructions/code-review.md` — 코드 리뷰 기준(REJECT 편향, namespace `CR`)
- `${CLAUDE_PLUGIN_ROOT}/instructions/verification-tiers.md` — 검증 tier

> **대칭 크로스-모델**(각 단계 반대 프로바이더가 리뷰): **설계**(A3·A4) = Claude(`harnie-designer`) 산출 → **Codex** 리뷰 / **개발**(B2·B3·Final Wave) = **Codex** 빌더(codex MCP, `workspace-write`) 산출 → **Claude** 리뷰. codex MCP 툴명은 설치 형태에 따라 `mcp__plugin_harnie_codex__codex`/`mcp__codex__codex`, 재빌드·재리뷰는 `*__codex-reply`. 자세한 배선은 review-loop-driver.md.

## 상태 위치 (durable, 파일 기반)
`.harnie/plan/<slug>/`:
- `plan.md` — 설계 + 작업 분해 + 검증 전략 + Final Wave(Coverage·Quality·Runtime·Scope). 승인 게이트의 대상.
- `design/rev-N.md` — **버전이 붙은 설계 정본**: 리비전마다 파일 하나, N은 단조 증가, 덮어쓰기 없음. 서브에이전트·리뷰어에게 설계 내용으로 넘길 수 있는 **유일한 경로**.
- `notepad.md` — 진행 메모(크로스-프로바이더 공유 단일 소스).
- `review/design-arch/` · `review/design-detail/` — 아키·상세 설계 리뷰 루프 상태(각 독립: `ledger.json`·`state.json`·`round-N.txt`).
- `review/<unit>/` — 작업/웨이브별 코드 리뷰 루프 상태.

> 경로 단일 스킴: 모든 리뷰 루프 상태는 `.harnie/plan/<slug>/review/<name>/` 아래(quick의 `.harnie/quick/<slug>/`와 대칭). `<name>` = `design-arch` | `design-detail` | 코드 리뷰 단위.

> **병렬 PHASE B(태스크 worktree).** B1이 병렬 경로를 선택하면 태스크마다 git worktree(`scripts/worktree.mjs create`)를 갖는다 — `<repo>/.harnie-wt/<브랜치의 슬래시를 대시로 바꾼 이름>`에 생성되며, 태스크 브랜치 `harnie/<slug>-t<id>`라면 `<repo>/.harnie-wt/harnie-<slug>-t<id>`다. **run worktree 안에 중첩된다**(여기서 `<repo>`는 위 실행 상태 절에서 쓰는 것과 같은 run workroot다 — `worktree.mjs`의 Bash-가드 sanction이 `--repo`가 단일 활성 루트와 같을 것을 요구하므로). `.git/info/exclude`에는 `.harnie-wt/`만 등록된다(`worktree.mjs create`가 멱등하게) — `.harnie/`는 등록하지 **않는다**: 애초에 어떤 브랜치에도 커밋된 적이 없으므로(그래서 merge가 그걸 건드릴 수 없다), gitignore식 exclude에 넣으면 `delta.mjs`의 명시적 pathspec `git add`가 "ignored path" 오류로 실패한다. 그 태스크 worktree는 **별개의 repo 루트**로 자기만의 `.harnie/`를 가지며, 그 태스크의 머지 前 설계(`.harnie/design/rev-N.md`)와 리뷰 루프 상태(`.harnie/review/design/`, `.harnie/review/code/`)만 담는다 — `.harnie/plan/<slug>/…`는 절대 아니며, 그 경로는 run worktree 전용으로 남는다. 태스크 worktree는 `execution.mjs` run 상태(`active.json`·manifest)를 전혀 갖지 않는다 — run 전체 승인은 A5에서 이미 1회 끝났으므로, PHASE B에서 태스크마다 다시 재도출하지 않는다.
>
> **웨이브-2 통합 갱신 — 아래 갭 1~3은 해소됐고, 갭 4만 남는다.** `scripts/guards.mjs`·`scripts/worktree.mjs`(별도 작업 소유)를 직접 수정하고 크로스-모델 리뷰 라운드를 거쳤다 — `node --test scripts/*.test.mjs hooks/*.test.mjs`로 검증했고, 갭 3은 throwaway repo에서 원래 실패와 수정 후 성공을 둘 다 재현해 확인했다.
> 1. **Codex 빌더 가드(`decideCodex`)가 이제 활성 태스크 worktree를 허용한다.** `cwd`는 단일 활성 루트와 같거나, 그 run의 활성 `<slug>`에 대해 `<root>/.harnie-wt/harnie-<slug>-t<id>`이면 된다(신규 `isActiveTaskWorktree` 헬퍼). 그 외 경로(다른 slug, 다른 repo, 한 단계 더 깊은 경로, `.harnie-wt-evil/…`처럼 흉내만 낸 컨테이너 이름 등)는 이전과 똑같이 거부된다.
> 2. **태스크 worktree를 대상으로 하는 `loop.mjs delta`/`apply`가 이제 sanctioned로 인식된다.** `guards.mjs`의 sanctioned-CLI 검사는 `loop.mjs`의 repo/`--root` 인자가 단일 활성 루트이거나 활성 태스크 worktree(갭 1과 같은 헬퍼)이면 통과시킨다. 일단 sanctioned로 판정되면 `decideBash`는 포괄적 Bash `.harnie` 보호에 도달하기 전에 반환하므로, B2′ 3단계 DR `apply`와 5단계 CR `delta`/`apply`가 `<taskWt>/.harnie/review/…`를 가리켜도 이제 통과한다. `execution.mjs`·`worktree.mjs` 자체의 root/repo 검사는 의도적으로 그대로 두었다 — 태스크 worktree는 설계상 `execution.mjs` run 상태를 전혀 갖지 않고(위 참조), `worktree.mjs create/merge/remove --repo`는 언제나 `.harnie-wt/`를 담고 있는 run worktree를 가리킬 뿐 태스크 worktree 자신을 가리키는 일이 없기 때문이다.
> 3. **`worktree.mjs remove`가 이제 제거 前에 태스크 worktree 자신의 `.harnie/` 잔여를 좁게, **되돌릴 수 있게** 정리한다(B3′ 5단계).** `<worktree>/.harnie/active.json`·`.../plan/`·`.../quick/`이 **모두** 없을 때만 시도한다 — 태스크 worktree는 설계상 이 셋을 절대 갖지 않고 run 자신의 worktree만 가지므로(부트스트랩 도중까지 포함), 이 검사가 실제 run의 권위 상태를 이 메커니즘이 건드리는 일을 막는다 — 그리고 `git status --porcelain` 검사로 그 worktree의 모든 untracked·수정 경로가 `.harnie/` 아래인지 **먼저** 확인한다. `.harnie/`를 곧바로 지우는 대신, git-제외된 임시 스태시 디렉터리로 **옮긴** 뒤 plain(`--force` 없는) `git worktree remove`를 시도하고, 그게 성공했을 때만 스태시를 지운다 — 제거가 (더티 tree든 locked worktree든 submodule이든 그 밖의 어떤 이유로든) 실패하면 에러를 던지기 前에 `.harnie/`를 원위치로 되돌리므로, 실패한 **이유가 무엇이든** 아무것도 유실되지 않는다. `.harnie/` 밖의 정말 예상 밖인 untracked 내용은 여전히 제거를 막는다. `create`·`remove` 양쪽에 추가한 경로 containment 단언은 리뷰 중 드러난 `branch: ".."` 류 traversal 엣지케이스도 함께 닫는다.
> 4. **빌더 스레드 등록(`registerBuilderAuto`)은 여전히 시스템 전체에서 동시 building 중인 태스크를 하나만 추적한다**(이번 웨이브 범위 밖, 변경 없음) — `buildingUnboundTasks`가 정확히 하나의 `building`+미바인딩 태스크를 요구해야 threadId를 자동 바인딩한다. 실제로 이건 태스크당 **최초** Codex 호출(그 태스크의 빌더 threadId를 부트스트랩하는 호출) 하나만 직렬화할 뿐, B2′ 전체를 막지 않는다: 한 태스크를 `building`으로 표시 → 그 태스크의 첫 Codex 호출 → 그 threadId가 등록될 때까지 대기 → **그다음** 태스크를 `building`으로 표시 → 그 태스크의 첫 호출, 순서로 진행하면 된다. 이렇게 각 태스크의 threadId가 등록되고 나면 이후 `codex-reply` 호출은 그 threadId를 명시적으로 지정하므로, 서로 다른 태스크의 나머지 B2′(수정 라운드, 리뷰)는 실제로 시간상 겹쳐 진행될 수 있다 — 직렬화 지점은 태스크당 이 최초 부트스트랩 순간 하나뿐이다.
>
> 1~3이 해소됐으므로, 병렬 경로는 이제 현재 머지된 가드 계층에 대고 B2′/B3′/B4~B6의 모든 단계에서 작동한다. 단, 갭 4의 좁은 최초-호출 직렬화만 예외다. 이 스킬은 여전히 위에 서술한 것 이상의 우회를 시도하지 않는다 — 훅을 끄거나, 이번처럼 신중히 리뷰된 변경이 아닌 방식으로 `guards.mjs`/`execution.mjs`/`worktree.mjs`를 고치거나, `.harnie/`를 손으로 지우는 것은 가드를 만족시키는 게 아니라 무력화·훼손하는 것이다. 갭 4 외의 이유로 어떤 단계든 여전히 실패하거나 거부되면, 우회하지 말고 STOP하고 보고한다.

## 위임 참조 규칙 (디스크 정본만)

서브에이전트·리뷰어에게 넘기는 모든 경로는 repo 안의 **디스크 정본**이어야 한다 — `.harnie/plan/<slug>/…` 또는 소스 파일. **tool-result blob 경로**(`tool-results/*.json`, 트랜스크립트 스크래치, 임시 캡처 등)는 **절대 넘기지 않는다.** 그 파일들은 읽히도록 쓰인 게 아니라서(한 줄 55k 토큰 JSON은 조용히 로드에 실패한다), 위임받은 쪽은 자기가 기억하는 **더 오래된 리비전**으로 설계를 재구성하게 되고, 그렇게 세대가 라운드를 넘어 뒤섞이면 하류에서 탐지되지 않는다.

따라서 **설계 산출물이 존재하는 순간부터**:

1. main이 현재 설계를 `.harnie/plan/<slug>/design/rev-N.md`에 쓴다 — **리비전마다 새 파일**, 이전 `N`을 덮어쓰지 않는다. **최초 작성 위임**(A3/A4 첫 패스)에는 아직 산출물이 없다 — designer가 작업과 그라운딩으로 `rev-1`을 만들고, 이 규칙은 **그 이후 모든 위임**에 적용된다.
2. **기존 설계를 참조하는 이후 위임**은 **그 정확한 경로와 리비전 번호**를 명시하고, 어떤 리비전이 리뷰 대상인지 말한다(예: "`design/rev-4.md`를 리뷰하라, rev-3은 폐기됨").
3. 설계 내용을 프롬프트에 인라인으로 싣는 것(`review-loop-driver.md` R2가 `DR` 루프에서 요구 — 설계 파일은 git delta에서 제외되므로)은 이 규칙을 **대체하지 않는다**: 인라인 내용과 명시한 `rev-N.md`는 **같은 리비전**이어야 한다.
4. **빌더 예외(B2).** Codex 빌더는 `.harnie/`에 접근하지 않으므로 `.harnie` 경로를 받지 않는다. 승인된 설계를 프롬프트에 **인라인**으로 주고, **어느 리비전에서 온 것인지(`rev-N`)를 명시**해 산출의 귀속을 유지한다. 경로 명시 요구는 `.harnie/`를 읽을 수 있는 위임 대상(designer·설계 리뷰어)에 적용된다.

위임받은 쪽이 참조 경로를 읽지 못했다고 보고하면 그 라운드의 산출은 **무효**로 보고, 참조를 고쳐 재위임한다. 기억으로 재구성한 결과는 절대 받아들이지 않는다.

## 실행 상태 + 강제 훅 (plan 전용 하네스 — `scripts/execution.mjs`)
plan 트랙은 **durable 실행 상태 + 최소 강제 훅**으로 두 불변식을 기계화한다: **① 승인 前 소스 쓰기 금지, ② 미승인·미완료를 done으로 확정 금지.** 권위 = planHash 고정 immutable `manifest.json` + 각 리뷰 단위 ledger·state + verification receipt(`execution.json`은 advisory 캐시일 뿐 신뢰하지 않는다 — 훅은 manifest+planHash로 승인을 판정하지 advisory phase를 믿지 않는다). 아래 스텝에서 `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`, `<repo>` = 이 run의 절대경로 **워크루트**다. 이는 세션 시작 디렉터리가 아니라 `/harnie:dev-full` bootstrap 훅이 컨텍스트 메시지(`hookSpecificOutput.additionalContext` 또는 `permissionDecisionReason`)로 보고한 전용 git worktree 경로다. 메시지를 찾을 수 없으면 `<main repo>/.harnie/sessions/<이 세션의 id>.json`의 `workroot` 필드에서 `<repo>`를 복구한다. **모든 `execution.mjs` 서브커맨드와 `loop.mjs apply`는 `--root <repo>` 필수**(없으면 즉시 종료). (`loop.mjs capture`/`delta`는 `<repo>`를 위치 인자로 받는다.) 상태 조작은 **반드시 `execution.mjs`로만**(직접 Edit/Write/Bash-write는 훅이 차단):
- **활성 run은 bootstrap 훅이 만든다 — 스킬이 직접 만들지 않는다.** `/harnie:dev-full`(또는 라우터 `/harnie:dev` → `Skill(harnie:dev-full)`) 호출 시 bootstrap 훅이 보고한 워크루트 안에 sentinel(`<repo>/.harnie/active.json`)과 `execution.json`을 이미 만들었다. **위 bootstrap 컨텍스트 메시지나 세션 바인딩 파일에서 `<repo>`를 해석하고, `<repo>/.harnie/active.json`을 읽어 `track === "plan"`을 확인한 뒤 그 `slug`(`<slug>`)를 아래 모든 CLI에 쓴다. `execution.mjs init`을 직접 실행하지 않는다.** 그 워크루트의 active.json이 없거나 손상이면 **중단하고 bootstrap 훅 실패를 보고**한다 — 자체 init으로 복구하지 않는다(부트스트랩 갭 재발; `bootstrap-adherence.md` 참조).
- **승인 바인딩(A5)**: plan.md에 기계 파싱 `harnie-manifest` 블록이 있어야 한다. 승인 질문 직전 `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "승인"`을 부르고 arm한 뒤, **바로 다음** 질문으로 실제 `AskUserQuestion`을 통해 승인을 받는다 — arm 후 **처음** 관찰되는 `AskUserQuestion` 호출이 일회성 승인 후보가 된다(질문 텍스트 대조가 아니라 순번 소비 방식이므로, 중간에 다른 질문을 끼워 넣으면 그 질문이 슬롯을 대신 소비한다). PreToolUse가 그 호출의 tool_use_id와 현재 planHash를 pending으로 기록하고, PostToolUse가 선택값이 정확히 "승인"이고 planHash가 그대로일 때만 바인딩한다(§PHASE A A5). **승인·threadId 등록은 CLI로 노출되지 않는다** — 훅이 실제 툴 호출을 관찰해 in-process로만 수행(sanctioned Bash로 self-승인 불가).
- **빌더 게이트(B2)**: 작업 위임 직전 `set-task --root <repo> --slug <slug> --task <id> --run-status building` + `seal --root <repo> --slug <slug>`(권위 스냅샷) → 빌더 산출 후 delta 귀속 前 `seal-verify --root <repo> --slug <slug>`(빌더가 권위 파일 훼손 시 fail-closed, exit 3).
- **검증(B4)**: `verify --root <repo> --slug <slug> --task <id>` — manifest의 `verification[]` argv를 shell 없이 실행해 receipt 기록(reviewedPostSHA 기준 scopeHash).
- **완료(B6)**: `completion --root <repo> --slug <slug>`으로 manifest 순회 재도출(현재 working tree ↔ 리뷰된 tree 바인딩까지). Stop 훅이 같은 재도출로 미완료 종료를 차단하므로, 최종 응답에 `HARNIE_STATUS` footer로 정직 보고한다.

## Notepad 프로토콜 (`notepad.md`, append-only, 단일 writer)
`notepad.md`는 위임 사이로 **재사용할 지식**을 나르는 공유 소스다. 동시 append 충돌을 피하려 **오케스트레이터(main)를 유일 writer**로 둔다:
1. **위임 前 read** — 이번 작업에 관련된 notepad 구간을 읽는다.
2. **필요한 것만 주입** — 그 구간을 producer(Codex 빌더/designer) prompt에 싣는다(전체 덤프 금지).
3. **결과 회수** — producer/reviewer가 발견·결정·검증 결과를 응답으로 반환한다.
4. **각 위임·리뷰 라운드 종료 직후 append** — main이 그 결과를 notepad에 **추가만** 한다(작업 전체가 아니라 라운드 단위).
5. **덮어쓰기·삭제 금지** — 기존 기록은 불변(append-only). 각 항목엔 짧은 `<entry-id>`를 단다. **stale·오류 지식은 기존 항목을 고치지 않고 `supersedes <entry-id>` 정정 항목을 새로 append**한다(불변 유지하며 최신성 확보).

**기록 대상(재사용 지식만)**: 새로 발견된 제약 · 승인된 결정 · 다음 작업에 영향 주는 사실 · 검증 결과와 evidence 경로 · 실패 원인과 재진입 근거. **일반 진행 로그는 넣지 않는다**(AI-slop 방지).

---

## PHASE A — PLAN (계획 단계)

**A0. 활성 run 채택(자체 init 금지).** bootstrap 훅의 컨텍스트 메시지에서 run 워크루트인 `<repo>`를 해석하고, 필요하면 `<main repo>/.harnie/sessions/<이 세션의 id>.json`에서 복구한다. bootstrap 훅이 그곳에 이미 이 호출의 `<repo>/.harnie/active.json`과 `execution.json`을 만들었다(phase=planning). 그 워크루트의 `.harnie/active.json`을 읽어 `track === "plan"` 확인 후 그 `slug`를 전 구간에 쓴다. 없거나 손상이면 **중단하고 bootstrap 실패 보고** — 절대 `execution.mjs init`으로 복구하지 않는다. sentinel이 있으므로 강제 훅이 승인 前 소스 쓰기·write 서브에이전트·workspace-write codex를 차단한다.

**A1. 범위비례 조사로 그라운딩.** `harnie-scout`(haiku)를 **병렬**로 스폰해 조사한다. 아래 각 항목에 대해 먼저 **존재·관련성**을 확인하고, **관련 있는 것만 충분히 깊게** 추적한다(무관한 영역까지 깊게 파는 건 scope inflation):

- 영향 코드와 그 **호출 경로**(caller·callee),
- 그 영역을 덮는 기존 **테스트**,
- **설정·환경 변수**,
- **데이터/스키마·마이그레이션**,
- **외부 연동·API**,
- 관련 **문서/ADR·저장소 지침**(`AGENTS.md`·`CLAUDE.md`·`README`·팀 컨벤션),
- 컨벤션을 따를 **유사 기존 구현**.

추정 전에 실제 파일·인터페이스·의존성·컨벤션을 근거로 잡는다.

**A2. 질문은 CLEAR/UNCLEAR 라벨이 아니라 근거로 결정한다.**

- 코드·테스트·설정·문서에서 **확인·추론 가능한 것은 묻지 않는다**(먼저 A1로 조사).
- **다음일 때만 질문한다**(도출 불가 + 오추정 비용이 큰 것에 한정): (a) **사용자만 정할 수 있는 제품·정책 의도**(어디에도 안 적힌 동작·UX·트레이드오프), (b) **유효한 해석이 실질적으로 갈리는** 모호한 요구, (c) 오추정 시 **상당한 재작업·호환성 파괴**를 부르는 결정, (d) 추론 불가한 **외부 컨텍스트** — 자격증명의 **소스/설정**·타깃·계정(소스/설정만 묻고 비밀값은 절대 요청하지 않는다).
- **질문 전에** 조사한 근거·**확인 못 한 부분**·**선택지별 영향**·권장 기본값(WHY)을 제시한다.
- **묶음 한도**: 설계 발견 라운드 **한 번에 최대 3개**, 포괄·복합 질문 금지. (A5 승인 질문은 별개이며 여기 셈에 안 든다.)
- **해소되지 않았지만 진행을 막지 않는 불확실성**(모든 비질문 항목이 아니라)만 기본값과 함께 `plan.md`의 `## Assumptions` 섹션에 기록한다 — announce만 하지 않는다 — 설계 리뷰·승인 게이트가 볼 수 있게.

**A3. 아키텍처 설계(정식) + 리뷰 루프 (조건부).** `harnie-designer`(opus/max)에게 **아키텍처 설계를 "정식으로"** 요청한다 — 위임 프롬프트에 `design-authoring-arch.md`의 **정식 섹션 계약을 인라인 주입**하고 `architecture, formal`을 신호한다(서브에이전트는 프로필이 자동 로드되지 않음). 시스템 경계·데이터 소유권·기술선택·SPOF에 집중, 클래스·SQL로 안 내려감. main은 받은 설계를 **그것을 참조하는 위임 前에** `.harnie/plan/<slug>/design/rev-N.md`에 쓰고(§위임 참조 규칙), 같은 리비전을 `plan.md`의 아키텍처 섹션에 기록한다.
- **조건부**: 경계/데이터 소유권/기술 선택이 실제로 **바뀔 때만** 이 단계를 수행한다. 기존 아키텍처가 그대로면(그 안의 큰 상세 작업) skip하고 A4로 간다 — 근거 없는 정식 아키 단계는 scope inflation.
- 수행 시 → **아키 설계 리뷰 루프**(review-loop-driver.md, producer=designer, 기준=design-review.md **아키 고도 렌즈**: 경계·소유권·기술선택·SPOF, namespace `DR`, `<dir>`=`.harnie/plan/<slug>/review/design-arch/`)를 APPROVE까지. R1의 delta 대신 아키 설계를 codex `prompt`에 싣고 **그 리비전이 담긴 `design/rev-N.md` 경로를 함께 명시**한다(나머지 R2~R5 동일).
- 리뷰 라운드에 답하는 각 개정본은 **새 `rev-N.md`**이며, 재리뷰 위임 前에 먼저 쓴다. 이전 파일이나 tool-result blob을 가리켜 재리뷰하지 않는다.

**A4. 상세 설계(정식) + 리뷰 루프.** 승인된 아키(또는 기존 아키) 위에서 `harnie-designer`(opus/max)에게 **상세 설계를 "정식으로"** 요청한다 — 위임 프롬프트에 `design-authoring-detail.md`의 **정식 섹션 계약을 인라인 주입**하고 `detailed design, formal`을 신호(요구 추적표·핵심 처리 로직·계약·데이터/상태·작업 분해, decision-complete 수준). 아키 결정을 조용히 바꾸지 않는다(바꿔야 하면 A3로 되돌려 아키 변경 요청). main은 받은 설계를 그것을 참조하는 위임 前에 다음 `.harnie/plan/<slug>/design/rev-N.md`에 쓰고, 같은 리비전을 `plan.md`의 상세 섹션에 기록한다.
- → **상세 설계 리뷰 루프**(A3와 **독립** — 별도 ledger·state, producer=designer, 기준=design-review.md **상세 고도 렌즈**: decision-completeness·요구충족·실패모드, namespace `DR`, `<dir>`=`.harnie/plan/<slug>/review/design-detail/`)를 APPROVE까지. A3와 동일하게 **R1 git-delta 대신 상세 설계를 리뷰어 prompt에 싣고 그 `design/rev-N.md` 경로를 명시한다**(설계 파일은 `.harnie/`/git 관리라 delta 비적용).
- 두 루프 모두 설계 오류를 **구현 전에** 잡는 게 목적. STALLED면 사용자 보고. (아키·상세는 각각 독립 리뷰 — 아키 APPROVE 후 상세로.)
- **리뷰 지적 반영 순서 — 충족안을 쓰기 前에 두 질문에 먼저 답한다(두 루프 공통).** 각 REJECT 지적에 대해 이 순서로: ① 이 지적이 상정한 위협/실패가 **위협모델 안**인가(`§0.1` — 실수하는 fallible·over-eager 오케스트레이터/빌더가 대상이고, 세션을 통제하는 적대적 main은 비목표)? ② **이 기구가 존재해야 하는가**, 아니면 설계에 이미 있는 것으로 덮이는가? 두 답을 낸 뒤에야 어떻게 충족할지 쓴다. 매 REJECT를 "어떻게 충족하지?"로만 받는 것이 claim·lease·영수증·해시 식별자를 리비전마다 누적시키고, 되돌리는 데 라운드를 여러 번 쓰게 만든 원인이다.
- **기구를 새로 추가하는 반영은 근거를 함께 남긴다**: 그 기구가 막는 **구체적 실수 시나리오 1개 이상**을 새 `design/rev-N.md`의 `## Revision Notes`에 기록한다. 근거를 못 대면 기구를 추가하지 말고, 다음 라운드에 위 두 답을 제시해 리뷰어에게 **blocking 요구 철회**를 요청한다. ledger는 리뷰어의 다음 응답으로만, 그리고 `mergeLedger`가 받는 형태로만 움직인다: 리뷰어가 **원래 ID를 `resolved`로 닫고**(현재 범위·결정 하에서 그 위험이 더는 해당 없음), 기록할 가치가 남으면 **새 `non-blocking` ID를 연다**. 같은 ID를 blocking→non-blocking으로 재라벨하는 것은 `scripts/ledger.mjs`에서 fail-closed이므로 요청하지도 말고, `ledger.json`·verdict를 손으로 고치지도 않는다.
- **기계 파싱 manifest 블록(승인 대상)**: 상세 설계의 작업 분해가 확정되면 `plan.md`에 ` ```harnie-manifest ` 펜스로 JSON 블록을 넣는다 — `{tasks:[{id, deps, reviewUnit, scope:[<경로>], verification:[{executable, args, cwd, timeout}]}], gates:[{name, reviewUnit}]}`. `reviewUnit`은 task·gate 전부 유일(리뷰 디렉터리명), `scope`는 그 작업이 만질 경로, `verification`은 shell 없이 실행할 argv(런타임 증거 강제) — **각 항목은 아래 A5.0 증거 검사를 통과해야만 등록된다**. gates = Final Wave 4종(`coverage`·`quality`·`runtime`·`scope`, reviewUnit=`final-<name>`). 이 블록이 A5 승인 시 immutable `manifest.json`으로 고정되고 planHash로 봉인된다(권위 집합).

**A5. 승인 게이트 (1회, 실제 승인 툴에 바인딩).**

**A5.0 — 검증 명령이 실제로 무언가를 실행·검사하는지 등록 前에 입증한다(필수, arm 前).** manifest의 `verification[]`는 `verify`가 앞으로 만들어낼 **유일한 런타임 증거**다. 아무것도 훑지 않는 항목은 아무것도 검증하지 않으면서 영원히 통과한다. 승인 前 Bash는 H1이 read-only 명령으로 제한하므로, **그 게이트가 허용하는 가장 강한 방법으로** 각 항목을 입증하고 결과를 `plan.md`의 manifest 블록 옆에 기록한다:

- **read-only 질의 항목**(`rg`·`grep`·`git ls-files`·`jq` 등): argv를 **적힌 그대로** 1회 실행하고 `exitCode`와 **매치 수**를 기록한다. 매치 0건 → 등록하지 않는다.
- **인터프리터·테스트 러너가 필요한 항목**(`node --test`·`npm test`·`tsc --noEmit` 등): 승인 前에는 **실행할 수 없고, 실행시키려고 게이트를 느슨하게 하지 않는다** — 승인 前 repo 코드 실행은 H1이 막는 쓰기 primitive 그 자체다. 대신 **입력 집합**을 read-only 탐색 명령으로 입증하고(그 러너의 패턴이 수집할 파일 목록) 개수를 기록한다. 0이면 그 항목은 아무것도 검증하지 않는다. 조용히 새는 경우는 **아무것도 매치하지 않는 패턴 인자**다: `node --test 'scripts/*.test.mjs'`는 매치 파일이 없으면 `# tests 0`을 찍고 **exit 0**이다(Node v21.6.2에서 실행 확인). manifest argv는 shell 없이 실행되므로 그런 패턴은 러너에 문자 그대로 전달된다 — 매치 목록을 먼저 뽑고, 입력을 열거해 둔 argv를 우선한다.
- **"비어 있음"과 "조용함"은 다르다.** `tsc --noEmit`·quiet 린터·스키마 검사기는 성공 시 아무것도 출력하지 않는다 — 그건 통과지 빈 증거가 아니다. **비어 있음은 그 명령이 아무것도 훑지 않았다는 뜻**이다(매치 0·수집된 테스트 0·검사한 파일 0). silent-success 도구는 출력 크기가 아니라 **도구 자신이 알려주는 수**(파일 목록·verbose 플래그·보고된 입력 수)로 확인한다.
- **하류 백스톱은 없다 — 이 게이트가 유일하다.** `verify`는 argv를 `stdio: "ignore"`로 실행하고 receipt에는 `{executable, args, exitCode}`만 기록하므로([execution.mjs:734](scripts/execution.mjs:734)), 이후 어떤 단계도 "테스트 200개 실행"과 "0개 수집"을 구별하지 못한다. 게다가 승인 후 manifest는 immutable이고 `set-phase`는 `planning` 역전이를 거부하므로([execution.mjs:775](scripts/execution.mjs:775)), 껍데기 항목은 **그 run 안에서 고칠 수 없다**: 정직한 결말은 그 항목을 지목해 `HARNIE_STATUS: INCOMPLETE`로 보고하고 판단을 사용자에게 넘기는 것뿐이다. 여기서 맞게 잡아라.

몇 초면 확인되는 함정: `rg -e A -e B`는 AND가 아니라 **OR**, `rg --files-without-match`는 의도한 폴라리티를 뒤집는다. 실패할 수 없는 명령은 검증이 아니다.

> 이 단계의 올바른 기계화는 `scripts/execution.mjs`의 엔진 측 변경 2개이지 **Bash allowlist 확대가 아니다**: `dry-run` 서브커맨드(sanctioned CLI라 승인 前 실행 가능) + verify receipt에 **실행량 증거 필드**(출력 캡처 또는 훑은 개수)를 넣어 완료 재도출이 껍데기 통과를 거부할 수 있게 하는 것. 그것이 생기기 전까지는 위 검사가 계약이다.

**A5.1 — 승인 요청.** 리뷰 통과한 `plan.md`(아키+상세 설계 + 작업 분해 + 검증 전략과 그 A5.0 증거 + Final Wave + `harnie-manifest` 블록)를 사용자에게 제시한다. 그다음 **① `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "승인"`**을 부르고, **② 바로 그 다음**에 `AskUserQuestion`으로 승인 질문을 묻는다 — arm 이후 **처음** 관찰되는 `AskUserQuestion` 호출에 훅이 바인딩하므로(armed 질문과의 텍스트 대조가 아니라 일회성 순번 소비), 중간에 다른 질문을 끼워 넣으면 그게 슬롯을 대신 소비해 승인이 막혀버린다. 옵션 라벨은 선택 값만으로 승인/거절이 구분되게(예: `승인` / `거절·수정`). PreToolUse 훅이 그 호출의 tool_use_id와 현재 planHash를 pending으로 기록하고, PostToolUse 훅이 **선택 값이 정확히 "승인"이며 planHash가 그대로일 때만** manifest를 확정하고 phase=executing으로 연다(over-eager main의 self-승인·질문 후 몰래 plan 변경 차단; `set-phase`로는 executing 진입 불가). 거절·planHash 불일치면 awaiting-approval 유지(fail-closed). 승인 확정 후 → PHASE B. (A3·A4 설계 리뷰가 이미 건전성 게이트이므로 승인은 1회.)

---

## PHASE B — EXECUTE (실행 단계)

**B1. 플랜 파싱 → 작업별 파일 스코프 부여 → 실행 경로 선택.** manifest의 모든 태스크는 이미 `scope`(만질 경로, A4의 `harnie-manifest` 스키마)를 선언한다 — **경로만, glob 아님**: `loop.mjs delta`의 `outOfScope` 검사는 변경된 각 경로를 정확 일치 또는 디렉터리-접두어로만 대조하지 glob 확장을 하지 않으므로, 와일드카드 항목을 넣으면 실제 변경 전부가 범위 밖으로 오탐된다. 위임 前에 모든 태스크 쌍의 `scope`가 **비중첩**인지 확인한다 — 어떤 경로도 두 태스크의 `scope`에 동시에 나오거나(또는 한쪽의 상위/하위 디렉터리이거나) 하면 안 된다. 겹치면 분해 실패다: A4로 돌아가 겹치지 않게 manifest를 고치고 A5 승인을 다시 받은 뒤 진행한다. 비중첩 스코프는 병렬 실행의 **전제조건**이며, 여기서 한 번 확인하는 것이지 런타임 가드가 아니다.

그다음 경로를 고른다:
- **직렬 경로 — 태스크 1개, 또는 총 규모가 작아 격리로 얻을 게 없을 때.** 아래 B2~B3를 그대로 진행: worktree 없이 빌더 1개, 리뷰 루프 1개, run worktree에서 직접.
- **병렬 경로 — 태스크 ≥2개이고 스코프가 비중첩일 때.** 아래 B2′~B3′로 진행: 태스크마다 격리 worktree를 갖고 병렬로 빌드·리뷰한 뒤 하나씩 merge한다. manifest `deps`가 다른 태스크를 지정한 태스크는 그 의존 태스크의 B3′ **4단계 확인이 APPROVE된 후에만**(merge만으론 부족 — 거기서 REJECT되면 그 태스크의 코드가 다시 바뀔 수 있다) 시작한다 — 오케스트레이터가 손으로 적용하는 순서 규칙 한 줄이며, 이를 위한 스케줄러·의존 그래프 실행기·자동 재시도는 만들지 않는다.

### 직렬 경로

**B2. 작업 → Codex 빌더 위임 (개발 producer = Codex).** 위임 직전 순서로: ① `execution.mjs set-task --root <repo> --slug <slug> --task <id> --run-status building`(빌더 workspace-write codex 부트스트랩을 훅이 이걸로 게이트) → ② `loop.mjs capture <repo>`로 baseline 캡처(B3 R1 fix-delta 기준점) → ③ `execution.mjs seal --root <repo> --slug <slug>`(권위 스냅샷). 그다음 **Codex 빌더**(codex MCP, `sandbox:"workspace-write"`, `cwd:<repo>`)에게 위임 — 프롬프트에 작업 지시 + **승인된 `plan.md`의 해당 설계 섹션**을 실어 리뷰된 설계대로 짓게 한다. 6-section 계약(요구/설계간단/구현/견고함/테스트/검증). surgical scope. **빌더는 `.harnie/`에 접근하지 않는다**(권위 상태는 오케스트레이터·CLI 소유). threadId는 PostToolUse 훅이 성공한 codex를 관찰해 등록(재수정은 codex-reply).

**B3. ★ 코드 리뷰 루프, run worktree(크로스-모델; 완료 판정의 정본 리뷰 유닛 — 두 경로 모두 여기로 수렴).** 빌더 산출 직후 delta 귀속 前 **`execution.mjs seal-verify --root <repo> --slug <slug>`**(빌더가 권위 파일을 실수로 훼손했으면 fail-closed → 그 라운드 무효·보고). 통과하면 review-loop-driver.md R1~R5:
- producer = **Codex 빌더**, **리뷰어 = read-only `harnie-reviewer` 서브에이전트**(main 인라인 아님 — 빌더가 Codex라 크로스-모델, 리뷰어는 쓰기 불가). 기준 = code-review.md + verification-tiers.md. namespace = `CR`. `<dir>` = `.harnie/plan/<slug>/review/<unit>/`(manifest의 그 작업 `reviewUnit`, **run worktree 안**).
- 리뷰어는 loop.md VERDICT/ISSUES 스키마로 `round-N.txt`에 기록. `apply`엔 **이 라운드 delta의 `postSHA`를 `--artifact`로** 넘긴다(CR 필수 — execution.mjs가 이 tree에서 `reviewedScopeHash` 재계산해 검증을 리뷰 tree에 바인딩). 수정 → 델타만 재리뷰(Codex 빌더 codex-reply). 전 차원 APPROVE까지.
- **병렬 경로** — 기준·namespace·`<dir>`은 같고, 태스크마다 run worktree에서 돈다:
  - **타이밍:** 그 태스크의 B3′ merge가 반영된 **후, 그 태스크 worktree가 제거되기 前**(아래) — B2′ 빌드 직후도 아니고, worktree가 사라진 뒤도 아니다. `execution.mjs verify`/`completion`이 실제로 읽는 것은 이 라운드, 이 `<dir>`이다. 태스크 worktree 안에서의 머지 前 리뷰(B2′ 5단계)는 격리된 코드에 대한 앞선 품질 게이트일 뿐, 이를 대체하지 않는다.
  - **Baseline·scope:** R1 baseline = B3′ 1단계에서 그 태스크의 merge 직전에 캡처한 `mergeBaselineSHA` — 그래야 이 라운드가 리뷰하는 delta가 그 merge(와 있었다면 충돌 해결 커밋)가 들여온 것 정확히 그만큼이지, 뒤 태스크의 것이 안 섞인다. `--scope`는 그 태스크의 선언된 `scope` **더하기** 충돌 해결이 그 밖에서 건드린 경로(B3′ 3단계)까지 함께 넘긴다 — 후자를 빼먹으면 `delta`의 `outOfScope` 검사가 해결 편집을 귀속 안 된 외부 변경으로 오탐한다.
  - **사전 맥락:** 태스크의 머지 前 verdict·라운드 수(run의 `notepad.md`로 전달, B2′ 참조)를 리뷰어에게 제공해, 이 라운드가 완전 재스캔이 아니라 **경량 확인**(merge된 결과와 merge 자체가 바꾼 부분 확인)이 되게 한다.
  - **seal-verify 반복 금지:** 이 라운드 서두에 `execution.mjs seal-verify`를 다시 돌리지 않는다 — B3′ 3단계가 아직 어떤 리뷰 라운드 파일도 없을 때 이미 한 번 돌렸다. 여기서 또 돌리면 그 단계가 정당하게 써 넣은 `merge-t<id>` ledger·state를 훼손으로 오판한다.
  - **REJECT 시:** 태스크 worktree와 그 빌더 스레드가 **아직 존재한다**(B3′가 정확히 이걸 위해 이 라운드 이후로 제거를 미룬다 — 5단계 참조). 그 자리에서 같은 Codex 빌더에게 `codex-reply`로 수정을 요청하고, `harnie/<slug>-t<id>`에 커밋(B2′ 6단계와 동일)한 뒤 — merge 前에 캡처, B3′ 1단계와 같은 순서 — 새 `mergeBaselineSHA`를 먼저 캡처하고 `worktree.mjs merge`를 **다시**(같은 브랜치의 새 커밋만 들여오는 두 번째, 증분 merge) 돌려 그 새 baseline부터의 delta만 재리뷰한다. 이미 등록된 빌더 스레드만 재사용하며, 이미 바인딩된 태스크에 두 번째 빌더를 새로 부트스트랩하는 것과 달리 엔진에 없는 능력이 필요 없다.

### 병렬 경로

**B2′. 태스크별 빌드(worktree 격리; 동시성은 위 알려진 의존성에 의해 제한됨 — `registerBuilderAuto` 항목 참조).** 태스크마다 독립적으로 아래를 수행 — 위 의존성이 해결되면 태스크 간 동시 진행 가능하지만, 오늘은 한 번에 한 태스크의 B2′ 빌더 호출(4단계)만 threadId 등록이 된다:

1. **태스크 worktree 생성.** `node <ROOT>/scripts/worktree.mjs create --repo <repo> --branch harnie/<slug>-t<id> --from harnie/<slug>` → stdout JSON `{worktreePath, created}`; `<taskWt>` = `worktreePath`. 분기점 = run 브랜치(`harnie/<slug>`, 즉 run worktree 자신의 현재 브랜치). 이미 그 브랜치의 worktree가 있으면 `create`는 멱등하다 — 다른 브랜치에 이미 붙어 있는 게 아닌 한 에러 대신 `{worktreePath, created:false}`를 돌려준다.
2. **태스크 상세설계, 경량.** `harnie-designer`(read-only)에게 이 태스크 하나만의 **경량** 상세설계를 요청한다 — `design-authoring-detail.md`의 Lightweight Output 계약을 인라인 주입("formal" 신호 **금지**), run의 승인된 `plan.md` 아키/상세 섹션 + 이 태스크의 manifest 항목(id·scope·verification)을 입력으로 준다. 결과를 `<taskWt>/.harnie/design/rev-1.md`에 쓴다 — PHASE A 위임 참조 규칙과 동일한 디스크-정본 원칙을, `.harnie/plan/<slug>/` 대신 태스크 worktree로 스코프만 바꿔 적용.
3. **태스크 설계 리뷰, 1 루프, 스코프만 축약이지 기구는 축약 아님.** review-loop-driver.md의 설계 리뷰 루프를 돌린다: producer=designer, 리뷰어=Codex(`sandbox:"read-only"`), 기준=design-review.md 상세 고도 렌즈, namespace `DR`, `<dir>`=`<taskWt>/.harnie/review/design/`. A4와 **같은 DR 상태기계**를 APPROVE까지 돌리는 것이다 — "축약"은 이미 아키가 확정된 단일 태스크의 경량 설계라는 **작은 범위**를 뜻하지, REJECT/REVISING을 건너뛰는 지름길이 아니다. REJECT면 그대로 `rev-2.md`를 만들고 재리뷰한다.
4. **빌드.** `execution.mjs set-task --root <repo> --slug <slug> --task <id> --run-status building`을 실행(직렬 B2의 ①과 같은 목적 — 이 태스크를 빌더-부트스트랩 후보로 표시)하고, baseline 캡처(`node <ROOT>/scripts/loop.mjs capture <taskWt>`) 후 **Codex 빌더**(codex MCP, `sandbox:"workspace-write"`, `cwd:<taskWt>`)에게 위임 — 호출자가 모델을 고를 수 있으면 고성능 모델(예: `gpt-5.6-sol`), 아니면 설치 기본값. 태스크의 승인된 경량 설계 + manifest scope를 실어주고, B2와 같은 6-section 계약을 적용한다.
5. **코드 리뷰, 머지 前 품질 게이트.** fix-delta 캡처(`node <ROOT>/scripts/loop.mjs delta <taskWt> <baselineSHA> --scope <task-scope-paths> --out <taskWt>/.harnie/review/code/delta.patch`). 리뷰어 = read-only **`harnie-reviewer`**(빌더의 프로바이더와 달라야 함). `apply`: `node <ROOT>/scripts/loop.mjs apply --root <taskWt> --ledger <taskWt>/.harnie/review/code/ledger.json --review <taskWt>/.harnie/review/code/round-N.txt --ns CR --state <taskWt>/.harnie/review/code/state.json --artifact <postSHA>`. REJECT → codex-reply가 델타만 수정 → 재리뷰, B3와 같은 방식으로 APPROVE까지.
6. **승인된 작업을 커밋한다 — 태스크의 선언된 경로로만 스코프, 맨 `-A` 금지.** `loop.mjs`의 capture/delta는 working tree를 다룰 뿐 git history를 다루지 않으므로, 위 어디에도 커밋이 없다 — 그런데 `worktree.mjs merge`(B3′)는 브랜치를 merge하고, 그러려면 커밋이 있어야 한다. 5단계가 APPROVE에 도달하면 `<taskWt>` 안에서: `git add -A -- <태스크의 선언된 manifest scope 경로들>` 후 `git commit`. **스코프 경로로 스테이징한다, `git add -A -- . ":(exclude).harnie"`도 맨 `git add -A`도 아니다** — `.harnie/`는 gitignore 대상이 아니므로(위 노트 참조, 왜 아니면 안 되는지) 둘 다 이 태스크의 `design/rev-N.md`와 리뷰 루프 기록까지 실제 소스 변경과 나란히 스테이징해버린다(exclude pathspec도 도움이 안 된다: 일반적인 비-sanctioned `git add` 명령 텍스트에 든 리터럴 `.harnie`가 Bash 가드의 포괄적 `.harnie` 보호에 그대로 걸려 거부된다 — 5단계의 `delta`/`apply`와 달리 이 `git add` 호출은 sanctioned CLI가 아니므로 이 가드가 여전히 적용된다). 그렇게 스테이징되면 `worktree.mjs merge`가 그 `.harnie/` 내용을 run 브랜치에 커밋해 넣어 그 시점부터 run worktree의 추적 tree를 영구히 오염시킨다. 스코프 경로만 이름하면 명령에 `.harnie`가 전혀 등장하지 않으므로 가드에 걸리지 않는다. 커밋은 working tree를 바꾸지 않으므로 5단계의 `--artifact` 검사를 훼손하지 않는다.

이 태스크의 B3 확인 라운드(B3′ 4단계)를 돌리기 前에, run의 `notepad.md`에 태스크마다 항목 하나를 append한다: 그 태스크의 설계·코드 리뷰 verdict와 라운드 수. B3의 확인 라운드가 이걸 사전 맥락으로 읽고(위 B3의 병렬-경로 노트 참조), worktree가 나중에 제거되면(B3′ 5단계) 이게 태스크 리뷰의 유일한 흔적이 된다 — 기록이지, 확인 라운드의 대체물이 아니다.

**B3′. 순차 통합, 한 번에 태스크 하나씩.** B2′에서 APPROVE에 도달한 태스크부터 run 브랜치로 통합한다 — 여러 태스크가 병렬로 빌드를 마쳤어도 **한 번에 하나씩**(유일한 필수 직렬화 지점). "한 번에 하나씩"은 한 태스크의 **B3′ 전체**(1~5단계)를 뜻하지 그 merge만이 아니다: 현재 태스크의 5단계(worktree 제거)가 끝나기 前엔 다음 태스크의 1단계(baseline 캡처)를 시작하지 않는다 — 진행 중인 태스크의 미해결 상태 위에 두 번째 merge가 동시에 얹히면, 그 태스크 자신의 확인 라운드 delta가 귀속 안 된 잡음으로 오염된다.

1. **그 태스크의 merge 직전에 run worktree의 baseline을 캡처하고 권위를 스냅샷한다:** `node <ROOT>/scripts/loop.mjs capture <repo>`(`<repo>` = run worktree) → `mergeBaselineSHA` — B3 확인 라운드(4단계)가 대조할 R1 baseline이 이것이므로, 여기서 캡처해야지 더 일찍 캡처하면 안 된다(더 일찍이면 앞 태스크의 merge가 이미 들여온 것까지 포함돼 버린다). 그다음 `node <ROOT>/scripts/execution.mjs seal --root <repo> --slug <slug>`. **여기서, merge 前에 한 번만** seal한다 — 나중이 아니라. `execution.mjs`의 권위 해시는 `.harnie/plan/<slug>/` 아래 모든 `review/*/{ledger,state,receipt}.json`을 훑는데, 3단계 자체의 충돌 해결 리뷰(있다면)가 정당하게 새 파일 하나를 쓴다 — 그 뒤에 seal하면 나중의 `seal-verify`가 그 정당한 기록을 훼손으로 본다.
2. `node <ROOT>/scripts/worktree.mjs merge --repo <repo> --branch harnie/<slug>-t<id> --into harnie/<slug>`(`<repo>`의 현재 체크아웃 브랜치가 이미 `into`여야 한다 — run worktree는 항상 자기 브랜치에 있으므로 구조적으로 항상 성립). 내부적으로 `git merge --no-ff --no-edit`를 돈다. stdout은 성공 시 JSON `{ok:true, conflicts:[]}`, 충돌 시 `{ok:false, conflicts:[<경로들>], stderr}` + exit 3.
3. **권위를 확인한 뒤 merge 결과를 처리한다:**
   - **클린 merge(exit 0):** `node <ROOT>/scripts/execution.mjs seal-verify --root <repo> --slug <slug>`를 한 번 돈다. `.harnie/`는 애초에 어떤 브랜치에도 커밋된 적이 없으므로 merge가 결과와 무관하게 그걸 건드릴 수 없다 — 이 호출은 merge 자체가 아니라 이 구간에 다른 무언가가 권위를 건드렸는지 잡기 위함이다.
   - **충돌(exit 3):** merge는 미해결 상태로 남고 충돌 파일이 stdout에 나열된다. **손대기 前, 이 충돌 상태 그대로 baseline을 지금 캡처한다:** `node <ROOT>/scripts/loop.mjs capture <repo>` → `resolveBaselineSHA`. (해결 *후에* 캡처하면 해결된 tree를 자기 자신과 비교하게 돼 빈 delta가 나오고, 아무것도 리뷰하지 않은 라운드가 조용히 APPROVE된다.) 손으로 해결하고 해결 커밋을 만든 뒤 `execution.mjs seal-verify --root <repo> --slug <slug>`를 돈다 — 해결은 추적되는 소스 파일만 건드렸으니 통과해야 정상이다. 불일치면 다른 무언가가 권위를 바꾼 것이고 이 라운드는 무효다(seal-verify가 쓰이는 다른 모든 곳과 같은 판정). 통과하면 **그 델타에 대해서만 CR 라운드 1회**를 돈다: `loop.mjs delta <repo> <resolveBaselineSHA> --scope <해결이 건드린 경로> --out .../review/merge-t<id>/delta.patch` 후 `.harnie/plan/<slug>/review/merge-t<id>/` 아래 apply(B2′ 5단계와 같은 방식, run worktree에 뿌리). 이 태스크는 이 라운드가 APPROVE되기 전엔 4단계로 넘어가지 않는다(위 헤더에 따라 다음 태스크의 B3′도 마찬가지). **해결이 이미 merge·확인된 앞선 태스크의 선언된 `scope`** 안쪽 경로를 건드렸다면(이 태스크의 것만이 아니라), 그 앞선 태스크의 B4 receipt는 이제 stale이다 — 계속하기 前에 그 태스크의 B3 확인(새 baseline을 지금 캡처, 그 앞선 태스크의 선언된 `scope`로 delta 범위 지정, 그 기존 `<dir>`에 리뷰·apply)과 B4 verify를 현재 tree에 대고 재실행한다. 뒤 태스크만 반려·rebase하는 것으로는 앞선 태스크의 바인딩이 고쳐지지 않는다.
   어느 쪽이든, 아래 4단계의 B3 확인 라운드 서두에서 `seal`/`seal-verify`를 반복하지 않는다 — 이 쌍이 이미 그 전제조건을 충족했다(위 B3의 병렬-경로 노트 참조).
4. **이 태스크의 B3 확인 라운드(위)를 run worktree에서** 1단계의 `mergeBaselineSHA`부터 현재 tree까지 — 즉 merge와 (있었다면) 3단계의 충돌 해결 커밋까지 포함해서 — 돌린다. 태스크 worktree를 제거하기(5단계) **前에** 한다: REJECT되면 아직 존재하는 태스크 worktree와 아직 등록된 빌더 스레드로 수정이 돌아간다(위 B3의 병렬-경로 노트 참조 — `codex-reply`·커밋·재-merge·재리뷰). 이 라운드가 APPROVE된 후에만 5단계로 진행한다.
5. `node <ROOT>/scripts/worktree.mjs remove --repo <repo> --branch harnie/<slug>-t<id>` — `--delete-branch` 플래그 없이(기본이 이미 브랜치를 유지한다). 이 스킬 자신의 설계상 이 시점 모든 태스크 worktree에 `.harnie/` 내용이 남아 있어도(2~3단계가 `design/rev-N.md`·`review/design/…`를, 5단계가 `review/code/…`를 쓰고 6단계는 절대 커밋하지 않으므로) 이제 성공한다: `worktree.mjs remove`가 태스크 worktree의 `.harnie/`를 먼저 git-제외된 임시 스태시 디렉터리로 옮기고, plain `git worktree remove`를 시도한 뒤, 그게 성공했을 때만 스태시를 지운다 — 제거가 (더티 tree든 locked worktree든 submodule이든 그 밖의 어떤 이유로든) 실패하면 에러를 던지기 前에 `.harnie/`를 원위치로 되돌리므로, 실패한 **이유가 무엇이든** 아무것도 유실되지 않는다. 그래도 실패하면(예: `.harnie/` 밖의 정말 예상 밖인 untracked 내용), 손으로 `.harnie/`를 지우거나(delta/apply와 같은 이유로 Bash `rm -rf`가 막힌다) 지원 안 하는 플래그를 넘기지 말고, STOP하고 보고한다.

뒤 태스크의 델타가 앞서 이미 merge된 태스크가 만졌던 경로를 건드리는 경우(B1 검사는 선언된 `scope`만 대조했지 실제 diff는 아니므로 여기서 놓칠 수 있음) — B1 겹침과 똑같이 처리한다: 뒤 태스크의 빌드를 반려하고, 그 worktree를 갱신된 run 브랜치 위로 rebase한 뒤 merge 前 재리뷰한다.

### 두 경로 공통

**B4. 작업별 검증.** `execution.mjs verify --root <repo> --slug <slug> --task <id>`를 **run worktree**에서, 그 태스크의 B3 확인 라운드 후에 실행한다 — manifest의 `verification[]` argv를 shell 없이 실행해 exitCode·scopeHash·planHash receipt를 기록한다(reviewedPostSHA 기준). 추가로 Manual QA(자동으로 못 잡는 사용자 가시 동작) + `plan.md` 재읽기로 범위 대조. 완료는 **ledger APPROVE ∧ receipt pass**로 재도출되므로(권위), 검증 실패·코드 재변경은 자동으로 미완료가 된다.

**B5. Final Wave (규모비례, 병렬) — 게이트 `Coverage·Quality·Runtime·Scope`.** 전체가 하나로 맞물리는지 run worktree에서 최종 확인 — B1이 직렬·병렬 어느 경로를 골랐든 이 시점엔 모든 태스크가 한 tree로 merge돼 있으므로 무관하다. **각 게이트를 별개 리뷰 단위로** review-loop-driver.md로 구동(namespace `CR`, `<dir>`=`review/final-<gate>/` — `coverage`·`quality`·`runtime`·`scope`):
- **Coverage** — plan.md·설계 결정·요구 ID를 실제로 **전부 충족**했나(커버 안 된 FR/NFR = under-build).
- **Quality** — 정확성·안전성·과설계(code-review.md 렌즈 전체).
- **Runtime** — 실제 실행 검증(verification-tiers.md, 통합 경계 포함). 미검증 위험 = REJECT.
- **Scope** — 요청 범위만 완결, 요청 안 한 것 안 만듦(scope inflation = over-build 차단).
- 리뷰어 = read-only **`harnie-reviewer`**(코드 단계이므로; 빌더=Codex의 반대). 각 게이트도 `apply`에 그 시점 tree의 `--artifact <postSHA>`를 넘긴다. 전부 APPROVE, **실패한 게이트만 재실행**. 기본 Claude 단독, 사용자가 "고정밀" 요청 시 dual(Codex 최종 사인오프 auxiliary 추가).

**B6. Report + 완료 재도출.** `execution.mjs completion --root <repo> --slug <slug>`으로 manifest를 순회해 완료를 재도출한다(각 task = ledger APPROVE ∧ receipt pass ∧ 현재 scope==리뷰 scope, 각 gate = ledger approved ∧ 현재 전체 tree==리뷰 tree). 요약: 변경 파일 + 작업별 tier·검증 증거 + 각 리뷰 단위 최종 verdict(ledger·round) + Final Wave 4게이트 verdict. **최종 응답 말미에 machine-readable footer를 emit한다**: 재도출이 complete면 `HARNIE_STATUS: COMPLETE`, 아니면 `HARNIE_STATUS: INCOMPLETE — <남은 blocker 요약>`. Stop 훅이 같은 재도출로 판정하므로, 권위상 미완료인데 COMPLETE라 주장하거나 footer를 빠뜨리면 종료가 차단된다. 남은 blocking·STALLED 단위·미검증 범위는 정직하게 INCOMPLETE로 보고하고 제어권을 반환한다.

---

## 불변
- **모든 수정은 반드시 리뷰된다.** 아키 설계 리뷰(A3)·상세 설계 리뷰(A4)·병렬 경로의 태스크별 설계·코드 리뷰(B2′)·머지 충돌 해결 리뷰(B3′)·run 레벨 코드 리뷰(B3)·Final Wave(B5) 모두 동일한 review-loop-driver.md 루프 — producer·리뷰어 프로바이더·기준·고도 렌즈·namespace·`<dir>`만 다르다. **대칭 크로스-모델**: 설계는 Claude producer→Codex 리뷰, 개발은 Codex producer→Claude 리뷰(리뷰어=producer의 반대).
- **비중첩 스코프는 B1에서 한 번 확인하는 전제조건이지, 리뷰의 대체물이 아니다.** 태스크 worktree의 머지 前 리뷰(B2′)는 격리된 코드에 대한 품질 게이트이고, `execution.mjs verify`/`completion`이 읽는 것은 B3에서 만든 run 레벨 리뷰 유닛뿐이다. 태스크를 merge한다고 그 B3 확인 라운드를 건너뛰지 않는다.
- ledger·verdict 정합·상태 전이는 **손으로 판정하지 말고 loop CLI로**(false approval 방지).
- 설계·계획은 durable 파일(`plan.md`·`design/rev-N.md`·`notepad.md`)로 — Claude와 Codex가 같은 소스를 읽는다. **위임에서 참조할 수 있는 것은 디스크 정본뿐**이며, tool-result blob 경로는 참조가 아니다.
- 설계 리뷰 지적은 **충족안을 쓰기 前에** "위협모델 안인가"·"이 기구가 존재해야 하는가"에 먼저 답한다. 구체적 실수 시나리오 없이 추가된 기구는 준수가 아니라 과설계다.
- **무언가를 실제로 훑는다는 증거 없이 manifest에 들어가는 검증 명령은 없다.** 아무것도 매치하지 않거나 테스트를 하나도 수집하지 않는 검사는 영원히 통과한다.
- 승인 게이트(A5) 전에 코드를 쓰지 않는다.
