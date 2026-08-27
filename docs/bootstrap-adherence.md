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

### 3.1 두 훅 경로 (2차, 안전망)
스킬이 A0를 스킵해도 센티넬이 존재하도록 **bootstrap이 센티넬을 결정적으로 생성**:
- **`UserPromptSubmit`**(matcher 없음): 직접 slash. `prompt` raw 파싱.
- **`PreToolUse`**(matcher `Skill`): 모델·라우터 경로. `tool_input.skill`.
- C4로 두 경로가 분리 실증됨 → session/invocation handoff **불필요**(기각).

### 3.2 command/args 파싱
- **stdin strict parse(P2-4)**: bootstrap은 `lib.readStdin`(파싱오류를 `{}`로 삼켜 fail-open) 대신 raw를 직접 읽어 **빈/malformed payload면 exit 2**(fail-closed).
- UserPromptSubmit: `^/harnie:dev(?:\s|$)`로 정확 매칭해 bootstrap한다(`\b`는 `/harnie:dev-x`를 오매치하므로 금지). 0.12.2에서 폐기된 `dev-full`·`dev-quick` 라우트는 정확한 경계에서만 안내 메시지를 내고 상태를 만들지 않는다. 비-harnie·미스매치 → exit 0 no-op. args = 나머지 trim.
- PreToolUse Skill: `tool_input.skill`로 같은 판정을 한다. args = `tool_input.args`.
- **빈 args → exit 2**(무의미한 plan 차단).
- raw args를 **셸에 삽입하지 않음** — `execution.mjs` 함수 in-process 호출. slug는 내부 slugify(§3.4).

### 3.3 run 수명주기 — `base` + collision-free slug
- `base = slugify(args)` = **`읽기용-prefix-<hash8>`**(전체 작업 문자열 공백정규화 후 sha256 앞 8자). ASCII prefix만 쓰면 (a) 한국어 등 비-ASCII 작업이 빈 slug가 되고 (b) 앞 6토큰이 같은 다른 작업이 충돌해 오인 resume하므로 **hash로 둘 다 해소**(P1-1; 한국어 → prefix 없이 hash만). 빈 작업(정규화 후 "") → 호출자 exit 2. 실제 run dir slug = **collision-free**(`base`, `base-2`, …; dir 존재 시 다음 접미사).
- `active.json`에 `base`(접미사 전)와 최종 `slug` 모두 저장. **스킬은 `active.json`의 최종 slug를 읽어** 사용(§3.7).
- `genuinelyComplete = manifest 존재 && authorityApproved && computeCompletion.complete`. **`noManifest`(승인 전 planning) run은 incomplete로 간주**(computeCompletion은 noManifest를 `complete:true`로 반환하므로 rollover에 직접 쓰면 안 됨 — execution-state.md:341).

**결정표** (요청 `base` vs 현재 active run):

| active run 상태 | 요청 base == active base | 다른 base |
|---|---|---|
| **incomplete** | **resume** (기존 run 재사용) | **block** (fail-closed, 정본 메시지) |
| **genuinelyComplete** | **new run `base-2`** (old dir 보존, 포인터 전환) | **new run** (포인터 전환, old dir 보존) |

incomplete-block 정본 메시지: `미완료 run <track>/<slug>가 활성 상태입니다. 기존 run을 재개하여 완료해야 새 작업을 시작할 수 있습니다.` (폐기 기능 미제공이므로 "폐기하라" 문구 넣지 않음. 향후 폐기는 별도 계약: 사용자 명시 승인·dir 보존·`abandoned` 기록·포인터만 전환·모델 자체 폐기 불가.)

### 3.4 동시성 — exclusive lock(소유권 토큰) + 원자 전환
`writeJSONAtomic`은 부분쓰기만 막고 CAS·lock이 아니라, 두 세션 동시 작업 시 active 포인터가 last-writer-wins가 됨. 방지:
- `.harnie/state.lock`에 **소유권 토큰**(`pid-time-rand`)을 담은 exclusive lock(`openSync 'wx'`). 순서: **lock 획득 → 새 `execution.json` 생성 → `active.json` 원자 전환(마지막) → lock 해제.** 실패 시 이전 active 유지.
- **release는 토큰 일치 확인 후에만 삭제**(stale 회수 경합에서 남의 lock을 지우지 않도록, P1-3a).
- **`active.json`을 RMW하는 모든 지점**(bootstrap rollover·승인 바인딩·read-only thread 등록·**레거시 `cmdInit`**)이 **같은 `withStateLock` 공유 + rollover 감지**(lock 하에서 재-읽은 sentinel의 slug/track이 기대와 불일치면 fail-closed). 일부만 lock 쓰면 stale sentinel로 새 포인터를 덮을 수 있음(P1-3b/P1-5b).
- **자동 회수 없음**(P1-2 재검토): stale/dead lock을 시간·PID·rename으로 회수하는 어떤 방식도 **회수자 경합(TOCTOU)이 상호배제를 깨뜨릴 수 있다**(B가 dead lock을 옮기는 사이 A가 새 lock 획득 → B가 A의 새 lock을 옮김 → C가 또 획득해 A와 동시 진입). 그래서 회수를 제거하고, **짧은 재시도(일시 경합 흡수)만 하고 지속되면 fail-closed(exit 2, 수동 `rm .harnie/state.lock` 안내)**. critical section이 동기 파일쓰기 몇 개뿐이라 crash-중-hold는 극히 드묾. **live 경합 직렬화는 8-process 테스트**, stuck lock은 fail-closed 테스트로 검증.

### 3.5 fail-closed
bootstrap 실패(파싱 오류·빈 args·lock 경합·init 예외·rollover block)는 모두 **exit 2로 invocation 차단**. 삼키지 않음(`|| true` 금지).

### 3.6 A0 계약 (스킬)
`skills/dev/SKILL.md`의 A0는 **slug 생성·`init` 직접 실행을 하지 않는다**:
1. `active.json` 읽기
2. `track === "plan"` 검증(내부 track 값은 `plan` 하나뿐이다 — 두 트랙 시절의 잔재)
3. 그 slug를 이후 모든 CLI에 사용
4. active가 **없거나 손상**이면 **즉시 중단 + bootstrap 훅 실패 보고**

→ bootstrap 부재 시 스킬이 **자체 init으로 복구하지 않는다**. 자체 복구를 허용하면 지침 의존 부트스트랩 갭이 재발한다. (C2에서 스킬이 자체 init한 것은 프로브에 bootstrap 훅이 없었기 때문 — 최종 계약에서 훅 의존이 정상 동작.)

### 3.7 활성 run worktree/브랜치 삭제 방어 (0.13 T8, 2026-08-26 사고 대응)

**사고**: 정리 세션(비-owner, cwd=main root)이 "워크트리·브랜치 정리" 지시를 과잉 해석해 실행 중이던 M run의 worktree와 미푸시 브랜치를 원문 `git`/`rm`으로 삭제했다. `scripts/guards.mjs`의 `referencesWorktreeContainer`는 "이 worktree **안**에서 build·test·git을 자유롭게 쓰게" 하려고 `.harnie-wt/<dir>` 형태의 **구체 경로**를 의도적으로 허용하는데, `git worktree remove <그 worktree>`·`rm -rf <그 worktree>` 같은 **삭제 자체**도 같은 허용 분기에 떨어져 어떤 술어도 막지 못했다(전수 분석: `~/Tradlinx/task2-recovery/bureaucracy-audit.md` §2.1). 상세는 그 문서 §2.3(도입 조건 3개)을 따른다 — 여기서는 구현·잔여 한계만 기록한다.

**구현**: 새 상태 파일 없음(감사 §2.3 조건 2). `hooks/lib.mjs`의 `listActiveRunWorktrees(mainRoot)`가 `<mainRoot>/.harnie-wt/*`를 훑어 자기 `.harnie/active.json`을 가진 run만 모으고(각 run의 `slug`는 이미 그 파일에 있다), 브랜치명은 bootstrap이 항상 `harnie/<slug>`로 만드는 결정적 관례에서 파생한다(`hooks/bootstrap.mjs`·`execution.mjs` `initCliAuthority` 두 프로덕션 경로 모두 이 관례를 따르므로 새 필드도 필요 없다). `hooks/pretooluse.mjs`가 세션의 owner 여부와 무관하게(사고의 가해 세션은 대상 run의 owner가 아니었다) 이 목록을 계산해 `scripts/guards.mjs`의 `decideActiveRunDeletion`(새 predicate 2개: 워크트리 삭제·브랜치 삭제)에 넘긴다. `worktree.mjs remove`(신뢰 CLI)는 `decideBash`에서 이미 sanctioned로 분류돼 이 predicate까지 오지 않으므로 정상 정리 경로는 그대로 열려 있다.

**잔여 한계(해결됐다고 쓰지 않는다)**: 이 deny는 **정리 세션의 `findRoot`가 그 run의 `.harnie-wt` 컨테이너를 찾을 수 있는 root에서만** 발화한다 — §0.1 잔여(위 §3.9)와 같은 계보다. 구체적으로:
- 다른 repo 루트에서, 또는 절대경로로 다른 워크스페이스의 워크트리·브랜치를 지우는 경우는 커버되지 않는다.
- 판정은 명령 문자열의 리터럴 부분일치다(§0.1 적대적 방어가 비목표인 것과 같은 수준) — 셸 변수·글롭 확장으로 같은 경로를 우회 지목하면 놓칠 수 있다.
- **따라서 이 장치는 재발을 100% 막지 못하며**, 병행해야 할 저비용 대응은 엔진이 아니라 운영 규칙이다: 정리 지시는 **대상을 명시 열거**한다(메모리 `harnie-scope-framing-0.13-backlog` 항목 4). 엔진 장치를 도입했다고 이 규칙이 불필요해졌다고 오해하지 말 것.
