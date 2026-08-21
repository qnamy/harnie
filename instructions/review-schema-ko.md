# 리뷰 출력 스키마 (정본 텍스트)

이 파일은 리뷰 출력 계약의 **스키마 텍스트**다. 리뷰어가 매 기동마다 루프 상태기계 전체(오케스트레이터가 `scripts/loop.mjs`로 집행하는 부분) 대신 딱 이것만 읽을 수 있도록 `loop.md`에서 추출했다. `loop.md`는 여전히 루프 계약(ledger 규칙, 상태 전이, progress, 재리뷰 범위)의 정본이며, 스키마는 이 파일을 가리킨다.

리뷰어는 **전역 VERDICT** 하나와 **이슈 목록**을 반환한다. 이슈가 없으면 `ISSUES: []`를 반환한다.

```
VERDICT: APPROVE | REJECT
ISSUES:
- [ID] (blocking|non-blocking) (open|resolved) [location] 무엇이 잘못 → 왜 중요 → 수정 방향
```

- **ID:** 같은 이슈는 라운드가 바뀌어도 같은 안정 ID를 재사용한다. 네임스페이스는 각 리뷰 기준 파일이 정의한다(코드 리뷰 `CR`, 설계 리뷰 `DR`).
- **위치:** 위치 형식은 각 리뷰 기준 파일이 정의한다.
- **상태:** 이번 응답에서 **검증한 대로** `open` 또는 `resolved`를 보고한다.
- **심각도는 ID 수명 동안 고정된다.** `resolved`로 보고할 때도 원래 심각도를 그대로 낸다 — `blocking`↔`non-blocking`이 바뀐 ID는 머지에서 거부된다. 심각도 판단 자체가 바뀌었다면 그 ID를 `resolved`로 닫고 새 심각도로 새 ID를 연다.
- **일관성 불변식:** `APPROVE ↔ open blocking = 0`; `REJECT ↔ open blocking ≥ 1`. 파서가 강제한다 — 불일치 응답은 무효가 되어 라운드를 낭비한다.
- `code-review.md`·`design-review.md`는 이 스키마를 중복하지 않는다 — 각자의 ID 네임스페이스와 위치 형식만 정의한다.
