# 실행 상태 & 강제 훅 설계 (⑥.6 C) — 상세 설계 (rev.10)

> plan 트랙에 **durable 실행 상태 + 최소 강제 훅 + read-only 코드 리뷰어**를 더해 harnie를 하네스로 만든다. 기계화할 불변식 둘: **① 승인 前 소스 쓰기 금지 ② 미승인·미완료를 done으로 확정 금지.**
> rev.10 = Codex 설계리뷰 8라운드 반영. **DR-001~014 전부 resolved.** rev.10 마감(DR-011): 해시 계산 **소유권 분리** — `loop.mjs`(quick·plan 공유 generic)는 `--artifact <postSHA>`로 `reviewedPostSHA`만 기록, plan task `reviewedScopeHash`는 `execution.mjs`가 manifest scope+postSHA에서 계산·검증, quick·Final Wave는 postSHA만. 위협모델 §0.1, lean(§2). **오픈 blocker 없음 — 설계 확정 후보.**
> 근거: [Hooks](https://code.claude.com/docs/en/hooks), [Plugin hooks](https://code.claude.com/docs/en/plugins), [Subagents](https://code.claude.com/docs/en/sub-agents).

## 0. 비목표
자동 retry 스케줄러·auto-continue·전문 에이전트 로스터·adversarial lane·compaction 자동 훅·다중 PR·worktree 격리(post-v0). **quick 트랙엔 execution.json·훅 없음.**

## 0.1 위협 모델 (설계 경계 — 이걸로 과-강화를 막는다)
harnie 가드는 **fallible·over-eager 오케스트레이터와 빌더의 실수**를 막는다: 승인 전 코드 작성, 미완료를 done으로 확정, 태스크 누락, 실수로 심판 상태 훼손. **막지 않는(막을 수 없는) 것**: 세션 전체를 통제하는 **의도적으로 적대적인** 오케스트레이터가 포인터를 `rm`하거나 스레드를 위조하거나 권한 자체를 우회하는 것 — 이는 원리상 봉쇄 불가(main이 도구·FS를 소유)이며 harnie의 목표가 아니다. 따라서 아래 강제는 **실수-안전**을 높이되, 적대적 완전봉쇄를 좇지 않는다(경량 정체성 유지).

## 1. 근본 원칙 — 권위는 review-state·manifest, execution.json은 advisory
완료·승인 판정의 **권위 = (a) planHash에 고정된 immutable manifest(필수 task·deps·gate 집합) + (b) 각 task/gate의 review-state(`ledger.json`·`state.json`, loop.mjs 소유, fail-closed) + (c) evidence receipt.** execution.json은 네비게이션 캐시. Stop 가드는 execution.json의 `phase/outcome`을 신뢰하지 않고 (a)(b)(c)에서 재도출한다.

## 2. 파일 배치 + 빌더 격리 (DR-003)
- `.harnie/plan/<slug>/`(**메인 트리**): `plan.md`(승인 명세) / `manifest.json`(A5에서 plan.md로부터 파생, planHash 고정, immutable) / `execution.json`(advisory) / `notepad.md`(append-only) / `review/<unit>/`(권위 ledger·state·round·evidence).
- control·review-state 직접 Edit/Write/Bash-write는 항상 금지(§5.1); 기록은 `execution.mjs` 검증 전이(atomic)로만.
- **빌더 격리 = lean (DR-013 결정, v0)**: v0에선 worktree 격리를 **defer**. 빌더(Codex workspace-write)는 **메인 트리(cwd=repo)** 에서 작업한다. 권위 상태(`.harnie/`)는 repo 안이라 빌더가 물리적으론 닿을 수 있지만, **실수-안전 가드**로 충분하다: ① **authority-state seal(DR-003)** — execution.mjs가 **빌더 호출 직전 권위 집합 전체의 canonical hash를 seal로 기록**한다. seal 입력 = `plan.md + manifest.json + 모든 review-unit의 ledger.json·state.json + 모든 verification/evidence receipt`(빌더 라운드 중 합법적으로 변하는 **advisory `active.json`·`execution.json`은 제외**). 빌더 산출 후 delta 귀속·ledger 적용 **전에 재해시 비교** → mismatch(빌더가 manifest·ledger·evidence 등 권위 파일을 건드림)면 **fail-closed**(그 라운드 무효·보고). delta 제외는 "숨기기"가 아니라 이 seal이 **독립 탐지**를 담당. ② loop.mjs가 ledger를 **fail-closed 구조 검증** ③ 빌더 프롬프트에 `.harnie/` 미접근 명시. **근거(§0.1)**: fallible 빌더가 *유효한 APPROVED ledger*를 실수로 위조할 확률은 무시가능 — 적대적 빌더 봉쇄는 비목표. **worktree lifecycle(생성·dirty seed·delta 승격·정리)은 구현 부담이 커 post-v0로 이연.**

## 3. Bootstrap·Active sentinel (DR-009 경계)
- **`.harnie/active.json`**(sentinel) = `{track, slug, planHash|null, readOnlyThreads:[…]}`. 훅은 이것만 본다. 부재=비활성 통과.
- **sentinel-first 부트스트랩**: PHASE A 시작 시(아직 아무 코드도 생성 전) sentinel을 **먼저** atomic write → execution.json 생성. sentinel이 있는데 execution.json이 없거나 malformed·planHash 불일치면 **fail-closed(차단)**. → crash 창 없음.
- 의도적 sentinel 삭제로 하는 우회는 §0.1 위협모델 밖(적대적). 실수-안전엔 sentinel-first로 충분.

## 4. manifest·planHash (DR-011)
- **승인 바인딩 (DR-014)**: planning→executing은 **실제 사용자 승인 응답**에만 근거한다. `/harnie:plan` A5는 Plan mode 진입 미보장이라 `ExitPlanMode` 전제 없이 **`AskUserQuestion`("이 계획을 승인/거절?")** 을 쓰고, 성공 여부가 아니라 **선택지·planHash까지 바인딩**한다:
  - **PreToolUse(AskUserQuestion)**: pending receipt `{tool_use_id, planHash(현재 plan.md 해시), 승인 질문·옵션}` 기록.
  - **PostToolUse(AskUserQuestion)**: **같은 `tool_use_id`의 실제 답이 "승인"이며 현재 planHash가 pending과 동일**할 때만 `execution.mjs`가 manifest 파생·planHash 확정·phase=executing 전이. **거절·질문 불일치·질문 이후 plan 변경(hash 불일치)** 은 **awaiting-approval 유지(fail-closed)**.
  → 사용자가 실제로 "승인"을 누르고, 그 시점 plan이 승인받은 그대로일 때만 실행이 열린다(over-eager main의 self-승인·승인 후 몰래 변경 차단). (Plan mode 배선 시 `ExitPlanMode` PostToolUse도 동일 패턴.)
- manifest 파생: plan.md의 **기계 파싱 가능한 작업/게이트 블록** → `{tasks:[{id, deps, reviewUnit, scope:[<경로>], verification:[{executable,args,cwd,timeout}]}], gates:[{name, reviewUnit}]}`. `planHash = sha256(plan.md ∥ manifest.json)`.
- 완료 재도출은 execution.json이 아니라 **manifest를 순회**: 각 task는 `reviewUnit` ledger가 APPROVE(open blocking 0) ∧ verification receipt pass, 각 gate는 그 gate의 review-state ledger가 approved. → task 삭제·gate 필드 위조는 manifest가 고정돼 무력.
- **manifest·receipt 스키마 (DR-011, 기계 검사 가능하게 고정)**:
  - manifest `gates`는 문자열이 아니라 `{name, reviewUnit}`(각 게이트도 `review/final-<name>/`의 ledger·state 경로·namespace `CR`를 가진다). task도 `{id, deps, reviewUnit}`.
  - **reviewed artifact 고정(DR-011a) — 소유권 분리**: `loop.mjs`는 quick·plan **공유 generic CLI라 manifest·scope를 모른다.** 따라서 **모든 CR `apply`는 `--artifact <postSHA>`를 받아 `reviewedPostSHA`(전체 tree)만 state에 기록**(설계 리뷰 `--ns DR`는 금지). **plan task의 `reviewedScopeHash`는 `execution.mjs`가** immutable `manifest.scope` 경로 + 그 `reviewedPostSHA`에서 **계산·검증**한다(git으로 해당 tree의 scope 경로 subtree 해시). quick·Final Wave는 scope 개념 없이 **`reviewedPostSHA`만** 쓴다.
  - **verification 명령(DR-011b)**: task별 `manifest.verification[]`의 **`{executable, args[], cwd, timeout}`** 를 `execution.mjs`가 `execFile`(**shell 없음**)로 실행해 실제 exitCode 기록(임의 명령·Bash 우회 불가). receipt = `{taskId, executable+args, exitCode, scopeHash, planHash, at}`.
  - **비교 도메인 분리(DR-011)**: **plan task 검증**은 `execution.mjs`가 `manifest.scope` 경로를 해시해 **`reviewedScopeHash`** 와 비교(검증이 `coverage/`·캐시 등 generated output을 만들어도 안 깨짐; 검증 전후 scopeHash 불변). **Final Wave 게이트**(및 quick)는 전체 통합을 보므로 **전체-tree postSHA를 `reviewedPostSHA`** 와 비교. 공통 pass: exitCode 0 ∧ planHash 일치.

## 5. 강제 훅 2개 (`hooks/hooks.json`)
### 5.1 H1 승인-前·control 보호 (PreToolUse) — DR-002, DR-003
matcher는 **앵커 정규식으로 확정**(설치 시 `Task`/`Agent`·MCP 정확 툴명 대조):
- `Write|Edit`: **권위(authority) 파일** — basename이 `manifest.json`·`execution.json`·`active.json`·`ledger.json`·`state.json`·`receipt.json`·`.seal.json`·`.pending-approval.json`·`.arm-approval.json`인 `.harnie/` 하위 — 이면 phase 무관 차단(case-insensitive, symlink-해소 canonical relPath 기준). `round-N.txt`·`delta.patch`·`design.md`·`plan.md`·`notepad.md`는 오케스트레이터/loop의 정당한 산출물이라 허용(구현 초기 `**/review/**` 전면 차단은 기능 파손이라 authority-basename만으로 좁힘). planning/awaiting-approval이면 `.harnie/<track>/<slug>/` 밖 쓰기 전부 차단. repo 밖으로 벗어나는 symlink/traversal도 차단.
- `Bash`: **sanctioned CLI**(신뢰 절대경로의 `node …/loop.mjs`·`…/execution.mjs`, 셸 메타 없음, `--root`·`--slug`·positional repo·출력경로가 active 컨텍스트에 바인딩)만 상태 쓰기 허용. **비-sanctioned 명령의 `.harnie` 접근은 phase 무관 전면 차단**(`find .harnie -delete`·`git clean -fd .harnie`·`node -e` 포함). 승인 前(planning/awaiting)엔 **read-only allowlist**만(쓰기 옵션·개행 연쇄·프로세스 치환·git 변경·임의 실행 차단). 승인 後(executing/final-wave)엔 소스 쓰기 Bash 허용(`.harnie`는 위에서 이미 보호). 보수적 fail-closed.
- `Task`: planning 중 write 가능 서브에이전트 위임 차단(read-only만).
- **Codex MCP (DR-002)** — 서버명에 underscore가 있으므로 정확 앵커 matcher는 `^mcp__plugin_harnie_codex__codex$` / `^mcp__plugin_harnie_codex__codex-reply$`(로컬 .mcp.json이면 `^mcp__codex__codex(-reply)?$`; 설치 시 실제 툴명 대조). 단계별:
  - **planning/awaiting-approval**: `codex`는 `sandbox=="read-only"`만; `codex-reply`는 `threadId ∈ active.json.readOnlyThreads`만(설계리뷰 스레드). workspace-write·미등록 스레드 차단.
  - **executing/final-wave (DR-002 최초 호출 부트스트랩)**: `runStatus=building`이고 `handle.builderThreadId==null`인 task에 한해 **최초 `codex`(workspace-write) 호출 1회 허용**(cwd=repo). 성공을 PostToolUse가 관찰해 그 threadId를 이 task의 builder thread로 등록. 이후엔 `codex-reply`가 **그 등록된 threadId**일 때만 허용(다른 task/미등록 스레드 차단). 설계리뷰 read-only 스레드도 계속 허용.
- **threadId 등록은 main이 아니라 `PostToolUse`가** 성공한 `codex` 호출을 관찰해 등록(DR-002 — main-공급 신뢰 제거): read-only 성공 → `readOnlyThreads`, workspace-write 성공(해당 task) → 그 task의 builder thread.

### 5.2 H2 미완료-확정 방지 (Stop) — DR-005, DR-012
불변식 = "incomplete를 done으로 확정 금지". 판정은 §1·§4 권위 재도출.
- 첫 호출(`stop_hook_active:false`): incomplete면 `{"decision":"block","reason":"남은 것 …"}`.
- **재호출(`stop_hook_active:true`): 무조건 통과하지 않는다(DR-012).** 자연어 파싱은 부정문·다국어에서 불안정하므로 **machine-readable footer 계약**을 쓴다: 오케스트레이터 최종 응답 말미에 `HARNIE_STATUS: COMPLETE` 또는 `HARNIE_STATUS: INCOMPLETE — <blocker 요약>`. Stop 입력의 `last_assistant_message`에서 이 footer를 파싱 — 권위상 incomplete인데 footer가 `COMPLETE`(또는 footer 부재)면 **계속 block**; footer가 `INCOMPLETE`+blocker 요약이면(정직 보고·제어권 반환) **통과**. (Claude Code 8회 연속 차단 강제종료가 backstop.)

## 6. read-only 코드 리뷰어 (DR-007)
전용 `harnie-reviewer`(tools=`Read,Grep,Glob`만). 설계 리뷰어(Codex)는 `sandbox:read-only`. driver·quick·plan에서 main-inline 제거(C 구현).

## 7. Resume (DR-006) — abort escape 제거 (DR-010)
- **resume = durable review-state에서 재도출**: manifest·각 reviewUnit ledger·state·round·baseline·plan.md/design.md를 읽어 fresh producer/reviewer에 open issue·receipt·round 주입. live 세션은 세션 내 최적화일 뿐 보장 대상 아님.
- **machine abort escape 없음(DR-010)**: 실제 사용자 interrupt엔 Stop 훅이 실행되지 않으므로 self-abort가 애초에 불필요하고, self-asserted `--user-cancelled`는 사용자 취소의 증거가 아니다. 종료는 "정직한 미완료 보고 → 제어권 반환"(§5.2 재호출 통과) 경로로만. execution.json에 `outcome=aborted` 필드/전이를 두지 않는다.

## 8. 상태 전이표 + 무효화 (DR-004 — 유지)
phase: planning→awaiting-approval→executing→final-wave→closed(completed). task: pending→building→built→(reviewStatus approved)→(verificationStatus verified). **무효화**: 검증 실패·코드 재변경 시 그 task review·verification 무효화(→building); Final Wave REJECT 시 수정 범위 task review·verification + **전체 게이트** 무효화. STALLED=review-unit 래치(task blocked, `--reentry`로 복귀). *closed는 §4 manifest 재도출이 참일 때만.*

## 9. 경로·무결성 (DR-009)
repo root 상향 탐색·slug `^[A-Za-z0-9._-]+$`(traversal 차단)·realpath containment(symlink 차단)·malformed/hash 불일치/부분기록 fail-closed. sentinel-first(§3).

## 10. 닫은 결정 + canonical
훅=`hooks/hooks.json`, 상태=별도 `execution.mjs`, 리뷰=`harnie-reviewer`(read-only). loop.md producer-neutral 완료; driver·quick·plan main-inline 제거는 C 구현.

## 11. 구현·테스트
- `scripts/execution.mjs`: init(sentinel-first)/manifest 파생·planHash/transition·무효화/**완료 재도출(manifest 순회)**/**authority-state seal 기록·비교(DR-003)**/**verification argv 실행·해시불변(DR-011b)**/PostToolUse 등록(builder threadId·승인). atomic·fail-closed. 순수 함수 단위 테스트.
- `scripts/loop.mjs` 확장(generic): CR `apply`에 `--artifact <postSHA>`, APPROVE 시 **`reviewedPostSHA`만 기록**(scope/manifest 무지 — quick 공유). `reviewedScopeHash`는 execution.mjs가 계산. 전체 suite 통과(개수는 PROJECT-STATUS 참조).
- `hooks/hooks.json` + H1·H2(+PostToolUse 등록) 스크립트.
- 음성 테스트: 빌더가 `.harnie/`에 실수 쓰기해도 delta 제외·loop.mjs fail-closed·완료 재도출 재검증으로 무해 / planning workspace-write·비승인 threadId codex-reply 차단·read-only 통과 / control·review-state 직접·Bash 조작 차단 / **execution.json/task 삭제해도 manifest 재도출로 Stop 차단** / **Stop 재호출에서 `HARNIE_STATUS:COMPLETE`(권위 incomplete)면 계속 차단·`INCOMPLETE`+blocker면 통과** / 검증실패·Final Wave REJECT 무효화 / planHash·traversal·symlink·부분기록 fail-closed / stale slug 무시.
- loop.md·driver·quick·plan 동기화, `harnie-reviewer` 신설. 완료 후 **B(스왑 full-loop E2E)**.
