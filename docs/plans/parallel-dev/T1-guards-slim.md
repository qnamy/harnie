# T1 — 가드·상태 슬림화 (R4: 과설계 정리, resume/stop 재점검)

> 이 프롬프트는 자기완결이다. 새 Claude Code 세션(cwd = harnie repo 루트)에 그대로 붙여 실행한다.

## 컨텍스트

- repo: `~/Tradlinx/harnie` (플러그인 harnie — AI 서브에이전트 개발 하네스). `main` 최신에서 브랜치 `claude/harnie-T1-guards-slim` 생성 후 작업.
- 위협모델(docs/execution-state.md §0.1): **"실수하는(fallible·over-eager) 오케스트레이터/빌더의 실수 방지"가 목적이고, 세션을 통제하는 적대적 main은 명시적 비목표**다. 현재 가드는 Codex 코드리뷰 12라운드를 거치며 적대적-시나리오 방어 계층이 누적돼 이 위협모델을 초과한다.
- 사용자 결정: **공격적 정리** — 아래 "유지 4계층"만 남기고 방어 계층을 제거한다.

## 목표

강제 계층(`scripts/guards.mjs` + `hooks/*.mjs` + `scripts/execution.mjs`의 상태기계 + `scripts/loop.mjs` 검증)을 위협모델에 맞게 축소한다. 목표 LOC 감소 ≥40%. 전체 테스트 그린 유지.

## 유지해야 할 핵심 4계층 (회귀 테스트 반드시 보존·보강)

1. **승인 前 소스 쓰기 차단**: phase가 `planning`/`awaiting-approval`인 동안 Write/Edit는 `.harnie/<track>/<slug>/` 밖 쓰기 차단. codex 호출은 승인 前 read-only만, 승인 후 빌더는 `workspace-write` + cwd=활성 repo 검사.
2. **`.harnie` 권위파일 보호**: Write/Edit/Bash의 `.harnie` 권위파일(active.json·manifest.json·execution.json·ledger·state·receipt) 직접 변조 차단. 경로 검사는 **realpath 1회 canonical containment(repo 밖 탈출 차단)까지만**.
3. **Stop 완료 재도출**: 승인된 active run이면 manifest+리뷰 ledger/state+receipt+planHash로 완료를 독립 재도출, 미완료면 block. honest-`HARNIE_STATUS: INCOMPLETE` 재진입 규칙 유지.
4. **승인 게이트**: AskUserQuestion PostToolUse 관찰로 승인 판정. **단순화**: `arm-approval` 후 "첫 번째로 관찰된 승인 응답"을 일회성 소비. 질문 텍스트/옵션 정확 대조(`--question` 필수 바인딩)는 제거.

## 제거 대상 (각 항목 제거 시 관련 테스트·문서 언급도 함께 정리)

- `guards.mjs`의 **셸 lexer 기반 read-only Bash 판정 전체**(개행·프로세스치환·리다이렉트·glob/brace 분석, 쓰기옵션 denylist, read-only allowlist). Bash 가드는 "`.harnie` 접근은 sanctioned CLI 외 차단" 한 가지로 축소. 승인 前 Bash-우회 소스 쓰기의 백스톱은 seal/delta와 Stop 재도출이 담당한다.
- **인터프리터/경로 pinning**: 신뢰 절대경로 정확일치, bare `node` 검사, 중복 플래그 거부, case-insensitive `.harnie` 매칭. sanctioned 판정은 "플러그인 루트 하위 `scripts/{loop,execution}.mjs`" 단순 경로 매칭으로.
- **sanctioned CLI argv의 active-context 정밀 바인딩**(slug/track/positional repo 정확일치 계층). `--root`가 활성 repo인지 정도만 유지.
- **승인 질문 정확바인딩**(위 4번 참조).
- **lock 토큰 기계**(소유권 토큰·수동 회수 프로토콜) → `O_EXCL` lockfile 1개로 단순화. stale이면 에러 메시지로 수동 삭제 안내.
- **park / resume(park 복귀) / route-abandon 서브커맨드 제거**. "다른 작업 하러 비켜두기"는 후속 T2의 worktree-per-run이 대체한다(active run이 미완료인데 새 작업 요청이면 fail-closed + "새 worktree run 사용" 안내 메시지만).
- **pending-route의 `failed` latch**: 부트스트랩 실패 시 route 파일을 삭제하고 에러를 내는 것으로 단순화(`pending` 게이트 자체는 유지 — /harnie:dev 라우팅 강제는 adherence 해결의 핵심이므로 삭제 금지).
- **owner-session monotonic set 특수 로직**: 단순 owner 배열(존재하면 adopt 시 추가)로.
- `loop.mjs`: 중복플래그 거부·case-insensitive 방어 제거. **유지**: `.harnie` containment, review-unit colocation(ledger/state/round 동일 dir), ledger XOR 존재 검사, verdict/ledger 파싱 검증, CR `--artifact` 현재-트리 일치, STALLED 래치+`--reentry`(정체 루프 방지는 실수-방지 목적이므로 유지).
- `trial` 서브커맨드(macOS sandbox canary)류: 실수 방지에 직접 기여하지 않으면 제거하고 approve 전제조건도 함께 갱신. 판단 근거를 보고서에 남길 것.

## 주의

- **resume 자체는 유지**: `active.json` 존재 + track/base 일치 → adopt. (재점검 대상은 park·latch·owner-set 복잡도다.)
- 스킬/커맨드 문서(`skills/`, `commands/`)는 **건드리지 않는다**(T3 소유). 제거된 기능(park 등)을 언급하는 스킬 문서 위치만 보고서에 목록으로 남겨 통합 세션에 전달.
- `instructions/loop.md`·`instructions/loop-ko.md`는 이 태스크 소유 — loop 계약 변경분 동기화(영문 정본 + ko 미러 동시 갱신).
- 훅 fail-closed 원칙(예외 시 PreToolUse deny·Stop block)은 유지.

## 진행 방식·모델 배선

- 조사·파일 요약 등 읽기 작업: **codex MCP read-only, model `gpt-5.6-luna`** (불가 시 Haiku 서브에이전트).
- 구현: **codex MCP, model `gpt-5.6-sol`, sandbox `workspace-write`, cwd=repo 루트**에 위임. 오케스트레이터(이 세션)는 직접 코드를 짜지 않고 지시·검증한다.
- 코드리뷰: **Opus 5 read-only 서브에이전트**(REJECT-bias, `instructions/code-review.md` 기준). **이 태스크는 삭제가 많아 위험하므로 리뷰 effort 최고 수준으로, "제거된 계층이 막던 실수 시나리오 중 유지 4계층이 못 막는 것"을 명시적으로 탐색**시킨다. REJECT면 codex-reply로 수정 루프.

## 완료 기준

1. `node --test scripts/*.test.mjs hooks/*.test.mjs` 전체 그린(제거 계층 테스트는 삭제, 유지 4계층 테스트는 보존·보강).
2. 강제 계층 LOC ≥40% 감소(before/after 수치 보고).
3. Opus 5 리뷰 APPROVE.
4. 커밋 완료(작업 단위 커밋, push는 사용자 확인 후). 보고서: 제거 목록/유지 목록/테스트 증감/스킬 문서 잔여 언급 위치.

## 원칙 (전 태스크 공통)

- 요청 범위만 정확히(surgical). 새 기능·추측성 유연성 금지. 인접 코드 개선 금지.
- 크리티컬 버그 방지 우선: 유지 4계층의 동작 변화가 의심되면 테스트로 고정 후 진행.
