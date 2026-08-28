# harnie 아키텍처 — 크로스-모델 빌드/리뷰 루프

> 하나의 durable run을 Claude와 Codex 런타임이 이어받아 **설계 → 리뷰 → 개발 → 리뷰**를 진행하되, `harnie:dev`에서는 각 단계를 반대 모델이 리뷰한다. `dev-solo`는 fresh Codex 셀프리뷰로 대체하는 예외다. 구독 auth만으로 두 프로바이더를 조합한다.
>
> **0.13(2026-08-27)에서 L 파이프라인이 삭제됐다** — 러너 경로(`harnie-task-runner`·태스크별 worktree), CONTRACT 설계 고도, workspace(멀티레포) 모드, `worktree.mjs merge/archive`, errata v2, `harness-digest`가 모두 제거됐고, harnie가 자동화하는 범위는 **S/M 한 run**과 크로스모델 리뷰·강제 계층·스킬 허브다. L 이상의 분해·디스패치·통합은 사람 + orca가 소유한다. 근거 = [design-0.13-L-dismantle.md](design-0.13-L-dismantle.md).
>
> 이 문서는 **설계 근거·구조**를 담는다. 실행 규칙(상태 전이·검증 tier·리뷰 기준)의 정본은 [`instructions/`](../instructions/)이며(§6), 재서술하지 않는다.

## 핵심 아이디어

- **대칭 크로스-모델**(`harnie:dev` 기준): 산출물의 producer와 그 리뷰어를 **항상 다른 프로바이더**로 둔다. 같은 모델이 자기 산출물을 리뷰하면 같은 맹점을 공유하기 때문이다. **예외 = dev-solo**: Claude 구독 없이 Codex만으로 완주해야 하므로 리뷰어도 Codex다(fresh 서브프로세스 셀프리뷰 — 컨텍스트를 공유하지 않아 완전한 맹점 공유는 아니지만, 크로스-프로바이더도 아니다).
  - **설계** = Claude 산출 → **Codex** 리뷰
  - **개발** = Codex 산출 → **Claude** 리뷰
- **공유 컨텍스트 위 리뷰**: 리뷰어는 diff만 맨눈으로 보지 않고 계획·의도·제약을 주입받은 상태에서 판단한다.
- **증분 재리뷰**: 전체 재탐색 없이 **fix-델타 + 필요한 주변 문맥**만 다시 본다(stateful 세션). 승인까지 반복.
- **결과물은 파일로**: 계획·상태·리뷰 receipt는 `.harnie/`에 남아 다음 단계와 재개(resume)가 읽는다.

---

## 1. 역할 로스터

각 단계를 **반대 프로바이더가 리뷰**한다(`harnie:dev` 기준 불변식 — dev-solo 예외는 위 "핵심 아이디어" 참고). 에이전트 지침은 `agents/`에 자기완결 번들로 둔다.

| 역할 | 프로바이더 | 실행 | 쓰기 | 지침 |
|---|---|---|---|---|
| `harnie-scout` (코드 탐색) | Claude (T1 기본) | 서브에이전트 | read-only | 최소 출력계약(절대경로+요약, 병렬) |
| `harnie-designer` (설계 producer) | Claude (T3) | 서브에이전트 | 설계 텍스트 반환(파일은 main이 씀) | `design-authoring-{arch,detail}.md` 주입 |
| 설계 리뷰어 | **Codex** | codex MCP `read-only` | ✕ | `design-review.md`, REJECT 편향 |
| 코드 빌더 (개발 producer) | **Codex** | codex MCP `workspace-write` | ✍️ | 6-section 계약 + 주입된 설계 |
| `harnie-reviewer` (코드 리뷰어) | **Claude** | read-only 서브에이전트 | ✕ | `code-review.md` + `verification-tiers.md`, REJECT 편향 |

- **불변식**(`harnie:dev` 기준, dev-solo 예외): 리뷰어 = producer의 반대 프로바이더. read-only는 `tools` allowlist로 기계 강제.
- **루프 코어는 프로바이더 무관**: `scripts/loop.mjs`·`ledger.mjs`·`delta.mjs`는 상태머신·ledger 정합·델타 캡처만 결정적으로 처리하므로, producer/reviewer 프로바이더를 바꿔도 코드 변경이 없다.
- `harnie-builder`(Claude)는 역스왑(Claude 개발) 구성용 alternate로 유지되며 기본 흐름에선 호출되지 않는다.
- 티어 심볼 T1~T4 → 구체 모델 매핑은 [`instructions/model-matrix.md`](../instructions/model-matrix.md) §3이 단독 소유한다.
- 참조 규약: 에이전트는 **bare 이름**(사용자 override 허용), 스킬은 **네임스페이스**(`/harnie:…`, 충돌 안전).

---

## 2. 크로스-모델 리뷰 루프

```
1. 리뷰어 세션 OPEN — 공유 컨텍스트 주입(작업 의도 + 제약 + (plan이면) 설계)
   · Codex 리뷰어: codex MCP `codex`(developer-instructions로 기준 주입) → threadId 확보
   · Claude 리뷰어: read-only harnie-reviewer 서브에이전트
2. 리뷰어 → VERDICT(APPROVE|REJECT) + 안정 ID 이슈 목록 (REJECT 편향)
3. REJECT면: producer가 수정 → **델타만 재리뷰**(stateful: codex-reply / 재개, 전체 재-read 금지)
4. open blocking 0(APPROVE)까지 반복 — 유한 stagnation 캡, 사용자 중단 가능
5. (옵션) 최종 사인오프 = producer의 **반대 프로바이더로** fresh 리뷰(`harnie:dev`; dev-solo는 라운드마다의 셀프리뷰 자체가 사인오프 — 별도 단계 없음, `review-loop-driver.md` R5 참고)
```

- **효율 3원칙**: 실패 차원만 재실행 / stateful이라 재-read 금지 / fresh 리뷰는 최종 1회만.
- **증거 강제**: 리뷰 receipt(세션·verdict·ledger·수정요약)를 기록한다. open blocking이 남아 있으면 "done"이라 하지 않는다.
- 상태머신·ledger·progress/stagnation 규칙의 정본 = [`instructions/loop.md`](../instructions/loop.md), CLI 배선 = [`instructions/review-loop-driver.md`](../instructions/review-loop-driver.md).

---

## 3. 상태 & 공유 컨텍스트

durable **파일 기반 상태** — `.harnie/plan/<slug>/` (경로의 `plan`은 두 트랙 시절의 잔재이고, 지금은 이것이 유일한 트랙이다):
  - `plan.md` — 사용자 승인 **불변** 명세(+ 기계 파싱 `harnie-manifest` 블록)
  - `manifest.json` — plan.md에서 파생, `planHash`로 고정된 **immutable** 권위 집합
  - `execution.json` — **advisory** 실행 상태(phase·task runStatus·threadId). 권위 아님
  - `notepad.md` — **append-only** 발견·결정·검증 증거(단일 writer = 오케스트레이터)
  - `review/<unit>/` — 리뷰 루프별 `ledger.json`·`state.json`·`round-N.txt`·`receipt.json`
  - 스킬 시작 시 durable 상태를 읽어 passive resume. 권위 재도출은 [execution-state.md](execution-state.md) 참조.
- **크로스-프로바이더 공유**: 작업 대상 repo에 규약 파일이 있으면 Claude는 `CLAUDE.md`, Codex는 `AGENTS.md`(있을 경우)를 읽는다. 단일 소스는 `plan.md`·`notepad.md`(둘 다 읽음)다.

---

## 4. 파이프라인 흐름 (S/M)

풀 라이프사이클. durable 상태가 계획 국면 → 실행 국면으로 전환하며, 한 세션이 중단돼도 Claude `/harnie:dev`와 Codex `dev-solo`가 다음 스테이지부터 이어받을 수 있다. M보다 큰 작업은 harnie가 자동화하지 않는다. 분해·디스패치·통합은 사람과 orca가 소유한다.

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

---

## 5. 실행 상태 강제

plan 트랙은 **durable 실행 상태 + 최소 강제 훅 + read-only 코드 리뷰어**로 두 불변식을 기계화한다: **① 승인 前 소스 쓰기 금지 ② 미승인·미완료를 done으로 확정 금지.** 권위 = planHash 고정 immutable manifest + 각 리뷰 단위 ledger·state + verification receipt(`execution.json`은 advisory 캐시). 상세 = [execution-state.md](execution-state.md).

빌더 threadId는 codex 호출 cwd가 **run root**일 때 `pendingRunRootBootstrap` 마커 또는 단일 building-unbound serial 예외로만 훅이 자동 귀속한다. `execution.json` 갱신은 전부 상태 락으로 직렬화하고, watchdog은 태스크당 1회 auto-cap(총 2×) 자동 연장 후 블록한다.

codex MCP·플러그인 메커니즘의 확정 사실(재현 가능) = [codex-mechanisms.md](codex-mechanisms.md).

---

## 6. 런타임 계약 (canonical)

리뷰/실패 루프의 상태 전이·progress·stagnation·검증 tier는 이 문서에서 **재서술하지 않는다**(복제 시 drift). 정본 = harnie 리포의 canonical 파일:

- [`instructions/loop.md`](../instructions/loop.md) — 리뷰 루프 상태 전이, 출력 계약(verdict + 안정 ID + status), progress/stagnation, 재리뷰 범위.
- [`instructions/review-loop-driver.md`](../instructions/review-loop-driver.md) — 루프 CLI·codex 배선(R1~R5).
- [`instructions/verification-tiers.md`](../instructions/verification-tiers.md) — 검증 tier(위험 기준) + Manual QA + 대체 검증.
- [`instructions/code-review.md`](../instructions/code-review.md) · [`instructions/design-review.md`](../instructions/design-review.md) — 리뷰 기준(blocking/non-blocking).
- [`instructions/design-authoring-arch.md`](../instructions/design-authoring-arch.md) · [`instructions/design-authoring-detail.md`](../instructions/design-authoring-detail.md) — 설계 **작성** 출력 계약(고도별 경량/정식 분기). designer body는 역할·원칙만, 계약은 이 프로필을 주입.

이 문서는 **설계 근거·구조**만 담고, 실행 규칙은 위 canonical을 따른다.
