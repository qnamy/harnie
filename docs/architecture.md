# harnie 아키텍처 — 크로스-모델 빌드/리뷰 루프

> 한 세션 안에서 **설계 → 리뷰 → 개발 → 리뷰**를 진행하되, 각 단계를 **반대 모델이 리뷰**해 맹점을 없앤다. 구독 auth만으로, 두 프로바이더(Claude·Codex)를 한 세션에서 조합한다.
>
> **0.11 현행 구조는 [design-0.11-process.md](design-0.11-process.md)(아키텍처)와 [design-0.11-detail.md](design-0.11-detail.md)(상세)가 정본이다** — 단일 파이프라인(S/M/L), 3층 설계 고도(ARCH/CONTRACT/TASK-DETAIL), contest 게이트, dev-solo. 이 문서의 트랙(quick/plan)·단계(A/B) 서술은 0.10까지의 구조 근거·이력으로 남긴다.
>
> 이 문서는 **설계 근거·구조**를 담는다. 실행 규칙(상태 전이·검증 tier·리뷰 기준)의 정본은 [`instructions/`](../instructions/)이며(§7), 재서술하지 않는다.

## 핵심 아이디어

- **대칭 크로스-모델**: 산출물의 producer와 그 리뷰어를 **항상 다른 프로바이더**로 둔다. 같은 모델이 자기 산출물을 리뷰하면 같은 맹점을 공유하기 때문이다.
  - **설계** = Claude 산출 → **Codex** 리뷰
  - **개발** = Codex 산출 → **Claude** 리뷰
- **공유 컨텍스트 위 리뷰**: 리뷰어는 diff만 맨눈으로 보지 않고 계획·의도·제약을 주입받은 상태에서 판단한다.
- **증분 재리뷰**: 전체 재탐색 없이 **fix-델타 + 필요한 주변 문맥**만 다시 본다(stateful 세션). 승인까지 반복.
- **결과물은 파일로**: 계획·상태·리뷰 receipt는 `.harnie/`에 남아 다음 단계와 재개(resume)가 읽는다.

---

## 1. 역할 로스터

각 단계를 **반대 프로바이더가 리뷰**한다(불변식). 에이전트 지침은 `agents/`에 자기완결 번들로 둔다.

| 역할 | 프로바이더 | 실행 | 쓰기 | 지침 |
|---|---|---|---|---|
| `harnie-scout` (코드 탐색) | Claude (haiku) | 서브에이전트 | read-only | 최소 출력계약(절대경로+요약, 병렬) |
| `harnie-designer` (설계 producer) | Claude (opus) | 서브에이전트 | 설계 텍스트 반환(파일은 main이 씀) | `design-authoring-{arch,detail}.md` 주입 |
| 설계 리뷰어 | **Codex** | codex MCP `read-only` | ✕ | `design-review.md`, REJECT 편향 |
| 코드 빌더 (개발 producer) | **Codex** | codex MCP `workspace-write` | ✍️ | 6-section 계약 + 주입된 설계 |
| `harnie-reviewer` (코드 리뷰어) | **Claude** | read-only 서브에이전트 | ✕ | `code-review.md` + `verification-tiers.md`, REJECT 편향 |
| `harnie-task-runner` (태스크 러너, v0.10.0) | **Claude** (유닛 리뷰 티어) | 서브에이전트(태스크당 1개, 병렬) | 리뷰 라운드 파일만(소스 ✕ — 소스는 Codex 빌더) | 자기완결 브리프 + 인라인 유닛 리뷰(빌더=Codex이므로 크로스모델 유지) |

- **불변식**: 리뷰어 = producer의 반대 프로바이더. read-only는 `tools` allowlist로 기계 강제.
- **루프 코어는 프로바이더 무관**: `scripts/loop.mjs`·`ledger.mjs`·`delta.mjs`는 상태머신·ledger 정합·델타 캡처만 결정적으로 처리하므로, producer/reviewer 프로바이더를 바꿔도 코드 변경이 없다.
- `harnie-builder`(Claude)는 역스왑(Claude 개발) 구성용 alternate로 유지되며 기본 흐름에선 호출되지 않는다.
- 참조 규약: 에이전트는 **bare 이름**(사용자 override 허용), 트랙 스킬은 **네임스페이스**(`/harnie:…`, 충돌 안전).

---

## 2. 크로스-모델 리뷰 루프 (두 트랙 공유)

```
1. 리뷰어 세션 OPEN — 공유 컨텍스트 주입(작업 의도 + 제약 + (plan이면) 설계)
   · Codex 리뷰어: codex MCP `codex`(developer-instructions로 기준 주입) → threadId 확보
   · Claude 리뷰어: read-only harnie-reviewer 서브에이전트
2. 리뷰어 → VERDICT(APPROVE|REJECT) + 안정 ID 이슈 목록 (REJECT 편향)
3. REJECT면: producer가 수정 → **델타만 재리뷰**(stateful: codex-reply / 재개, 전체 재-read 금지)
4. open blocking 0(APPROVE)까지 반복 — 유한 stagnation 캡, 사용자 중단 가능
5. (옵션) 최종 사인오프 = producer의 **반대 프로바이더로** fresh 리뷰
```

- **효율 3원칙**: 실패 차원만 재실행 / stateful이라 재-read 금지 / fresh 리뷰는 최종 1회만.
- **증거 강제**: 리뷰 receipt(세션·verdict·ledger·수정요약)를 기록한다. open blocking이 남아 있으면 "done"이라 하지 않는다.
- 상태머신·ledger·progress/stagnation 규칙의 정본 = [`instructions/loop.md`](../instructions/loop.md), CLI 배선 = [`instructions/review-loop-driver.md`](../instructions/review-loop-driver.md).

---

## 3. 상태 & 공유 컨텍스트

- **quick**: 경량 · ephemeral. 리뷰 루프 상태는 `.harnie/quick/<slug>/review/<name>/`.
- **plan**: durable **파일 기반 상태** — `.harnie/plan/<slug>/`:
  - `plan.md` — 사용자 승인 **불변** 명세(+ 기계 파싱 `harnie-manifest` 블록)
  - `manifest.json` — plan.md에서 파생, `planHash`로 고정된 **immutable** 권위 집합
  - `execution.json` — **advisory** 실행 상태(phase·task runStatus·threadId). 권위 아님
  - `notepad.md` — **append-only** 발견·결정·검증 증거(단일 writer = 오케스트레이터)
  - `review/<unit>/` — 리뷰 루프별 `ledger.json`·`state.json`·`round-N.txt`·`receipt.json`
  - 스킬 시작 시 durable 상태를 읽어 passive resume. 권위 재도출은 [execution-state.md](execution-state.md) 참조.
- **크로스-프로바이더 공유**: 작업 대상 repo에 규약 파일이 있으면 Claude는 `CLAUDE.md`, Codex는 `AGENTS.md`(있을 경우)를 읽는다. 단일 소스는 `plan.md`·`notepad.md`(둘 다 읽음)다.

---

## 4. `quick` 트랙 (장애·작은 수정)

인라인 경량 + 엄격 실행 + 크로스-모델 리뷰. 인터뷰·승인 게이트·플랜 파일·오케스트레이션은 없지만 **리뷰는 축약하지 않는다**.

```
1. Intent & size — 한 줄로 재진술 + 진짜 작은지 확인. 크면 /harnie:dev-full 권함.
2. Read (필요시) — 낯설면 harnie-scout 병렬 스폰. 자명하면 skip.
3. (옵션) 상세 설계(경량) + 설계 리뷰(Codex) — 비자명하면. 자명하면 skip.
4. Write — Codex 빌더(workspace-write) 위임. surgical, 기존 스타일.
5. Verify(self) — 변경의 실제 위험에 맞는 tier 실행.
6. 코드 리뷰 루프 — harnie-reviewer(Claude), correctness + side-effect 중심. trivial도 축약 없음.
7. Report — 변경/검증 증거/리뷰 verdict + 완료 상태 footer.
```

---

## 5. `plan` 트랙 (신규·큰 변경)

풀 라이프사이클. main이 계획 국면 → 실행 국면으로 전환한다(에이전트 전환이 아니라 한 세션의 국면 전환).

### PHASE A — PLAN
```
A0. 활성 run 채택 — bootstrap 훅이 만든 sentinel/execution.json을 읽어 slug 사용(자체 init 금지). 이후 강제 훅 활성.
A1. 범위비례 그라운딩 — harnie-scout 병렬로 조사(호출경로·테스트·설정/env·데이터/마이그레이션·연동/API·문서·유사구현 중 관련 있는 것만 깊이).
A2. 근거 기반 질문 결정(CLEAR/UNCLEAR 폐기) —
     확인·추론 가능한 건 안 묻는다. 사용자만 정할 제품·정책 의도/해석 분기/재작업·호환성/외부 컨텍스트만, 근거·선택지·권장안 제시 후 최대 3개.
     안 묻는 가정은 plan.md `## Assumptions`에 기록.
A3. 아키텍처 설계(정식) + 리뷰 루프 — **조건부**(경계·소유권·기술선택이 바뀔 때만).
A4. 상세 설계(정식) + 리뷰 루프 — A3와 독립 루프. 설계 오류를 구현 前에 잡는다.
A5. 승인 게이트(1회) — plan.md를 제시하고 AskUserQuestion으로 명시적 승인. 승인이 실행을 연다.
```

### PHASE B — EXECUTE (v0.10.0: 러너 경로가 기본)
```
A6. 태스크 브리프 발급 — 승인 rev-N의 인용 섹션 원문 발췌를 태스크별 자기완결 파일로.
B1. 플랜 파싱 → 경로 선택: 배타 scope 태스크 2개↑ = 러너 경로(기본), 직렬은 근거 기록 필수.
B2′. 태스크당 harnie-task-runner 서브에이전트 병렬 spawn — 각자 자기 worktree에서
     Codex 빌드 → 인라인 Claude 유닛 리뷰(loop.mjs R1–R5) → scope 커밋 → 구조화 종료 보고.
     main 컨텍스트에는 종료 보고만 남는다(실측 지배 비용이던 누적 재독 제거).
B3′. 순차 통합(유일한 직렬화 지점) — merge → (충돌 시 해소분 CR) → 확인 리뷰(harnie-reviewer)
     → remove --archive-to 로 유닛 리뷰 상태를 run의 review-archive/에 보존.
B4. 작업별 검증 — verification-tiers.md tier + Manual QA + 플랜 재읽기.
B5. Final Wave — 게이트 Coverage·Quality·Runtime·Scope(항상 opus), 전부 APPROVE, 실패한 것만 재실행.
B6. Report + 완료 재도출 — manifest 순회 + errata v2 pending 산입 + 완료 상태 footer.
```
(직렬 경로 B2–B3은 단일 태스크 예외로 유지. 설계 결함 정정은 errata v2 — 엔진 소유 control 파일,
blocker/degrade disposition은 AskUserQuestion 훅 바인딩으로만 전이, 브리프 인용 섹션 키로 영향 전파.)

- **Final Wave 게이트**: **Coverage**(요구를 전부 충족했나 — under-build 차단) ↔ **Scope**(요청 범위만 — over-build 차단)가 대칭, **Quality**(정확성·안전성·과설계), **Runtime**(실제 실행 검증).
- **승인 게이트 前에 코드를 쓰지 않는다** — 이 불변식은 plan 트랙의 강제 훅이 기계화한다([execution-state.md](execution-state.md)).

### 워크스페이스 run (멀티레포, v0.4.0)

plan 트랙은 **비-git 워크스페이스 디렉터리**(repo 여러 개를 담은 부모, 예: `~/Tradlinx`)에서도 시작할 수 있다. 이때 run root는 git worktree가 아니라 `<workspace>/.harnie-wt/harnie-<slug>/` **평범한 디렉터리**이고, sentinel에 `workspaceRoot`와 `repos`(키→`{repo, workroot}`) 레지스트리가 실린다. 핵심 결정:

- **레포별 worktree**: 작업이 수정할 각 repo는 승인 게이트 前에 `execution.mjs repo-add`로 등록한다(워크스페이스 하위 + git toplevel 검증 → `<repo>/.harnie-wt/harnie-<slug>` worktree 생성 → sentinel 기록). manifest task는 `repo: "<key>"`로 자기 repo에 바인딩되고(all-or-none), scope 해시·verify cwd·빌더 cwd·capture/delta가 전부 그 workroot 기준이다.
- **합성 전체-tree 아티팩트**: Final Wave 게이트의 whole-tree 바인딩은 단일 tree SHA 대신 등록된 멤버 workroot들의 captureTree를 키 정렬로 합성한 `ws:<sha256>`(delta.mjs `captureWorkspaceTree`). 어느 멤버가 변해도 값이 바뀌어 게이트 재실행이 강제된다. task 단위 CR 아티팩트는 자기 멤버 repo의 40-hex tree이며, loop.mjs는 신선도(현재 tree와 일치)만 보고 task↔repo 권위 바인딩은 execution.mjs가 manifest repo 키 + scope 해시로 재검증한다(소유권 분리, DR-011 연장).
- **워크스페이스 root는 게이트 없음**: `<workspace>` 자체에는 `active.json`을 절대 만들지 않는다 — 남는 것은 세션→run 바인딩 포인터(`.harnie/sessions/`)와 세션-스코프 pending-route뿐이라, 같은 워크스페이스의 다른 세션·다른 작업은 이 run에 의해 잠기지 않는다.
- **가드 확장**: sanctioned CLI의 loop/worktree 대상과 빌더 codex cwd 허용 집합에 등록 멤버 workroot(및 그 하위 task worktree)가 추가된다. `execution.mjs --root`는 여전히 run root만이다.

---

## 6. `/harnie:dev` 라우터 + 트랙 스킬

진입점 = **커맨드 `/harnie:dev`(라우터) 1개 + 트랙 스킬 `dev-full`·`dev-quick`(직접 진입) 2개.** 겹치던 command↔skill 이름·역할을 분리하고, 트랙을 스킬 직접 진입으로 두어 본문이 결정적으로 로드된다(부트스트랩 갭 방지 — [bootstrap-adherence.md](bootstrap-adherence.md)).

```
/harnie:dev "<작업>"       → 크기 분류(작은 수정 vs 신규·구조변경)
              → 트랙 announce + 사용자 override 가능
              → 해당 트랙 스킬(dev-quick / dev-full) 호출
/harnie:dev-quick "<작업>" → quick 트랙 스킬 직접 진입
/harnie:dev-full  "<작업>" → plan 트랙 스킬 직접 진입
```

분류는 순수 프롬프트 로직. announce + override로 오라우팅을 상쇄한다. (내부 track 값은 그대로 `quick`/`plan`.)

---

## 7. 실행 상태 강제 (plan 전용)

plan 트랙은 **durable 실행 상태 + 최소 강제 훅 + read-only 코드 리뷰어**로 두 불변식을 기계화한다: **① 승인 前 소스 쓰기 금지 ② 미승인·미완료를 done으로 확정 금지.** 권위 = planHash 고정 immutable manifest + 각 리뷰 단위 ledger·state + verification receipt(`execution.json`은 advisory 캐시). 상세 = [execution-state.md](execution-state.md).

v0.10.0 확장: 빌더 threadId는 codex 호출 **cwd→task 매핑**으로 훅이 자동 귀속(복수 building 동시 허용, run-root 부트스트랩은 `rebind-task`의 `pendingRunRootBootstrap` 마커로만); `execution.json` 갱신은 전부 상태 락으로 직렬화; watchdog은 태스크당 1회 auto-cap(총 2×) 자동 연장 후 블록; `design/errata.md`는 control 파일(errata-add/arm/list, blocker·degrade 전이는 훅 바인딩, completion이 pending을 기계 산입); `worktree.mjs remove --archive-to`가 태스크 유닛 리뷰 상태를 run의 `review-archive/`로 보존(harness-digest 입력).

codex MCP·플러그인 메커니즘의 확정 사실(재현 가능) = [codex-mechanisms.md](codex-mechanisms.md).

---

## 8. 런타임 계약 (canonical)

리뷰/실패 루프의 상태 전이·progress·stagnation·검증 tier는 이 문서에서 **재서술하지 않는다**(복제 시 drift). 정본 = harnie 리포의 canonical 파일:

- [`instructions/loop.md`](../instructions/loop.md) — 리뷰 루프 상태 전이, 출력 계약(verdict + 안정 ID + status), progress/stagnation, 재리뷰 범위.
- [`instructions/review-loop-driver.md`](../instructions/review-loop-driver.md) — 루프 CLI·codex 배선(R1~R5, quick·plan 공통).
- [`instructions/verification-tiers.md`](../instructions/verification-tiers.md) — 검증 tier(위험 기준) + Manual QA + 대체 검증.
- [`instructions/code-review.md`](../instructions/code-review.md) · [`instructions/design-review.md`](../instructions/design-review.md) — 리뷰 기준(blocking/non-blocking).
- [`instructions/design-authoring-arch.md`](../instructions/design-authoring-arch.md) · [`instructions/design-authoring-detail.md`](../instructions/design-authoring-detail.md) — 설계 **작성** 출력 계약(고도별 경량/정식 분기). designer body는 역할·원칙만, 계약은 이 프로필을 주입.

이 문서는 **설계 근거·구조**만 담고, 실행 규칙은 위 canonical을 따른다.
