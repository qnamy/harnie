# 리뷰 루프 드라이버 (canonical) — 모든 루프의 CLI/Codex 배선

`loop.md`가 계약(ledger, 전이, progress, contest)을 소유하고, 이 파일은 그것을 결정적으로 실행하는 방법을 소유한다. ledger 병합이나 상태 전이 판정을 절대 수동으로 하지 않는다 — `scripts/loop.mjs`가 거짓 승인을 막는다.

**리뷰어 = `harnie:dev`에서 생산자의 반대 제공자.** 설계 루프(`DR`): 생산자 Claude designer → 리뷰어 Codex(`sandbox:"read-only"`). 코드 루프(`CR`): 생산자 Codex builder → 리뷰어 Claude(`harnie-reviewer` 서브에이전트). **예외는 dev-solo다**: 생산자와 리뷰어가 둘 다 Codex다 — 리뷰어는 서브에이전트가 아니라 fresh하고 컨텍스트가 격리된 `codex exec --sandbox read-only` 셀프리뷰 서브프로세스다(`skills/dev-solo/SKILL.md` 참고).

`<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`. `<dir>` = 리뷰 유닛 디렉터리(`.harnie/plan/<slug>/review/<unit>/`). `<repo>` = run workroot.

## 빌더 위임 (코드 루프)

Codex MCP `codex`로 위임한다(`sandbox:"workspace-write"`, `approval-policy:"never"`, cwd = 빌더의 트리, 모델은 `model-matrix.md` 기준); 수정은 등록된 스레드에 `codex-reply`. 첫 프롬프트는 반드시 포함한다: 태스크 내용(브리프/설계 인라인 — 절대 `.harnie` 경로 아님), scope-test 세트, 사전 지정 캐시 경로(있다면), 그리고 **`<ROOT>/instructions/builder-contract.md`의 절대 경로와 먼저 Read하라는 지시**(경로 참조형 상시 규칙 — 검증된 산출물; 인라인하지 않는다).

**행 걸린 디스패치(Stalled dispatch)**: MCP idle 타임아웃 / `AbortError` 발생 시, 호출 전 baseline과 트리를 대조한다. 변경 없음 → 새 `codex` 호출로 1회 재시도(프롬프트 재인라인, 스톨 기록). 변경 있음 → `codex-reply`로 1회 재시도. 동일한 스톨이 두 번째면 인프라 문제 — 멈추고 표면화한다. 바인딩된 스레드의 제공자-종결 오류(`Session not found`류) → **사용자 승인 해제 경로**(절대 무음으로 새 스레드를 열지 않는다): ① `node <ROOT>/scripts/execution.mjs rebind-arm --root <runRoot> --slug <slug> --task <id> --old-thread <boundThreadId> --evidence "<the provider's terminal response verbatim|@file>"` (**--root는 항상 run workroot다** — binder/arm 상태는 거기에 살며, 절대 태스크 worktree나 멤버 루트가 아니다) — evidence는 종결 마커를 담아야 하고(idle 타임아웃은 거부된다), old-thread는 현재 바인딩과 일치해야 하며, 다른 arm/pending이 존재해서는 안 된다(run 전체 원샷 배타성); ② **바로 다음 AskUserQuestion**은 본문에 봉인된 evidence 원문 그대로와 태스크 id, 기존 threadId를 제시해야 한다(훅이 대조한다 — 요약으로는 바인딩되지 않는다); ③ 정확한 승인 선택만이 스레드를 원자적으로 해제하고 run-루트 부트스트랩 마커를 arm한다; 카운터/앵커는 절대 리셋되지 않는다.

## R1. fix delta 캡처 (오케스트레이터 생성, 코드 루프 전용)

```
node <ROOT>/scripts/loop.mjs delta <repo> <baselineSHA> --scope <paths> --out <dir>/delta.patch
```
baseline은 각 생산자 윈도우 직전에 캡처한다(`loop.mjs capture <repo> --record <dir>` — `--record`는 필수: `baseline-N.json` 영수증이 라운드의 앵커 증거다). `outOfScope`가 비어 있지 않으면 → 귀속 불변식에 따라 멈춘다. `<out>.json` 사이드카가 라운드별 실제 변경 경로를 기록한다. 설계 루프에는 delta가 없다: `.harnie` 문서는 제외 — 대신 산출물 **경로**를 전달한다(아래).

## R2. 리뷰어 호출

기준(criteria)은 리뷰어가 스스로 Read하는 파일이다 — 네가 인라인하지 않는다.

- **Codex 리뷰어 (설계)**: 첫 리뷰 = `codex`, `sandbox:"read-only"`, `model:"gpt-5.6-sol"`, `developer-instructions` = 해당 기준(`design-review.md` + `review-schema.md`, 스레드당 1회 주입), 프롬프트 = 의도 + 제약 + 설계 파일의 절대 경로와 읽으라는 지시, **고도(ARCH / TASK-DETAIL) 명시**. 재리뷰 = `codex-reply`에 수정본 경로 + 변경된 섹션 이름만. threadId를 기록한다.
- **Claude 리뷰어 (코드)**: `harnie-reviewer`에 위임(모델 = 이 리뷰 종류의 tier, `model-matrix.md`), 경로만 전달: `<dir>/delta.patch`, 이전 ledger, 짧은 범위/의도 요약, **섹션 이름을 포함한** 설계 참조. 새 유닛(이전 ledger 없음)은 모든 이슈를 `(open)`으로 내야 한다. 재리뷰 라운드는 아직 open인 ID를 명명하고 delta에서 판정한다 — 이후 라운드는 1라운드보다 비용이 적어야 한다.
- **Contest** (loop.md contest 게이트): `CONTEST` 블록을 이 호출에 전달하고, 응답 후 사이드카 `<dir>/contest-N.txt`를 쓴다.

## R3. 영수증 저장

원시 응답을 그대로 `<dir>/round-N.txt`로 저장한다.

## R4. 결정적 apply

```
node <ROOT>/scripts/loop.mjs apply --root <repo> --ledger <dir>/ledger.json \
  --review <dir>/round-N.txt --ns <CR|DR> --state <dir>/state.json --artifact <artifact> \
  [--limit 3] [--progress auto|yes|no] [--reentry <reason>]
```
- `--artifact`: **CR** = 이 라운드의 `postSHA` — 필수, 검증을 리뷰된 트리에 바인딩한다. **DR** = 고도별 입력을 가진 `dr:<sha256(…)>`: **승인 전 루프(ARCH)**는 설계 파일 내용만 해시한다 — 아직 권위가 존재하지 않고 리비전마다 새 파일이므로, 내용 정체성으로 충분하다; **승인 후 TASK-DETAIL 루프(M의 단일 설계 — M에는 승인 전 설계 리뷰가 없다)**는 `design content ‖ planHash ‖ edition token`을 해시하며, edition token은 리터럴 `m-plan`이다 — 재개 때마다 현재 권위에서 재계산해 저장값과 대조한다(불일치 = 낡은 승인 → 재설계). `planHash`가 입력이므로 A5.2 재승인은 낡은 설계 승인을 기계적으로 무효화한다.
- 출력: `needsReRequest` → 스키마 오류를 명시해 리뷰어를 재프롬프트한다(생산자 호출 아님). `needsReentry` → STALLED 래치; 먼저 사용자에게 표면화. `machineState` REVISING → 생산자 수정(코드: 먼저 baseline 재캡처); APPROVED → 완료(`sessionSplitRecommended`는 세션 분할 제안을 발화); STALLED → 멈추고 보고.
- **순서 하드 룰**: 라운드 N의 `apply`가 `committed: true`로 끝난 **뒤에야 다음 생산자 호출**이 가능하다 — apply 누락은 복구 불가(낡은 artifact, 알 수 없는 ID); 재구성하지 말고 그 리뷰를 새 라운드로 재실행한다.

## R5. 선택적 최종 사인오프

실질적 변경에는: 신선한 크로스-모델 사인오프 1회(코드 → 미커밋 diff에 대한 새 Claude 리뷰; 설계 → 새 Codex 리뷰). 루프 안에서는 절대 stateless 재리뷰를 하지 않는다. **dev-solo에는 별도 사인오프 단계가 없다**: 라운드마다의 셀프리뷰(fresh `codex exec` 서브프로세스)가 이미 사인오프이므로, 그 위에 얹을 크로스모델 리뷰어가 없다.

> 불변식: 모든 수정은 리뷰된다; 영수증을 보존한다(verdict, ledger, progress 근거, contest 사이드카, 수정 요약). blocking 이슈가 열려 있는 동안 완료가 아니다.
