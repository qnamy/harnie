# harnie 루프 상태머신 (canonical) — quick·plan 공통

리뷰 루프·정체 방지의 **단일 정의**이자 **출력 스키마의 소유자**. 두 트랙 스킬은 이 파일을 사용할 모델(오케스트레이터, 디자이너, 리뷰어)에게 **canonical path에서 직접 Read하도록 지시한다** — 위임 프롬프트에 내용을 붙여넣지 않고. 경로 참조만으로는 읽힘이 보장되지 않으므로, 각 소비자의 자체 진입점(agent body) 또는 Step 0(오케스트레이터)이 Read 지시를 담고, 소비자가 자신이 읽은 것을 행동 전에 명명한다. agent body = 1회 역할 불변규칙, 이 파일 = 다단계 조율.

## 역할 바인딩 (producer는 중립)
- **producer** = 산출물 저자(역할 중립). quick/plan 스킬이 단계별 바인딩:
  - 코드 리뷰 루프 → producer = **builder** / 설계 리뷰 루프 → producer = **designer**
- **reviewer** = producer의 **반대 프로바이더**(v0: Codex).

## 리뷰 출력 스키마 (canonical — 이 파일이 소유)
리뷰어는 **전역 VERDICT** + **이슈 목록**을 반환한다. 이슈가 없으면 `ISSUES: []`.
```
VERDICT: APPROVE | REJECT
ISSUES:
- [ID] (blocking|non-blocking) (open|resolved) [location] 무엇이 문제 → 왜 → 수정 방향
```
- **ID**: 라운드 간 동일 이슈는 동일 stable ID. namespace는 리뷰 종류별(각 criteria 파일이 명시).
- **location**: 리뷰 종류별 형식(각 criteria 파일이 명시).
- **status**: 이번 응답에서 확인한 open|resolved.
- **severity는 ID 수명 동안 고정한다.** `resolved`로 보고할 때도 **원래 심각도로 emit**한다 — 같은 ID의 `blocking` ↔ `non-blocking` 전환은 병합에서 거부된다. 심각도 판단 자체가 바뀌었으면 그 ID를 `resolved`로 닫고 **새 ID를 새 심각도로** 연다.
- code/design-review는 이 스키마를 복제하지 않고 ID namespace·location 형식만 둔다.

## Aggregate issue ledger (승인 게이트의 근거)
승인은 단일 응답이 아니라 **누적 receipt의 issue ledger**로 계산한다. ledger는 **orchestrator(스킬)가 소유**한다.
- receipt = stable ID를 key로 하는 aggregate ledger.
- 재리뷰어는 재리뷰 대상인 **모든 기존 open 이슈**에 open|resolved를 명시해야 한다.
- **누락 처리 정책**: 응답에서 빠진 open 이슈는 **방어적으로 open 유지**(누락 ≠ resolved). 누락 자체는 **protocol violation**으로 receipt에 기록한다.
  - 누락된 것이 **blocking이거나** verdict 정합성이 깨지면 → **재요청**.
  - 누락된 것이 **non-blocking뿐**이면 → ledger 유지한 채 진행 가능.
- 새 이슈는 새 stable ID로 추가.
- orchestrator가 응답을 ledger에 적용한 뒤 **open blocking 수로 verdict를 검증**한다.
- **정합성 불변**(어기면 응답 무효 → 재요청): `APPROVE ↔ open blocking = 0` / `REJECT ↔ open blocking ≥ 1`.
- **resolved 정의**: 현재 범위·결정 아래 더 이상 blocking/non-blocking 위험이 성립하지 않음을 **검증한** 상태. 누락·producer 완료주장 ≠ resolved. 이후 delta로 재발하면 **같은 ID를 open으로 되돌린다.**

## 상태 전이
**progress는 리뷰 결과가 나온 뒤(REVIEWING)에만 판정**한다. **모든 수정은 반드시 리뷰된다.** 가드는 배타적이며 stagnation은 **증가 후 값**으로 비교한다(limit 기본 3).
```
REVIEWING ─APPROVE→ APPROVED
REVIEWING ─REJECT (첫 리뷰)→ REVISING
REVISING  ─fix-delta 제출→ REVIEWING
REVIEWING ─REJECT + progress→ REVISING (stagnation = 0)
REVIEWING ─REJECT + no progress + (stagnation+1 < limit)→ REVISING (stagnation += 1)
REVIEWING ─REJECT + no progress + (stagnation+1 ≥ limit)→ STALLED (stagnation += 1)
STALLED   ─유효 재진입→ REVISING (stagnation = 0)
```
- **round** = 한 번의 수정 + 그 결과 리뷰. **stagnation** = 연속 무진행 라운드 수(reset = progress 또는 유효 재진입).
- **progress =** 셋 중 하나, **orchestrator가 인정 기준+근거를 receipt에 기록**:
  - ① **새 증거** — 원인 범위를 줄이거나 다음 결정을 바꾸는(몰랐던 위험을 좁힌 경우 포함).
  - ② **산출물 개선** — 수용 기준 또는 실패 게이트에 측정 가능한 개선.
  - ③ **검증 게이트 전진** — ledger 적용 후 **open blocking count가 이전보다 작아짐**(count 기반 — 파서가 계산; 스키마에 severity 없음). **blocker를 닫으며 새 blocker를 만들어 count가 그대로면 gate progress 아님(whack-a-mole).** 단 새 blocker가 regression이 아니라 몰랐던 위험을 좁힌 것이면 ①(새 증거)로 정성 판단해 인정 가능.
  - **progress 아님**: 단순 코드변경·로그추가·접근변경 자체·같은 결과 재실행·blocker whack-a-mole 맞바꾸기(count 불변).
- **STALLED**: 증거+blocker+미검증 범위 남기고 정지, 사용자 보고.
- **유효 재진입**(넷 중 하나): 새 증거·외부 상태 변화·필요한 사용자 결정·범위 변경(사용자 승인된 것만).

## 재리뷰 범위 · diff 귀속 · read 규율
- **재리뷰 대상 = open 이슈 + 새 fix-delta + 새 delta가 건드린 기존 승인 영역.**
- **fix-delta는 orchestrator가 독립 생성**(producer 자기보고 아님): 수정 직전 기준점→직후 실제 증분. 신규 untracked·삭제·rename·binary 포함.
- **귀속 불변**: fix-delta 캡처 구간은 scoped path에 대해 **single-writer**여야 한다. 동시 변경이 가능하면 격리한다(파일 소유권 분리 / worktree). **외부·동시 변경을 감지하면 producer 변경으로 귀속하지 않고 중단하여 조정**한다. (plan 병렬 작업 = 비중첩 경로 보장 또는 격리 worktree.)
- 리뷰어는 stateful(codex-reply/claude resume)로 원본 컨텍스트 유지, 새로 주는 것은 증분 fix-diff + 검증에 필요한 주변 문맥뿐.
- **"재-read 금지" = 전체 코드베이스 재탐색 금지.** 변경 diff와 필요한 주변 문맥은 반드시 다시 읽는다.
- ⚠️ 반복 루프에서 stateless `codex review` 재실행 금지(누적 전체 재-read → 비용 폭증). stateless는 최종 사인오프 1회만.

## 예시 — ledger 2 라운드
초기 리뷰:
```
VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (open) [auth.ts:42] 토큰 만료 미검증 → 만료 경로 반환 없음 → 만료 체크 추가
- [CR-002] (non-blocking) (open) [auth.ts:60] 만료 실패와 refresh 실패가 같은 운영 메트릭으로 집계 → 장애 원인 분리 어려움 → 기존 메트릭 차원 있으면 구분 검토
```
ledger: `{CR-001: open/blocking, CR-002: open/non-blocking}`. open blocking=1 → REJECT ✓

수정 후 재리뷰(CR-001만 고침):
```
VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (resolved) [auth.ts:42] 만료 체크 반영됨
- [CR-003] (blocking) (open) [auth.ts:45] 만료 체크가 refresh 토큰엔 미적용
```
orchestrator ledger 적용: CR-001→resolved, **CR-002 응답에 없음 → 누락 = protocol violation으로 기록하되 non-blocking이므로 open 유지·진행 가능**, CR-003 신규 open/blocking. → open blocking `{CR-003}` = 1. **1→1(count 불변)이라 ③ gate progress 아님.** orchestrator 판정: CR-003이 CR-001 수정이 만든 **regression이면 no progress**(stagnation+1); "refresh 경로"가 원래 있던 미지의 위험을 좁힌 **새 증거면 ①로 progress**(stagnation reset) — **어느 쪽인지 근거와 함께 receipt에 기록.**

## 불변
- 리뷰 receipt(세션·verdict·ledger·progress 판정 근거·수정 요약) 기록. **open blocking 0이 아니면 "done"이 아니다.**
- 리뷰어 = producer의 반대 프로바이더(크로스-모델 맹점).
