# Harnie 리뷰 루프 상태 기계 (canonical)

리뷰 루프의 단일 정의: ledger 규칙, 상태 전이, progress, contest 게이트, 재리뷰 범위. 출력 스키마는 `review-schema.md`에 있다(리뷰어는 그것만 읽는다). 오케스트레이터는 이 계약을 `scripts/loop.mjs`로 집행한다 — 절대 수동으로 하지 않는다.

## 역할

- **생산자(Producer)** = 산출물의 저자: 설계 루프에서는 designer(Claude), 코드 루프에서는 builder(Codex).
- **리뷰어(Reviewer)** = `harnie:dev`에서 생산자의 **반대 제공자**, 항상 read-only. 설계 = Codex가 리뷰; 코드 = Claude가 리뷰. **예외는 dev-solo다**: 생산자와 리뷰어가 둘 다 Codex다 — fresh하고 컨텍스트가 격리된 `codex exec --sandbox read-only` 셀프리뷰 서브프로세스가 크로스-프로바이더 리뷰어를 대신한다(`skills/dev-solo/SKILL.md` 참고).

## Ledger (승인 증거)

승인은 모든 영수증에 걸친 집계 이슈 ledger에서 계산된다 — 하나의 응답에서가 아니다.

- 모든 재리뷰는 **범위 내 이전 open 이슈 전부**에 대해 `open` 또는 `resolved`를 보고한다. 누락 ≠ 해소: 누락된 이슈는 방어적으로 open 유지(**blocking** 이슈 누락 또는 verdict 일관성 붕괴 → 리뷰 재요청; non-blocking 누락 → 프로토콜 위반 기록 후 계속).
- **일관성 불변식**: `APPROVE ↔ open blocking = 0`; `REJECT ↔ open blocking ≥ 1`. 위반 시 그 응답은 무효.
- **Resolved는 검증됨을 의미한다** — 현재 범위와 결정 하에서. 주장됨도, 누락됨도 아니다. 이후 델타가 그 위험을 재도입하면 **같은 ID**를 다시 연다.
- **ID는 그것이 열린 ledger에 스코프된다.** Final 게이트의 ID는 태스크 유닛의 ID가 될 수 없고 그 반대도 마찬가지다; "유닛 X로 이월"된 발견은 X 자신의 ledger에서 새로 열지, 거기 존재한다고 가정하지 않는다.

## 상태 전이 (limit 기본 3)

```
REVIEWING ─APPROVE→ APPROVED
REVIEWING ─REJECT(first review)→ REVISING
REVISING  ─submit fix delta→ REVIEWING
REVIEWING ─REJECT+progress→ REVISING (stagnation=0)
REVIEWING ─REJECT+no progress+(stagnation+1<limit)→ REVISING (stagnation+=1)
REVIEWING ─REJECT+no progress+(stagnation+1≥limit)→ STALLED
STALLED   ─explicit re-entry assertion→ REVISING (stagnation=0)
```

**Progress** (영수증에 증거와 함께 기록): ① 원인을 좁히거나 다음 결정을 바꾸는 새 증거; ② 측정 가능한 산출물 개선; ③ open-blocking 수 감소(파서가 계산). 단순히 코드를 바꾸는 것, 변경 없는 검사의 재실행, 하나의 blocker를 다른 것으로 바꾸는 것은 progress가 아니다.

**STALLED는 래치된다.** 증거·blocker·미검증 범위를 사용자에게 보고한다; 재개는 표면화 이후 단언된 `apply --reentry <new-evidence|external-state|user-decision|scope-change>`로만 가능하다(scope-change는 사용자 승인 필요). 이후 게이트의 progress가 자동으로 래치를 풀지 않는다.

## Contest 게이트 (0.11) — 발견을 구현하지 않고 반박하기

생산자 측이 틀렸다고 믿는 open **blocking** 발견에 대해, 오케스트레이터는 정확히 두 가지 근거로 **수정 대신 contest**할 수 있다:

- `altitude` — 그 요구가 현재 리뷰 고도(ARCH / TASK-DETAIL / code) 밖이다.
- `overengineering` — 메커니즘 추가로만 충족 가능하며, 리뷰어가 그것이 방지하는 구체적 실수 시나리오를 제시하지 않았다.

계약:

1. 다음 리뷰어 호출에 `CONTEST [ID] reason=<altitude|overengineering> : <2–3문장 근거>` 블록을 전달한다 — 해당 ID에 대한 산출물 변경 없음. 한 라운드에 여러 ID를 contest할 수 있다.
2. **리뷰어의 다음 응답이 판가름한다**: 인정(concede) → 그 ID를 `resolved`로 보고(선택적으로 새 non-blocking ID 개설); 고수(insist) → `open` 유지하고 구체적 실수 시나리오를 명시.
3. 고수 시: 재논쟁 없음, stagnation 소모 없음 — **즉시 사용자에게 에스컬레이션**한다(ID, 리뷰어의 시나리오, 네 근거, 각 경로의 비용). 사용자가 위험을 수용 → 기존 `user-decision` 해제 경로; 사용자가 리뷰어 편 → 일반 REVISING.
4. **Contest 불가**: 정확성·안전·미검증-위험 발견. 그런 발견에 CONTEST를 받은 리뷰어는 고수한다.
5. **종결 권한은 절대 이동하지 않는다**: ID를 닫는 것은 리뷰어의 응답 또는 사용자 결정뿐이다. 각 contest 라운드를 `<dir>/contest-N.txt` 사이드카에 기록한다(CONTEST 원문, verdict, `--progress yes` 근거 `contest-adjudication`, 에스컬레이션 여부) — contest가 어떻게 판가름됐는지에 대한 run 자체의 기록이다.
6. 판정(adjudication) 라운드는 blocking 수가 그대로여도 정당하다 — 사이드카 근거와 함께 `--progress yes`를 전달해 stagnation을 소모하지 않게 한다.

## 발견 수용 — 심각도가 아니라 필요성

각 발견의 수용/기각은 심각도 라벨이 아니라 수정이 *필요한지*로 판단한다. 수용: 구체적 실패나 오독을 막거나, 명백한 실결함(사실 오류, 깨진 참조)이거나, 비용은 낮고 가치는 분명한 것. 기각: 구체적 실수 시나리오 없이 메커니즘을 추가하는 것, 스코프 확장, 취향성 다듬기. 전부 일괄 수용도, 전부 일괄 미수정도 하지 않는다.

non-blocking 발견의 기본값은 **미수정**이다: ledger에서 open으로 남고 완료 시 open으로 보고된다 — 위 필요성 판정이 수정이 필요하다고 말할 때만 고친다.

수용한 non-blocking 수정은 blocking 수정과 같은 라운드에 실린다 — non-blocking 전용 재리뷰 라운드를 따로 만들지 않는다.

기각한 발견은 사유와 함께 다음 리뷰어 호출에 전달해 재리뷰 스코프에서 제외한다(재등장 방지). blocking 기각은 위 contest 게이트를 따른다(altitude/overengineering 근거, 리뷰어가 판가름). non-blocking 기각은 전달만으로 충분하다. 완료 조건은 그대로 blocking 0이다.

## 사람 게이트 blocking 이슈: 루프 돌지 말고 에스컬레이션

이슈 해소에 run 밖 행동(실제 외부 시스템, 자격증명, 수동 QA)이 필요하면, 영수증에서 human-gated로 분류하고 **즉시 에스컬레이션**한다 — 절대 그것을 두고 반복하지 않는다. 해제는 사용자만 한다: 사용자가 조치하거나 명시적으로 위험을 수용하면(`user-decision`; 리뷰어가 다음 라운드에 ID를 닫고 최종 보고서가 needs-human-action 아래에 나열), 아니면 run은 정직하게 `HARNIE_STATUS: INCOMPLETE`로 끝난다.

## 재리뷰 범위와 diff 귀속

- 재리뷰 범위 = open 이슈 + 새 fix delta + delta가 건드린 기승인 영역. 이후 라운드는 1라운드보다 비용이 적어야 한다 — 새로운 전체 스캔은 계약 밖이다.
- **오케스트레이터가 fix delta를 독립적으로 캡처한다**(전체 워킹 트리, baseline → post). 각 캡처 윈도우의 writer는 하나다: 동시 생산자는 격리된 worktree가 필요하고, 공유 트리는 write-and-capture 윈도우를 직렬화한다. `outOfScope`가 비어 있지 않으면 → 생산자에게 귀속하지 말고, 멈추고 조율한다.
- 리뷰어를 상태 유지형으로 유지한다(`codex-reply` / 이전 ledger 경로); 루프 안에서 stateless 전체 리뷰를 재실행하지 않는다.

## 불변식

- 모든 수정은 리뷰된다; blocking 이슈가 하나라도 열려 있는 동안 작업은 완료가 아니다.
- 라운드마다 영수증을 보존한다: verdict, ledger, progress 근거, 수정 요약(그리고 contest 사이드카).
- `harnie:dev`에서 리뷰어는 절대 생산자의 제공자가 아니고, 절대 쓰지 않는다. 예외는 dev-solo다(위 "역할" 참고): 리뷰어가 서브에이전트가 아니라 fresh하고 컨텍스트가 격리된 서브프로세스라는 점만 다를 뿐, 쓰지 않는다는 제약은 어느 쪽이든 동일하다.
