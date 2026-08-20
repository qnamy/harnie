# PHASE B — EXECUTE (실행 단계)

> `skills/dev-full/SKILL-ko.md`에서 PHASE B로 진입할 때 이 파일을 읽는다. 그 파일의 Step 0·상태 위치·위임 참조 규칙·실행 상태/강제 훅·Notepad 프로토콜 섹션은 이미 읽었다고 전제한다 — 여기서 재서술하지 않는다. 이 파일은 B1과 **직렬 경로**(B2~B3), 그리고 **두 경로 공통** 단계(B4~B6)를 다룬다. **병렬 경로**(B2′~B3′)는 대신 `phases/phase-b-parallel-ko.md`를 읽고, B4로 돌아올 때 이 파일로 복귀한다.
>
> **워크스페이스 run(멀티레포):** 이 파일이 **git tree로서의 run worktree**를 언급할 때마다(빌더 `cwd`, `loop.mjs capture`/`delta` 대상, task-branch worktree) — **그 task의 멤버 repo workroot** (`<member repo>/.harnie-wt/harnie-<slug>`, sentinel의 `repos` registry에서) 로 대체한다. task가 어느 것인지는 manifest의 그 task `repo` key가 지명한다. 리뷰 상태 경로(`<repo>/.harnie/plan/<slug>/review/…`), 모든 `execution.mjs` 호출, `loop.mjs apply --root`는 run workroot `<repo>`를 계속 쓴다. 전체-run artifact는 B5 gate를 위해 `loop.mjs capture <repo>` → `ws:<sha256>` (모든 멤버 워크루트 합성). 다른 멤버 repo의 task는 구조상 disjoint scope를 갖으므로, manifest의 scope-disjoint 검증(arm-approval에서 강제)은 각 repo 내에서만 적용된다.

**B1. 플랜 파싱 → 작업별 파일 스코프 부여 → 실행 경로 선택.** manifest의 모든 태스크는 이미 `scope`(만질 경로, A4의 `harnie-manifest` 스키마)를 선언한다 — **경로만, glob 아님**: `loop.mjs delta`의 `outOfScope` 검사는 변경된 각 경로를 정확 일치 또는 디렉터리-접두어로만 대조하지 glob 확장을 하지 않으므로, 와일드카드 항목을 넣으면 실제 변경 전부가 범위 밖으로 오탐된다. 태스크 scope는 이미 **쌍마다 disjoint**임이 보장된다 — 같은 repo 안에서 어떤 경로도 다른 태스크 `scope` 항목과 동일하거나 상위/하위 디렉터리가 아니다 — `validateManifest`가 `arm-approval`(A5) 시점, 즉 manifest를 아직 고칠 수 있는 시점에 fail-closed로 강제하기 때문이다. 승인된 manifest는 겹침을 가질 수 없으므로 B1은 재검사하지 않는다. (검사가 여기가 아니라 A5에 있는 이유: 승인 후 manifest는 A5.2의 사용자 게이트 개정으로만 바뀌므로, B1 시점 발견은 그 전면 재승인을 강제하게 된다.) 비중첩 스코프는 병렬 실행의 **전제조건**이며, 승인 게이트가 보장하는 것이지 런타임 가드가 아니다.

그다음 경로를 고른다:
- **직렬 경로 — 태스크 1개, 또는 총 규모가 작아 격리로 얻을 게 없을 때.** 아래 B2~B3를 그대로 진행: worktree 없이 빌더 1개, 리뷰 루프 1개, run worktree에서 직접.
- **병렬 경로 — 태스크 ≥2개이고 스코프가 비중첩일 때.** `phases/phase-b-parallel.md`를 지금 읽어 B2′~B3′를 진행한다: 태스크마다 격리 worktree를 갖고 병렬로 빌드·리뷰한 뒤 하나씩 merge한다. manifest `deps`가 다른 태스크를 지정한 태스크는 그 의존 태스크의 B3′ **4단계 확인이 APPROVE된 후에만**(merge만으론 부족 — 거기서 REJECT되면 그 태스크의 코드가 다시 바뀔 수 있다) 시작한다 — 오케스트레이터가 손으로 적용하는 순서 규칙 한 줄이며, 이를 위한 스케줄러·의존 그래프 실행기·자동 재시도는 만들지 않는다. 모든 태스크의 B3′ 4단계가 APPROVE되면 이 파일로 돌아와 B4를 진행한다.

### 직렬 경로

- **워치독 계약.** 워치독 deny를 받으면 즉시 진행 상황·블로커를 사용자에게 보고하고 지시를 기다린다. 연장은 사용자 동의 후 `execution.mjs watchdog-extend --reason`으로만 한다. task별 예산 기본값은 30분/빌더 15콜이며 manifest의 `difficulty` 필드로 티어링된다(`hard` = 60분/25콜) — 리뷰 라운드도 빌드와 같은 벽시계를 소모한다.

**B2. 작업 → Codex 빌더 위임 (개발 producer = Codex).** 위임 직전 순서로: ① `execution.mjs set-task --root <repo> --slug <slug> --task <id> --run-status building`(빌더 workspace-write codex 부트스트랩을 훅이 이걸로 게이트) → ② `loop.mjs capture <repo>`로 baseline 캡처(B3 R1 fix-delta 기준점) → ③ `execution.mjs seal --root <repo> --slug <slug>`(권위 스냅샷). 그다음 **Codex 빌더**(codex MCP, `sandbox:"workspace-write"`, `approval-policy:"never"`, `cwd:<repo>`, **run 난이도 모델**(`model-matrix.md` §3: easy = `gpt-5.6-luna`, 순수 기계적이면 `gpt-5.3-codex-spark`, medium = `gpt-5.6-terra`, hard = `gpt-5.6-sol`; 모델 선택이 불가능하면 설치 기본값))에게 위임 — 프롬프트에 작업 지시 + **승인된 `plan.md`의 해당 설계 섹션**을 실어 리뷰된 설계대로 짓게 한다. 6-section 계약(요구/설계간단/구현/견고함/테스트/검증) — 요약이며 구현 소스 전문이 아님(review-loop-driver.md 참조). 또한 `review-loop-driver.md`의 **빌더 위임 계약** 상시 규칙(baseline 대비 테스트 증거, 신규 테스트 fail-capability 증명, 홈 디렉터리 캐시 도구의 캐시 경로 사전 지정)을 프롬프트에 포함한다. surgical scope. **빌더는 `.harnie/`에 접근하지 않는다**(권위 상태는 오케스트레이터·CLI 소유). threadId는 PostToolUse 훅이 성공한 codex를 관찰해 등록(재수정은 codex-reply).

**B3. ★ 코드 리뷰 루프, run worktree(크로스-모델; 완료 판정의 정본 리뷰 유닛 — 두 경로 모두 여기로 수렴).** 빌더 산출 직후 delta 귀속 前 **`execution.mjs seal-verify --root <repo> --slug <slug>`**(빌더가 권위 파일을 실수로 훼손했으면 fail-closed → 그 라운드 무효·보고). 통과하면 review-loop-driver.md R1~R5:
- producer = **Codex 빌더**, **리뷰어 = read-only `harnie-reviewer` 서브에이전트**(frontmatter에서 opus로 모델 고정 — 품질 게이트의 **리뷰어 모델은 절대 티어링하지 않는다**, `model-matrix.md` §3; main 인라인 아님 — 빌더가 Codex라 크로스-모델, 리뷰어는 쓰기 불가). 기준 = code-review.md + verification-tiers.md. namespace = `CR`. `<dir>` = `.harnie/plan/<slug>/review/<unit>/`(manifest의 그 작업 `reviewUnit`, **run worktree 안**).
- 리뷰어는 loop.md VERDICT/ISSUES 스키마로 `round-N.txt`에 기록. `apply`엔 **이 라운드 delta의 `postSHA`를 `--artifact`로** 넘긴다(CR 필수 — execution.mjs가 이 tree에서 `reviewedScopeHash` 재계산해 검증을 리뷰 tree에 바인딩). 수정 → 델타만 재리뷰(Codex 빌더 codex-reply). 전 차원 APPROVE까지.
- **병렬 경로** — 기준·namespace·`<dir>`은 같고, 태스크마다 run worktree에서 돈다:
  - **타이밍:** 그 태스크의 B3′ merge가 반영된 **후, 그 태스크 worktree가 제거되기 前**(`phases/phase-b-parallel.md`) — B2′ 빌드 직후도 아니고, worktree가 사라진 뒤도 아니다. `execution.mjs verify`/`completion`이 실제로 읽는 것은 이 라운드, 이 `<dir>`이다. 태스크 worktree 안에서의 머지 前 리뷰(B2′ 5단계)는 격리된 코드에 대한 앞선 품질 게이트일 뿐, 이를 대체하지 않는다.
  - **Baseline·scope:** R1 baseline = B3′ 1단계에서 그 태스크의 merge 직전에 캡처한 `mergeBaselineSHA` — 그래야 이 라운드가 리뷰하는 delta가 그 merge(와 있었다면 충돌 해결 커밋)가 들여온 것 정확히 그만큼이지, 뒤 태스크의 것이 안 섞인다. `--scope`는 그 태스크의 선언된 `scope` **더하기** 충돌 해결이 그 밖에서 건드린 경로(B3′ 3단계)까지 함께 넘긴다 — 후자를 빼먹으면 `delta`의 `outOfScope` 검사가 해결 편집을 귀속 안 된 외부 변경으로 오탐한다.
  - **사전 맥락:** 태스크의 머지 前 verdict·라운드 수(run의 `notepad.md`로 전달, B2′ 참조)를 리뷰어에게 제공해, 이 라운드가 완전 재스캔이 아니라 **경량 확인**(merge된 결과와 merge 자체가 바꾼 부분 확인)이 되게 한다.
  - **seal-verify 반복 금지:** 이 라운드 서두에 `execution.mjs seal-verify`를 다시 돌리지 않는다 — B3′ 3단계가 아직 어떤 리뷰 라운드 파일도 없을 때 이미 한 번 돌렸다. 여기서 또 돌리면 그 단계가 정당하게 써 넣은 `merge-t<id>` ledger·state를 훼손으로 오판한다.
  - **REJECT 시:** 태스크 worktree와 그 빌더 스레드가 **아직 존재한다**(B3′가 정확히 이걸 위해 이 라운드 이후로 제거를 미룬다 — 5단계 참조). 그 자리에서 같은 Codex 빌더에게 `codex-reply`로 수정을 요청하고, `harnie/<slug>-t<id>`에 커밋(B2′ 6단계와 동일)한 뒤 — merge 前에 캡처, B3′ 1단계와 같은 순서 — 새 `mergeBaselineSHA`를 먼저 캡처하고 `worktree.mjs merge`를 **다시**(같은 브랜치의 새 커밋만 들여오는 두 번째, 증분 merge) 돌려 그 새 baseline부터의 delta만 재리뷰한다. 이미 등록된 빌더 스레드만 재사용하며, 이미 바인딩된 태스크에 두 번째 빌더를 새로 부트스트랩하는 것과 달리 엔진에 없는 능력이 필요 없다.

뒤 태스크의 델타가 앞서 이미 merge된 태스크가 만졌던 경로를 건드리는 경우(manifest의 disjoint 검증은 선언된 `scope`만 대조했지 실제 diff는 아니므로 여기서 놓칠 수 있음) — 이것도 scope 겹침 위반으로 똑같이 처리한다: 뒤 태스크의 빌드를 반려하고, 그 worktree를 갱신된 run 브랜치 위로 rebase한 뒤 merge 前 재리뷰한다.

### 두 경로 공통

**B4. 작업별 검증.** `execution.mjs verify --root <repo> --slug <slug> --task <id>`를 **run worktree**에서, 그 태스크의 B3 확인 라운드 후에 실행한다 — manifest의 `verification[]` argv를 shell 없이 실행해 exitCode·scopeHash·planHash receipt를 기록한다(reviewedPostSHA 기준). 추가로 Manual QA(자동으로 못 잡는 사용자 가시 동작) + `plan.md` 재읽기로 범위 대조. 완료는 **ledger APPROVE ∧ receipt pass**로 재도출되므로(권위), 검증 실패·코드 재변경은 자동으로 미완료가 된다.

**B5. Final Wave (규모비례, 병렬) — 게이트 `Coverage·Quality·Runtime·Scope`.** 전체가 하나로 맞물리는지 run worktree에서 최종 확인 — B1이 직렬·병렬 어느 경로를 골랐든 이 시점엔 모든 태스크가 한 tree로 merge돼 있으므로 무관하다. **각 게이트를 별개 리뷰 단위로** review-loop-driver.md로 구동(namespace `CR`, `<dir>`=`review/final-<gate>/` — `coverage`·`quality`·`runtime`·`scope`):
- **Coverage** — plan.md·설계 결정·요구 ID를 실제로 **전부 충족**했나(커버 안 된 FR/NFR = under-build).
- **Quality** — 정확성·안전성·과설계(code-review.md 렌즈 전체).
- **Runtime** — 실제 실행 검증(verification-tiers.md, 통합 경계 포함). 미검증 위험 = REJECT.
- **Scope** — 요청 범위만 완결, 요청 안 한 것 안 만듦(scope inflation = over-build 차단).
- 리뷰어 = read-only **`harnie-reviewer`**(코드 단계이므로; 빌더=Codex의 반대). 각 게이트도 `apply`에 그 시점 tree의 `--artifact <postSHA>`를 넘긴다. 전부 APPROVE, **실패한 게이트만 재실행**. 기본 Claude 단독, 사용자가 "고정밀" 요청 시 dual(Codex 최종 사인오프 auxiliary 추가).

**B6. Report + 완료 재도출.** `execution.mjs completion --root <repo> --slug <slug>`으로 manifest를 순회해 완료를 재도출한다(각 task = ledger APPROVE ∧ receipt pass ∧ 현재 scope==리뷰 scope, 각 gate = ledger approved ∧ 현재 전체 tree==리뷰 tree). 요약: 변경 파일 + 작업별 tier·검증 증거 + 각 리뷰 단위 최종 verdict(ledger·round) + Final Wave 4게이트 verdict. **최종 응답 말미에 machine-readable footer를 emit한다**: 재도출이 complete면 `HARNIE_STATUS: COMPLETE`, 아니면 `HARNIE_STATUS: INCOMPLETE — <남은 blocker 요약>`. Stop 훅이 같은 재도출로 판정하므로, 권위상 미완료인데 COMPLETE라 주장하거나 footer를 빠뜨리면 종료가 차단된다. 남은 blocking·STALLED 단위·미검증 범위는 정직하게 INCOMPLETE로 보고하고 제어권을 반환한다.
