---
name: cross-review
description: 코드 델타 또는 설계 문서에 대해 크로스-모델 리뷰 루프(프로듀서와 리뷰어가 서로 다른 제공자, 리뷰어는 읽기 전용, 승인은 원장에서 계산)를 돌린다 — 어떤 파이프라인 밖의 plain 세션에서, 또는 harnie:dev M 파이프라인 내부에서. 얇은 래퍼 — instructions/loop.md, review-schema.md, review-loop-driver.md, 기준 문서, model-matrix.md를 참조로 조립하며 어느 것도 재서술하지 않는다.
---

# 크로스-모델 리뷰 (얇은 래퍼)

이 스킬은 **자체 리뷰 계약을 담지 않는다**. 크로스-모델 리뷰 루프를 어떤 세션에서든 — 파이프라인 내부뿐 아니라 — 돌릴 수 있게 하면서도 계약을 단일 원천으로 유지하기 위해 존재한다. 이 파일이 아래 문서들과 어긋나 보이면 그 문서들이 우선한다. Read해서 따르고, 그 내용을 이 파일이나 대화에 복사하지 않는다.

`<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`.

| 필요한 것 | 정본 파일 |
|---|---|
| 루프 계약 — ledger, 상태 전이, progress, contest 게이트, 재리뷰 스코프, 불변식 | `<ROOT>/instructions/loop.md` |
| 리뷰어가 반환하는 출력 스키마 | `<ROOT>/instructions/review-schema.md` |
| 결정적 배선 — capture/delta, 리뷰어 호출, 영수증, `apply`, 사인오프 | `<ROOT>/instructions/review-loop-driver.md` (R1–R5) |
| 기준 — 코드 루프(`CR`) | `<ROOT>/instructions/code-review.md` |
| 기준 — 설계 루프(`DR`), 고도 렌즈 포함 | `<ROOT>/instructions/design-review.md` |
| 난이도별 리뷰어 티어와 제공자 매핑 | `<ROOT>/instructions/model-matrix.md` §3 |
| 발견 수용 — 심각도가 아니라 필요성 | `<ROOT>/instructions/loop.md` § "Finding acceptance" |

## 두 사용처, 하나의 계약

1. **사람 주도** — `harnie:dev` run 밖의 plain 세션에서 작업 중이고, 생산한 아티팩트를 완료로 부르기 전에 반대 제공자가 리뷰하길 원한다. 이 스킬이 진입점이다.
2. **파이프라인 내부** — `harnie:dev`(M)가 설계·코드 리뷰 단계에서 같은 계약을 호출한다. `skills/dev/SKILL.md`는 run 특화 배선만 더한다(유닛 디렉터리, seal 윈도, `dr:` 아티팩트 해시, 완료 권한); 리뷰 계약 자체는 이 스킬이다.

둘 다 같은 문서로 귀결되어야 한다. 그것이 이 스킬의 존재 이유다: M 파이프라인이 언젠가 해체되어도, 리뷰 루프는 여기서 변경 없이 살아남는다.

## 절차

1. **루프를 명명한다.** 코드 델타 → `CR` 네임스페이스, 기준 `code-review.md`. 설계 문서 → `DR` 네임스페이스, 기준 `design-review.md`, 리뷰어 호출에 고도(ARCH / TASK-DETAIL — `model-matrix.md` §1)를 명시한다.
2. **리뷰어를 고른다.** 프로듀서의 반대 제공자다: Claude가 생산 → Codex가 리뷰(`sandbox:"read-only"`); Codex가 생산 → Claude가 리뷰(`harnie-reviewer` 서브에이전트). 리뷰어는 절대 쓰지 않는다. 티어는 `model-matrix.md` §3. 유일하게 승인된 동일-제공자 예외는 `dev-solo`이며, fresh하고 컨텍스트가 격리된 `codex exec --sandbox read-only` 서브프로세스로 대체한다 — `skills/dev-solo/SKILL.md` 참고; 다른 예외를 만들지 않는다.
3. **라운드를 실행한다.** `review-loop-driver.md` R1–R5를 그대로.
4. **각 발견을 판정하고** 루프를 닫는다 — `loop.md`를 따른다: 수용/기각은 "Finding acceptance" 절, 기각한 blocking 발견은 contest 게이트, 작업 완료 시점은 ledger 규칙과 불변식.

## 독립 실행 노트 (사용처 1)

- 리뷰 유닛 디렉터리는 리뷰 대상 레포 안의 `<repo>/.harnie/review/<unit>/`다. 그 레포를 `apply --root`와 `capture`/`delta`의 위치 인자로 동일하게 전달한다 — CLI가 포함 관계를 강제하고 그 밖의 경로는 거부한다. R1의 `capture --record <dir>`는 여기서도 변경 없이 동작한다 — 위치 인자 레포 자신의 `.harnie` 아래 record 디렉터리는 run 센티널을 요구하지 않으므로, R1이 요구하는 그대로 baseline 영수증도 독립적으로 유지된다.
- **run 밖의 DR 아티팩트**: 바인딩할 `planHash`도 승인도 없다 — 이는 `review-loop-driver.md` R4가 이미 승인 전 설계 루프의 조건으로 명명한 것이므로, 그 내용-단독 `dr:` 해시가 적용 규칙이다. `content ‖ planHash ‖ m-plan` 형태는 M의 승인 후 설계 루프 전용이며 독립 실행에는 대응물이 없다.
- Bash 가드는 승인된 CLI 호출이 아니면서 `.harnie`를 언급하는 어떤 명령도 거부한다 — 셸 메타문자 없는 단일 `node <ROOT>/scripts/{loop,execution,worktree}.mjs …`만 허용되며, `<ROOT>`는 로드된 플러그인 자신의 경로다. `round-N.txt`는 셸 리다이렉션이 아니라 Write 도구로 쓴다; `ledger.json`/`state.json`은 어떤 도구도 직접 쓸 수 없는 컨트롤 파일이다.
- run 밖에서는 run 상태도, 승인 게이트도, 완료 CLI도 관여하지 않는다; ledger가 권위의 전부다. 파이프라인의 다른 장치를 여기서 모사하지 않는다.

## NEVER

- 리뷰어가 프로듀서와 제공자를 공유하게 하지 않는다(위 `dev-solo` 예외 제외), 어떤 리뷰어든 파일을 쓰게 두지 않는다.
- ledger를 수작업으로 병합하거나, ID를 닫거나, 판정을 수작업으로 선언하지 않는다 — `loop.mjs apply`가 상태를 결정한다.
- 위 문서들의 계약 텍스트를 이 스킬, 프롬프트, run 아티팩트로 복사하지 않는다. 경로를 전달한다.
