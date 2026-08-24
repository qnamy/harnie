---
name: dev-full
description: 신규 기능·모듈·구조 변경 등 큰 작업을 풀 라이프사이클로 처리하는 오케스트레이터 — 계획(그라운딩+라우팅)→설계→크로스-모델 설계 리뷰(코드 前)→승인 게이트→오케스트레이션 실행→크로스-모델 코드 리뷰→최종 웨이브(Coverage·Quality·Runtime·Scope). 대칭 크로스-모델 방식으로 설계는 Claude→Codex 리뷰, 개발은 Codex→Claude 리뷰를 적용한다. `/harnie:dev-full` 또는 라우터 `/harnie:dev`가 호출한다. (내부 track 값은 그대로 `plan`.)
---

# plan 오케스트레이터 (class B: 신규·큰 변경)

너(main)는 계획 단계에서 실행 단계로 전환한다. 에이전트 전환이 아니라 한 세션의 국면 전환이다. 워크플로 규율은 이 스킬 + (P2 배송 시) 최소 강제 훅으로 지킨다.

## 매 사용자 메시지: 의도 재분류 (실행 권한 승계 금지)
새 사용자 메시지가 오면 **이번 실행 모드를 자동 승계하지 말고** 메시지를 `replace|add|status|question`으로 다시 분류한다. **status·question·단순 add**는 승인된 실행 권한을 취소하지 않는다(진행 유지). 그러나 **범위·목표가 바뀌면**(replace, 또는 범위를 바꾸는 add) 실행을 멈추고 `execution.json`·plan·리뷰 범위를 재계산한 뒤 필요한 재승인을 받고 이어간다. (실행 권한 리셋이 아니라 **메시지 의도·범위 리셋**.)

## Step 0 — 드라이버 계약 읽기 (필수, 먼저)

**`${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md`를 지금 Read한다** — 너(main)가 직접 조율하는 CLI/Codex 배선(R1~R5)을 이 세션에 올린다. 스키마·리뷰 기준·작성 프로필 문서는 미리 로드할 필요가 **없다**: `harnie-designer`·`harnie-reviewer`와 Codex 리뷰어/빌더는 각각 아래에서 넘기는 경로(A3/A4, B2/B2′, B3/B3′/B5 — 아래 phase 파일 참조)에서 자기 기준과 프로필을 직접 Read한다 — 그 파일들 내용을 위임 프롬프트에 인라인으로 싣지 않는다. `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md`에 대해서는 `apply`의 출력(`machineState`, `needsReRequest`, `needsReentry`, `review-loop-driver.md` R4 참조)만 대응하면 되며, 전체 상태머신 유도를 로드할 필요는 없다.

> **모델 배정**: 이 run의 모든 위임은 `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md`를 따른다: **run 난이도**(easy/medium/hard — `/harnie:dev` 라우터가 announce하거나 직접 진입 시 A0에서 판정)가 **생산자 모델**(Codex 빌더, DETAIL 고도의 `harnie-designer`)과 — 보수적으로 — **코드 리뷰어**(`harnie-reviewer`: 유닛 리뷰 easy = sonnet·medium/hard = opus, 확인 리뷰는 hard 미만 sonnet, Final Wave 게이트는 항상 opus)를 티어링한다; 설계 리뷰는 `gpt-5.6-sol` 고정; A3 정식 아키텍처 설계는 항상 **fable**을 쓴다(폴백 opus). phase 파일이 각 호출 지점의 구체값을 다시 적는다.

> **대칭 크로스-모델**(각 단계 반대 프로바이더가 리뷰): **설계**(A3·A4) = Claude(`harnie-designer`) 산출 → **Codex** 리뷰 / **개발**(B2·B3·Final Wave) = **Codex** 빌더(codex MCP, `workspace-write`) 산출 → **Claude** 리뷰. codex MCP 툴명은 설치 형태에 따라 `mcp__plugin_harnie_codex__codex`/`mcp__codex__codex`, 재빌드·재리뷰는 `*__codex-reply`. 자세한 배선은 review-loop-driver.md.

## Phase 파일 — 그 phase에 진입할 때 해당 파일만 읽는다

이 스킬의 단계는 여기 본문이 아니라 `skills/dev-full/phases/` 아래 phase별 파일에 있다(이 파일을 작게 유지하기 위함). **그 phase에 도달했을 때 해당 파일을 읽는다 — Step 0에서 전부 미리 로드하지 않는다.** 각 phase 파일은 이 파일의 상태 위치·위임 참조 규칙·실행 상태/강제 훅·Notepad 프로토콜 섹션(아래)을 이미 읽었다고 전제한다.

- **PHASE A(계획):** `phases/phase-a-ko.md` — A0~A5(그라운딩, 질문, 아키/상세 설계 + 리뷰 루프, manifest 블록, 승인 게이트).
- **PHASE B, 직렬 + 두 경로 공통:** `phases/phase-b-ko.md` — B1(경로 선택 — runner path가 기본), 직렬 경로의 B2~B3, 두 경로 공통 단계 B4~B6.
- **PHASE B, runner path (기본):** `phases/phase-b-parallel-ko.md` — B2′~B3′(태스크 brief → 각 태스크마다 자기 worktree의 `harnie-task-runner` 서브에이전트, 동시 진행; 순차 통합 및 리뷰 보존). B1이 runner path를 선택했을 때만 읽는다 — 모든 태스크의 B3′ 4단계가 APPROVE되면 B4를 위해 `phase-b-ko.md`로 돌아온다.

## 상태 위치 (durable, 파일 기반)
`.harnie/plan/<slug>/`:
- `plan.md` — 설계 + 작업 분해 + 검증 전략 + Final Wave(Coverage·Quality·Runtime·Scope). 승인 게이트의 대상.
- `design/rev-N.md` — **버전이 붙은 설계 정본**: 리비전마다 파일 하나, N은 단조 증가, 덮어쓰기 없음. 서브에이전트·리뷰어에게 설계 내용으로 넘길 수 있는 **유일한 경로**.
- `notepad.md` — 진행 메모(크로스-프로바이더 공유 단일 소스).
- `tasks/t<id>-brief[.vN].md` — 태스크별 자체 완비적 brief (A6에서 작성: manifest 항목 + design section verbatim + 빌더 계약). Runner가 이것만 읽는다; 전체 설계는 다시 읽지 않는다.
- `review/design-arch/` · `review/design-detail/` — 아키·상세 설계 리뷰 루프 상태(각 독립: `ledger.json`·`state.json`·`round-N.txt`).
- `review/<unit>/` — 작업/웨이브별 코드 리뷰 루프 상태.
- `review-archive/t<id>/` — 태스크 유닛 리뷰 상태(ledger, round들, sidecar, baseline들)이 통합 시 `worktree.mjs remove --archive-to`로 옮겨지는 곳. `harness-digest` input·confirmation round 뒤의 durable 기록.

> 경로 단일 스킴: 모든 리뷰 루프 상태는 `.harnie/plan/<slug>/review/<name>/` 아래(quick의 `.harnie/quick/<slug>/`와 대칭). `<name>` = `design-arch` | `design-detail` | 코드 리뷰 단위.

> **Runner-path 태스크 worktree.** Runner path(기본값)에서는 태스크마다 자기만의 `.harnie/review/`를 가진 격리된 git worktree를 갖는다(이 상태와는 별개, 해당 태스크의 `harnie-task-runner` 소유). 전체 레이아웃은 `phases/phase-b-parallel-ko.md`를 참조한다.

## 위임 참조 규칙 (디스크 정본만)

서브에이전트·리뷰어에게 넘기는 모든 경로는 repo 안의 **디스크 정본**이어야 한다 — `.harnie/plan/<slug>/…` 또는 소스 파일. **tool-result blob 경로**(`tool-results/*.json`, 트랜스크립트 스크래치, 임시 캡처)는 넘기지 않는다: 과대 blob은 조용히 로드에 실패하고, 위임받은 쪽은 **오래된 리비전**으로 재구성한다 — 그 세대 뒤섞임은 하류에서 탐지되지 않는다.

1. 현재 설계는 `.harnie/plan/<slug>/design/rev-N.md`에 산다 — **리비전마다 새 파일, 덮어쓰지 않는다.** **designer가 거기에 직접 쓴다**(위임이 정확한 목적지를 지명하고, designer는 짧은 요약만 반환하며, main은 그것을 참조하는 위임 前에 파일 존재·비어있지 않음을 확인한다). main이 에이전트 응답의 설계 텍스트를 파일로 전사하는 일은 없다. 최초 작성 위임이 작업과 그라운딩으로 `rev-1`을 쓴다.
2. 기존 설계를 참조하는 이후 위임은 **그 정확한 경로와 리비전**을 명시하고, 어떤 리비전이 리뷰 대상인지 말한다.
3. 설계 내용을 인라인으로 싣는 것(`review-loop-driver.md` R2가 `DR` 루프에서 요구)은 이 규칙을 대체하지 않는다: 인라인 내용과 명시한 `rev-N.md`는 **같은 리비전**이어야 한다.
4. **빌더 예외(B2).** Codex 빌더는 `.harnie` 경로를 받지 않는다: 승인된 설계를 **인라인**으로 주고 `rev-N`을 명시한다. 경로 명시 요구는 `.harnie/`를 읽을 수 있는 위임 대상(designer·설계 리뷰어)에 적용된다.

위임받은 쪽이 참조 경로를 읽지 못했다고 보고하면 그 라운드의 산출은 **무효**다 — 참조를 고쳐 재위임한다. 기억으로 재구성한 결과는 절대 받아들이지 않는다.

## 실행 상태 + 강제 훅 (plan 전용 하네스 — `scripts/execution.mjs`)
plan 트랙은 durable 상태와 강제 훅으로 두 불변식 — **① 승인 前 소스 쓰기 금지, ② 미승인·미완료를 done으로 확정 금지** — 을 기계화한다. 권위 = planHash 고정 `manifest.json`(A5.2 사용자 재승인으로만 개정 가능, 이전 버전 아카이브) + 각 리뷰 유닛의 ledger·state + verification receipt; `execution.json`은 advisory 캐시일 뿐 신뢰하지 않는다. `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`; `<repo>` = 이 run의 절대경로 **워크루트**로, bootstrap 훅의 컨텍스트 메시지에서 얻는다(폴백: `<main repo>/.harnie/sessions/<이 세션의 id>.json`의 `workroot` 필드) — 세션 시작 디렉터리가 아니다. **모든 `execution.mjs` 서브커맨드와 `loop.mjs apply`는 `--root <repo>` 필수**(`loop.mjs capture`/`delta`는 `<repo>`를 위치 인자로 받는다). 상태 조작은 **반드시 `execution.mjs`로만** — 훅이 직접 쓰기를 차단하고, Bash 가드는 `.harnie`를 참조하는 명령 텍스트를 **읽기 포함** 포괄 차단한다. `.harnie` 산출물을 꺼낼 때는 `node <ROOT>/scripts/loop.mjs export <repo> <.harnie/ 기준 상대경로> [--out <.harnie 밖 목적지>]`를 쓴다; 컨텍스트 내 읽기는 늘 그렇듯 Read 툴로 하면 된다:
- **활성 run은 bootstrap 훅이 만든다 — 스킬이 직접 만들지 않는다.** `/harnie:dev-full`(또는 라우터 `/harnie:dev` → `Skill(harnie:dev-full)`) 호출 시 bootstrap 훅이 보고한 워크루트 안에 sentinel(`<repo>/.harnie/active.json`)과 `execution.json`을 이미 만들었다. **위 bootstrap 컨텍스트 메시지나 세션 바인딩 파일에서 `<repo>`를 해석하고, `<repo>/.harnie/active.json`을 읽어 `track === "plan"`을 확인한 뒤 그 `slug`(`<slug>`)를 아래 모든 CLI에 쓴다. `execution.mjs init`을 직접 실행하지 않는다.** 그 워크루트의 active.json이 없거나 손상이면 **중단하고 bootstrap 훅 실패를 보고**한다 — 자체 init으로 복구하지 않는다(부트스트랩 갭 재발; `bootstrap-adherence.md` 참조).
- **워크스페이스 run(멀티레포).** bootstrap 컨텍스트 메시지가 WORKSPACE run으로 플래그되면, 이 run은 여러 repo에 걸친다: `<repo>`(워크루트)는 `<workspace>/.harnie-wt/` 아래의 **plain run-state 디렉터리**이지 git worktree가 아니며, sentinel은 `workspaceRoot`와 `repos` 레지스트리를 담는다. 이 스킬의 모든 곳에서 단일-repo run과의 차이:
  - **멤버 repo 등록은 PHASE A 중 A5 gate 前에:** 계획이 수정할 워크스페이스 아래 각 repo에 대해 `node <ROOT>/scripts/execution.mjs repo-add --root <repo> --repo <절대 repo 경로 (워크스페이스 아래)>`. 이 호출이 경로를 검증(워크스페이스 안, git toplevel)하고, 그 repo의 전용 worktree(`<member repo>/.harnie-wt/harnie-<slug>`)를 만들고, run state의 registry에 `{key, workroot}`를 기록한다. manifest task 이름이 미등록 repo라면 `arm-approval`/승인이 fail-closed되므로, 먼저 등록해야 한다.
  - **모든 manifest task는 `"repo": "<key>"`를 실으며**(all-or-none; key는 `repo-add` 출력에서). 각 task의 `scope` 경로·`verification[].cwd`는 **그 멤버 repo의 워크루트를 기준**으로 하며, `execution.mjs verify`와 완료 재도출이 거기서 해석한다.
  - **task별 capture/delta와 Codex 빌더는 그 task의 멤버 워크루트**에서(`loop.mjs capture/delta <member workroot>`, 빌더 `cwd: <member workroot>`), `<repo>` 자체가 아니라 — `<repo>`는 git tree가 아니기 때문. `execution.mjs` 서브커맨드·`loop.mjs apply`는 여전히 `--root <repo>` 사용(run state가 거기 있음).
  - **전체 run 바인딩은 합성:** `loop.mjs capture <repo>`가 모든 등록된 멤버 워크루트 tree에서 구성한 `ws:<sha256>` 합성 artifact를 반환. Final Wave gate `apply`가 이를 `--artifact`로 사용. 어떤 멤버 repo 변경이든 그것을 무효화한다(단일-repo의 전체 tree SHA와 같이).
  - 워크스페이스 루트 자체는 이 run 디렉터리 밖에는 run 상태를 갖지 않으므로, 워크스페이스 이 run의 디렉터리 밖은 절대 게이트되지 않는다.
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

## 컨텍스트 예산 (run 전체) — 세션 분할·주입 절제·게이트 알림

실측된 run에서 지배적 토큰 비용은 오케스트레이터 자신의 누적 컨텍스트가 **모든** 호출마다 재독되는 것이다. 상시 규칙 셋:

1. **유닛 경계 세션 분할.** run 권위는 전부 디스크에 durable하므로 새 세션이 무손실로 재개된다 — 긴 run은 여러 세션에 걸치는 것이 *정상*이다. 한 세션에서 리뷰 유닛이 대략 3~4개 완료됐거나(또는 그전에 큰 산출물이 컨텍스트를 통과했다면) `notepad.md`에 짧은 인계 항목(현재 유닛·다음 스텝·열린 blocker)을 append하고 **세션 분할을 제안**한다 — 결정은 사용자가 한다. `loop.mjs apply`가 이를 기계적으로 백스톱한다(완료 유닛 4의 배수째마다 `sessionSplitRecommended: true`) — 켜지면 다음 유닛 시작 전에 제안하라; 세션이 "괜찮게 느껴진다"고 무시하지 마라.
2. **주입 절제.** 부피를 main 컨텍스트에 들이지 마라: `plan.md`/`design/rev-N.md`는 판단에 실제로 필요한 섹션만 읽고(위임 대상은 전달받은 경로에서 스스로 읽는다 — 위임 참조 규칙), 대용량 출력 명령은 소스에서 필터링해 실행하고, verdict 한 줄이면 충분한 곳에 위임자의 전체 보고를 끌고 다니지 마라. 오케스트레이터 자신의 검색은 Grep 도구가 아니라 workroot 기준 상대경로 단일 `rg` 명령으로 실행한다 — Grep 결과는 출력 줄마다 절대 worktree 경로가 붙고, 그 부피가 이후 모든 스텝에서 컨텍스트에 재유입된다(Bash 없는 서브에이전트와 `.harnie` 경로는 Grep/Read가 그대로 공인 리더다).
3. **스텝 배치·게이트 알림.** 독립적인 도구 호출은 한 메시지에 묶는다 — 큰 컨텍스트에서는 오케스트레이터 스텝 하나가 늘 때마다 전체 컨텍스트 재독이 하나 는다. 사용자 게이트(A5 승인, errata disposition, STALLED 재진입, watchdog deny)에 블록되기 전에는, 설치본에 알림 도구(예: `PushNotification`)가 있으면 짧은 알림을 보낸다 — 실측 run에서 사용자가 보지 못한 게이트에 밤 단위 시간이 사라졌다.

---

## 불변
- **모든 수정은 반드시 리뷰된다.** 아키 설계 리뷰(A3)·상세 설계 리뷰(A4)·runner path의 태스크별 유닛 리뷰(B2′ — runner가 inline 리뷰; run 레벨 A4 설계 + task brief가 태스크별 설계 루프를 대체)·머지 충돌 해결 리뷰(B3′)·run 레벨 코드 리뷰(B3)·Final Wave(B5) 모두 동일한 review-loop-driver.md 루프 — producer·리뷰어 프로바이더·기준·고도 렌즈·namespace·`<dir>`만 다르다. **대칭 크로스-모델**: 설계는 Claude producer→Codex 리뷰, 개발은 Codex producer→Claude 리뷰(리뷰어=producer의 반대) — runner path의 inline 리뷰도 이 패턴을 유지한다(producer=Codex 빌더, runner=Claude·코드 작성 안 함).
- **비중첩 스코프는 arm-approval(A5)에서 `validateManifest`가 한 번 강제하는 전제조건이지, 리뷰의 대체물이 아니다.** 태스크 worktree의 머지 前 리뷰(B2′)는 격리된 코드에 대한 품질 게이트이고, `execution.mjs verify`/`completion`이 읽는 것은 B3에서 만든 run 레벨 리뷰 유닛뿐이다. 태스크를 merge한다고 그 B3 확인 라운드를 건너뛰지 않는다.
- ledger·verdict 정합·상태 전이는 **손으로 판정하지 말고 loop CLI로**(false approval 방지).
- 설계·계획은 durable 파일(`plan.md`·`design/rev-N.md`·`notepad.md`)로 — Claude와 Codex가 같은 소스를 읽는다. **위임에서 참조할 수 있는 것은 디스크 정본뿐**이며, tool-result blob 경로는 참조가 아니다.
- 설계 리뷰 지적은 **충족안을 쓰기 前에** "위협모델 안인가"·"이 기구가 존재해야 하는가"에 먼저 답한다. 구체적 실수 시나리오 없이 추가된 기구는 준수가 아니라 과설계다.
- **무언가를 실제로 훑는다는 증거 없이 manifest에 들어가는 검증 명령은 없다.** 아무것도 매치하지 않거나 테스트를 하나도 수집하지 않는 검사는 영원히 통과한다.
- 승인 게이트(A5) 전에 코드를 쓰지 않는다.
