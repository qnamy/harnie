# 설계 작성 프로필 — CONTRACT 고도 (canonical, 주입용)

L run의 **CONTRACT 문서** 출력 계약: (선택적) 아키텍처 설계와 태스크별 상세 설계 사이의 태스크 간 경계 레이어. 오케스트레이터가 이 파일의 절대 경로를 전달하고, designer는 쓰기 전에 이를 Read한다. 이 문서는 **승인 게이트 산출물의 핵심**이다 — 태스크 범위와 검증이 여기서 증거 위에 확정된다.

**고도**: 태스크 경계를 넘는 것만. 태스크 내부 로직·클래스·SQL은 TASK-DETAIL 소관이다(각 러너가 나중에 작성); 포함하지 않는다.

## 섹션 (단일 경량 모드)

1. **핵심 결정** — 태스크 경계에 관한 3~5개 결정과 근거.
2. **태스크 분해 표** — 태스크별: id / 한 줄 목적 / **독립-리뷰-가치 근거(필수 — 필요조건: 그 변경 자체의 크기·위험이 리뷰 유닛 하나의 고정 비용을 정당화한다; deps와 병렬성은 부차적 근거일 뿐; 예상 diff <100줄 또는 1~2개 파일이면 가장 관련 깊은 태스크로 병합이 기본)** / scope 경로 / deps / scope-test 세트 / 사람 검증 항목(없으면 "none"을 명시).
3. **태스크 간 계약** — 태스크 사이의 인터페이스·데이터·이벤트만. 기계 판독 스키마는 파일과 ID로 참조; 필드를 절대 옮겨 적지 않는다.
4. **태스크별 Environment Fact Sheet** — 승인 전 태스크 스코프 grounding 산출물; 모든 사실은 출처 경로를 인용한다. 카테고리: 코드 경로, 기존 테스트, 런타임/드라이버·세션 시맨틱(예: batch-scoped SET 옵션, datetime 절삭, rowcount 신뢰성), 스키마 상태.
5. **검증 전략** — 두 컬럼: 자동(태스크별 scope 테스트; 전체 스위트는 run 레벨 `integrationVerification`) / 사람(항목, 확인 방법, 위험 — 완료 시 체크리스트로 인계).
6. **비목표** — 최소 한 줄.

작은 분해라면 가차 없이 압축한다; 장황한 섹션을 강제하지 않는다. FR/NFR 식별자는 선택 — 추적성이 진정 도움이 되는 곳에서만 쓴다.

## 매니페스트 블록

플랜 문서는 ` ```harnie-manifest ` 블록을 담는다: `{difficulty?, tasks:[{id, deps, reviewUnit, scope, setup?, verification}], gates:[{name:"final-review", reviewUnit:"final-review"}], integrationVerification:[…]}` (모드 M: `gates: []`, 단일 태스크). `integrationVerification`은 M/L에 필수; workspace run에서는 모든 항목이 등록된 `repo` 키를 갖는다; reviewUnit `integration`은 예약어다.
