# bootstrap-adherence — 진입점 해석 · 부트스트랩 강제 · run 수명주기 · 동시성 (ADR)

> **Status: Accepted — implementation pending.** (구현 완료 커밋에서 `Implemented`로 전환하고 실행 상태 요약만 동기화한다.)
> Date: 2026-08-11. Scope: `execution-state.md`(rev.10)의 **A0/init 부트스트랩 앞단**을 확장·우선한다. rev.10의 머신 내부 권위·승인·완료 계약은 그대로 유효.

## 1. 맥락 & 문제

⑦ 라이브 검증 중 **오케스트레이터 adherence 갭** 발견: plan 자연 실행에서 메인 Claude가 필수 결정적 단계(A0 `execution.mjs init`·A5 승인 게이트·B2 Codex 빌더·sanctioned CLI·B6 footer)를 통째로 스킵 → H1/H2 강제 훅이 dormant(설계 §0.1이 막으려던 실패가 부트스트랩에서 순환).

근본 원인 두 가지:
- **(a) thin wrapper:** `commands/plan.md`·`quick.md`가 "plan 스킬을 호출하라"는 한 줄 지시라 모델이 스킬 본문을 안 싣거나(인라인 진행)·quick을 오호출하는 비결정 발생.
- **(b) 부트스트랩이 지침 의존:** H1/H2는 `.harnie/active.json`(=init) 이후에만 켜지는데 init 실행 자체가 지침이라, over-eager 오케스트레이터가 스킵하면 강제가 통째로 꺼짐.

## 2. 격리 프로브 증거 (Claude Code 2.1.90, 6/6 PASS)

`--plugin-dir` 격리 + command 없는 `harnie` 복사본 + 로깅 전용 프로브 훅(조건부 exit2). 원본 repo·설치본 불변.

| # | 확인 | 결과 |
|---|---|---|
| C1 | command 없이 `/harnie:plan`이 스킬로 slash resolve | ✅ |
| C2 | 직접 진입 시 **스킬 본문 결정적 로드 + 전체 머신 완주**(bootstrap 훅 없이도) | ✅ |
| C3 | `UserPromptSubmit` = `{session_id, transcript_path, cwd, permission_mode, prompt(raw)}` | ✅ |
| C4 | 직접 slash → **PreToolUse Skill 없음**(경로 분리; 서브에이전트는 Task) | ✅ |
| C5 | `/harnie:build` → `PreToolUse Skill` `{tool_input:{skill:"harnie:quick", args}}` | ✅ |
| C6a/C6b | `exit 2`가 UserPromptSubmit·PreToolUse Skill **각각 차단**(fail-closed) | ✅ |

- **`UserPromptExpansion`은 2.1.90 settings.json에서 미지원**(`Invalid key in record`) → 직접 slash 경로는 `UserPromptSubmit`.
- `${CLAUDE_PLUGIN_ROOT}`는 `--plugin-dir` 플러그인의 훅 command에서도 치환됨.
- 실 payload fixture: [`hooks/fixtures/bootstrap-hook-events.json`](../hooks/fixtures/bootstrap-hook-events.json) (volatile 필드 redact).

## 3. 결정 — 레이어드 강제

### 3.1 진입점 재편 — wrapper 제거 + `dev-*` 개명 (1차, 주력)
겹치던 command↔skill 이름·역할을 분리한다(옵션 A 확정):
- `commands/plan.md`·`commands/quick.md`(+`-ko`) **삭제**(wrapper 제거).
- 라우터 `commands/build.md` → **`commands/dev.md`**(`/harnie:dev` = 작업 분류 → 트랙 스킬 호출). 커맨드는 **라우터 이것 하나뿐**.
- 트랙 스킬 **본문·오케스트레이션 로직 불변, 폴더명만 개명**: `skills/plan` → **`skills/dev-full`**(`/harnie:dev-full`), `skills/quick` → **`skills/dev-quick`**(`/harnie:dev-quick`). 두 트랙은 **스킬 직접 진입**이라 wrapper 없음 → 본문 결정적 로드(C2).
- `plugin.json` `commands` = `["./commands/dev.md"]`.

즉 **커맨드=라우터(`dev`) 1개, 트랙=스킬(`dev-full`·`dev-quick`) 직접 진입.** (skill 내부 분해 ②는 안 함.)

### 3.2 두 훅 경로 (2차, 안전망)
스킬이 A0를 스킵해도 센티넬이 존재하도록 **bootstrap이 센티넬을 결정적으로 생성**:
- **`UserPromptSubmit`**(matcher 없음): 직접 slash. `prompt` raw 파싱.
- **`PreToolUse`**(matcher `Skill`): 모델·라우터 경로. `tool_input.skill`.
- C4로 두 경로가 분리 실증됨 → session/invocation handoff **불필요**(기각).

### 3.3 command/args 파싱
- **stdin strict parse(P2-4)**: bootstrap은 `lib.readStdin`(파싱오류를 `{}`로 삼켜 fail-open) 대신 raw를 직접 읽어 **빈/malformed payload면 exit 2**(fail-closed).
- UserPromptSubmit: `^/harnie:dev-full(?:\s|$)`로 정확 매칭(`\b`는 `/harnie:dev-full-x`를 오매치하므로 금지). `dev-quick`은 동일 패턴이나 **현재 no-op**(§3.8). **라우터 `/harnie:dev`(정확 prefix)는 no-op이 아니라 `pending-route` 기록**(§3.9). 비-harnie·미스매치 → exit 0 no-op. args = 나머지 trim.
- PreToolUse Skill: `tool_input.skill === "harnie:dev-full"`만 bootstrap(`harnie:dev-quick`은 pending-route 해소 후 no-op). args = `tool_input.args`.
- **빈 args → exit 2**(무의미한 plan 차단).
- raw args를 **셸에 삽입하지 않음** — `execution.mjs` 함수 in-process 호출. slug는 내부 slugify(§3.4).

### 3.4 run 수명주기 — `base` + collision-free slug
- `base = slugify(args)` = **`읽기용-prefix-<hash8>`**(전체 작업 문자열 공백정규화 후 sha256 앞 8자). ASCII prefix만 쓰면 (a) 한국어 등 비-ASCII 작업이 빈 slug가 되고 (b) 앞 6토큰이 같은 다른 작업이 충돌해 오인 resume하므로 **hash로 둘 다 해소**(P1-1; 한국어 → prefix 없이 hash만). 빈 작업(정규화 후 "") → 호출자 exit 2. 실제 run dir slug = **collision-free**(`base`, `base-2`, …; dir 존재 시 다음 접미사).
- `active.json`에 `base`(접미사 전)와 최종 `slug` 모두 저장. **스킬은 `active.json`의 최종 slug를 읽어** 사용(§3.7).
- `genuinelyComplete = manifest 존재 && authorityApproved && computeCompletion.complete`. **`noManifest`(승인 전 planning) run은 incomplete로 간주**(computeCompletion은 noManifest를 `complete:true`로 반환하므로 rollover에 직접 쓰면 안 됨 — execution-state.md:341).

**결정표** (요청 `base` vs 현재 active run):

| active run 상태 | 요청 base == active base | 다른 base |
|---|---|---|
| **incomplete** | **resume** (기존 run 재사용) | **block** (fail-closed, 정본 메시지) |
| **genuinelyComplete** | **new run `base-2`** (old dir 보존, 포인터 전환) | **new run** (포인터 전환, old dir 보존) |

incomplete-block 정본 메시지: `미완료 run <track>/<slug>가 활성 상태입니다. 기존 run을 재개하여 완료해야 새 작업을 시작할 수 있습니다.` (폐기 기능 미제공이므로 "폐기하라" 문구 넣지 않음. 향후 폐기는 별도 계약: 사용자 명시 승인·dir 보존·`abandoned` 기록·포인터만 전환·모델 자체 폐기 불가.)

### 3.5 동시성 — exclusive lock(소유권 토큰) + 원자 전환
`writeJSONAtomic`은 부분쓰기만 막고 CAS·lock이 아니라, 두 세션 동시 작업 시 active 포인터가 last-writer-wins가 됨. 방지:
- `.harnie/state.lock`에 **소유권 토큰**(`pid-time-rand`)을 담은 exclusive lock(`openSync 'wx'`). 순서: **lock 획득 → 새 `execution.json` 생성 → `active.json` 원자 전환(마지막) → lock 해제.** 실패 시 이전 active 유지.
- **release는 토큰 일치 확인 후에만 삭제**(stale 회수 경합에서 남의 lock을 지우지 않도록, P1-3a).
- **`active.json`을 RMW하는 모든 지점**(bootstrap rollover·승인 바인딩·read-only thread 등록·**레거시 `cmdInit`**)이 **같은 `withStateLock` 공유 + rollover 감지**(lock 하에서 재-읽은 sentinel의 slug/track이 기대와 불일치면 fail-closed). 일부만 lock 쓰면 stale sentinel로 새 포인터를 덮을 수 있음(P1-3b/P1-5b).
- **자동 회수 없음**(P1-2 재검토): stale/dead lock을 시간·PID·rename으로 회수하는 어떤 방식도 **회수자 경합(TOCTOU)이 상호배제를 깨뜨릴 수 있다**(B가 dead lock을 옮기는 사이 A가 새 lock 획득 → B가 A의 새 lock을 옮김 → C가 또 획득해 A와 동시 진입). 그래서 회수를 제거하고, **짧은 재시도(일시 경합 흡수)만 하고 지속되면 fail-closed(exit 2, 수동 `rm .harnie/state.lock` 안내)**. critical section이 동기 파일쓰기 몇 개뿐이라 crash-중-hold는 극히 드묾. **live 경합 직렬화는 8-process 테스트**, stuck lock은 fail-closed 테스트로 검증.

### 3.6 fail-closed
bootstrap 실패(파싱 오류·빈 args·lock 경합·init 예외·rollover block)는 모두 **exit 2로 invocation 차단**. 삼키지 않음(`|| true` 금지).

### 3.7 A0 계약 (스킬)
`skills/dev-full/SKILL.md`(+`-ko`)의 A0는 **더 이상 slug 생성·`init` 직접 실행을 하지 않는다**:
1. `active.json` 읽기
2. `track === "plan"` 검증(내부 track 값은 그대로 `plan` 유지 — 폴더/진입명만 `dev-full`)
3. 그 slug를 이후 모든 CLI에 사용
4. active가 **없거나 손상**이면 **즉시 중단 + bootstrap 훅 실패 보고**

→ bootstrap 부재 시 스킬이 **자체 init으로 복구하지 않는다**. 자체 복구를 허용하면 지침 의존 부트스트랩 갭이 재발한다. (C2에서 스킬이 자체 init한 것은 프로브에 bootstrap 훅이 없었기 때문 — 최종 계약에서 훅 의존이 정상 동작.)

### 3.8 quick 이연 경계
`quick`은 **현행 no-op**(bootstrap 안 함). `plan` execution machine을 그대로 연결하면 `phase=planning`에 갇혀 quick 쓰기가 차단됨. quick의 상태·쓰기 허용 계약은 **별도 ADR/변경**으로 설계한다. 이번 변경은 공통 기반(stdin 파싱·원자 sentinel·exit2·complete/incomplete rollover)만 future-proof하게 만든다.

### 3.9 라우터 `/harnie:dev`의 pending-route 게이트 (P1-2)
> **0.12.2 제거 메모:** pending-route 상태 머신은 `writePendingRoute`의 프로덕션 호출 지점이 0건이라 게이트가 영구 no-op인 orphan이었으므로 제거됐다. 같은 문서의 §3.3과 §5에 있는 pending-route/dev-full 참조도 이제 역사적 기록이다. 또한 이 절과 §5에서 다섯 번 언급되는 `markRouteFailed`는 이번 제거 전의 `execution.mjs`에도 존재하지 않았으므로, 이 절을 이번 변경 직전까지 정확했던 현행 설명으로 읽으면 안 된다.

`/harnie:dev`는 command이며 모델에게 track 스킬 호출을 지시한다 — 모델이 Skill 호출을 생략하고 인라인으로 작업하면 active sentinel 없이 진행해 H1/H2가 dormant(직접 `/dev-full`은 강화됐지만 대표 라우터 `/dev`에서 갭 재현). 닫기:
- 저장은 **per-session 파일** `.harnie/pending-route/<session_id>.json` = `{state: "pending"|"failed", reason?, at}`. per-session이라 **state lock 불필요**(각 세션이 자기 파일만 씀 → `markRouteFailed`가 lock 경합에 막히지 않음, P1-1). session_id는 파일명 안전 검증. **이 디렉터리는 control path**(guards.isControlPath)라 tool 쓰기/삭제가 차단됨.
- UserPromptSubmit `/harnie:dev <작업>` → bootstrap이 pending 기록(track 미정이라 run은 아직). **빈 인자 → exit 2**(P1-1).
- **H1(pretooluse)** — 보호는 **session-scoped**(전역 Bash 차단은 채택하지 않음: 어떤 세션이든 pending 파일 하나로 저장소 전체 Bash가 영구 latch되고, SessionEnd를 결정적으로 관찰할 수 없어 정리 계약이 성립 안 함 — 리뷰 옵션 (b)):
  - **(pending 게이트)** 이 세션 route가 있으면 **active 여부와 무관하게** 작업 도구 + **Bash 전면** deny(P1-4). → **라우팅 세션은 자기 Bash가 막히므로 자기 route 파일을 Bash(glob 포함)로 self-tamper할 수 없다.** 이게 in-scope 보장.
  - **(baseline, active/pending 무관)** control/route/lock 파일 **Write/Edit deny**(canonical containment — 견고) + active 없을 때 `.harnie` Bash deny(quote 제거 후 매칭 — best-effort).
  - **§0.1 잔여(비목표)**: **다른 세션**이 glob/변수 셸 확장으로 남의 route 파일을 Bash 삭제하는 것은 **적대적**이라 봉쇄 대상 아님. 셸 우회까지 막으려면 문자열이 아닌 **파일시스템 실행 경계**가 필요(후속).
- **H2(stop)**: 이 세션 route가 `pending`이면 종료 차단(P1-1). `failed`면 **정직한 실패 보고 확인 후에만 정리·통과**(`decideStop`: 첫 Stop 차단→재호출+`HARNIE_STATUS: INCOMPLETE`면 통과, 거짓 COMPLETE면 계속 차단; **`— <blocker>` detail 비어있지 않아야** 정리, P1-4/P2).
- PreToolUse Skill `harnie:dev-full` → bootstrapRun **성공 시** 해소; **실패 시** `markRouteFailed`로 `failed` 전환(영구 latch 방지, P1-1). `harnie:dev-quick` → 해소.
- **정리는 strict**(P1-3): `clearPendingRoute`가 삭제 실패면 throw(부재 재확인) → 호출자는 exit2/block로 fail-closed. best-effort로 성공 보고 후 gate가 남는 것을 방지.
- **손상 route fail-closed**(P1): `getRouteState`는 파일 부재만 `null`, 존재하면 반드시 plain object + `state ∈ {pending,failed}`(그 외는 `readJSONStrict`가 손상 JSON을, 여기서 유효 JSON+알 수 없는 state를 `FailClosed`로 throw). 예전엔 `{state:"unexpected"}`가 pretooluse는 막고 Stop은 pending/failed 분기 미매치로 **통과**(fail-open)했음 — 이제 Stop 훅 catch가 fail-closed block, pretooluse catch가 gated deny.
- pending-route는 hook이 결정적으로 쓰고 지우므로 지침 의존이 아님. **시간 만료 없음**(P1-2). **per-session이라 죽은 세션 잔여는 다른 세션을 방해하지 않음**(전역 latch 없음).

## 4. 기각안

- **임베디드 `!`bash 강제**: `disableSkillShellExecution`로 무력화 가능 → hard guarantee 아님. 필요 시 bootstrap 결과를 문맥에 보여주는 **보조 표시용**만.
- **session-only handoff(`invocation_id`)**: C4로 두 훅 경로 분리 실증 → 불필요. 실제 중복 이벤트·args 변형이 재현될 때만 재도입.
- **스킬 자체 init fallback**: 지침 의존 갭 재발 → 금지(§3.7).
- **`UserPromptExpansion` 훅**: 2.1.90 미지원(§2).

## 5. 구현 · 라이브 검증 완료 조건

구현(완료):
- `scripts/execution.mjs`: `slugify`(prefix-hash, §3.4)·`bootstrapRun(root,{base,track,sessionId})`·`collisionFreeSlug`·`genuinelyComplete`·`createRun`·`resumeRun`(strict read, §3.7/P2-5) + `acquireLock/releaseLock`(소유권 토큰·**자동 회수 없음**: 재시도 후 stuck이면 fail-closed)·`withStateLock`(§3.5) + **per-session** pending-route state machine `writePendingRoute`/`markRouteFailed`/`clearPendingRoute`/`getRouteState`/`hasPendingRoute`(§3.9, **lock-free·시간 만료 없음**). 승인(`bindApproval`)·`registerReadonlyThread`·레거시 `cmdInit`의 `active.json` RMW를 `withStateLock`+rollover 감지로 감쌈(cmdInit 순서도 execution→active 정렬). `cmdInit`(CLI)은 레거시/테스트용(프로덕션 경로는 bootstrapRun).
- `hooks/bootstrap.mjs` 신규(strict stdin parse, exit2, dev-full 실패 시 `markRouteFailed`, `/harnie:dev` 빈 인자 exit2) + `hooks/hooks.json`에 `UserPromptSubmit`·`PreToolUse(Skill)` 두 항목(기존 병존). `hooks/pretooluse.mjs`에 baseline control/route/lock Write 보호(active 무관, `guards.isControlPath`·`referencesHarnie`) + **session-scoped pending 게이트**(§3.9, 라우팅 세션의 Bash 전면 차단 → 자기 route self-tamper 불가). `clearPendingRoute`는 **strict**(삭제 실패 시 throw, P1-3). `hooks/stop.mjs`에 pending(block)/failed(honesty 검증 후 정리·통과). `scripts/guards.mjs` `isControlPath`에 `.harnie/pending-route/`·`state.lock` 추가.
- **dev-full 설계 조사·질문 계약**(별건, 함께 반영): `skills/dev-full/SKILL.md`(+`-ko`) A1=범위비례 조사 체크리스트·A2=근거 기반 질문(CLEAR/UNCLEAR 폐기)·가정은 `plan.md ## Assumptions` 기록, `agents/harnie-scout.md`(+`-ko`) 조사 차원 커버 계약.
- 진입점 재편(§3.1): `commands/plan.md`·`quick.md`(+`-ko`) 삭제, `commands/build.md`→`dev.md`, `skills/plan`→`skills/dev-full`·`skills/quick`→`skills/dev-quick`(본문 불변), `plugin.json` `commands`=`["./commands/dev.md"]`·**version 0.1.0**(breaking entrypoint). AGENTS/CLAUDE/README 명칭 동기화(track 값 `plan`/`quick`은 내부 유지).
- `skills/dev-full/SKILL.md`(+`-ko`) A0 = active.json slug 읽기(§3.7). `dev-quick`은 bootstrap no-op(§3.8).

검증:
- `hooks/bootstrap.test.mjs`·`hooks/hooks.test.mjs`·`scripts/execution.test.mjs`(slug·rollover·lock 상호배제(8-proc live 경합)·stuck lock fail-closed·markRouteFailed lock-free·resume-strict·pending-route state·라우팅 실패 latch 방지·control-path 보호·session-scoped 게이트(라우팅 세션 self-tamper 불가)·strict cleanup·**손상 route(알 수 없는 state) fail-closed**(Stop·PreToolUse 양쪽)·Stop honesty+blocker detail·strict-parse). **전체 170 pass**.
- **미실시(라이브)**: 설치본에서 직접 slash·모델 경로 bootstrap 발화, exit2 차단, pending-route 게이트 실차단, 동시 실행 직렬화.

완료 시(라이브 검증 후): 이 ADR status → **Implemented**, `execution-state.md` 실행 상태 요약 동기화.
