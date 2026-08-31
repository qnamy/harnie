# Enforcement Map — 지침 문장 ↔ 기계 강제 대응표

지침의 각 규범 문장을 **어느 훅/CLI가 실제로 강제하는지** 기록한다. 용도는 문서 경량화의 안전장치다 — "강제됨" 문장은 지침에서 계약 한 줄로 압축할 수 있고, "문서만" 문장은 사고 유래 불변식 여부를 확인하기 전에는 삭제하지 않는다. (엔진 = `scripts/*.mjs` + `hooks/*.mjs`)

> **0.13 갱신(2026-08-27)**: L 파이프라인 삭제와 함께 errata v2·workspace 모드·`worktree.mjs merge/archive`·태스크별 worktree 매핑·`harness-digest`가 제거됐다. 아래 표에서 그 행들은 삭제했고, 나머지 강제 주체는 그대로다.

| 지침 문장(요지) | 위치 | 강제 주체 | 비고 |
|---|---|---|---|
| 승인 전 소스 쓰기 금지 | SKILL §Execution State | PreToolUse `decideWriteEdit`/`decideBash`/`decideCodex`(planning phase) | 불변식 ① — 문장 유지 |
| 미완료를 done으로 확정 금지 | phase-b B6 | Stop 훅 = `computeCompletion` 재도출 | 불변식 ② — 문장 유지 |
| A5 승인은 실제 AskUserQuestion에만 바인딩 | phase-a A5.1 | `arm-approval` + Pre/PostToolUse one-shot 바인딩 | 자기승인 차단 |
| 리뷰어는 파일을 쓰지 않는다 | `loop.md` 불변식 | `harnie:dev`: Claude 리뷰어는 `harnie-reviewer`의 `tools: Read, Grep, Glob` — 쓰기 도구 부재(하네스 강제). Codex 설계 리뷰어는 `sandbox:"read-only"`(OS 강제). **dev-solo: 없음** | **advisory(0.14.5).** 네이티브 서브에이전트는 부모 샌드박스를 상속하고 spawn 시 sandbox 인자가 없어, 리뷰어가 쓰기로 결정하면 쓸 수 있다 — 실측 확인됨. 프롬프트의 지시와 프로토콜 위반 보고가 전부다 |
| 사람 확인 바인딩이 있는 런타임에서 `approve` Bash 호출 금지 | DEC-2 | `decideBash`의 `approve` deny(`hookBoundApproval`) | **강제 — 오케스트레이터 Bash 한정.** harnie 훅은 Claude·Codex 양쪽에서 돈다(0.14.4 정정). Codex에는 AskUserQuestion 바인딩이 없어 deny하지 않는다 — 막으면 dev-solo가 M을 승인할 수 없다. 그 구간은 dev-solo 계약의 규율이 메운다. 훅이 미설치·비활성인 세션과 workspace-write codex 서브프로세스 안의 셸에는 적용되지 않음 |
| manifest는 planHash 봉인, A5.2로만 개정 | phase-a A5.2 | `bindApproval` 아카이브+교체, 직접 쓰기 훅 차단 | |
| scope 배타 검증 | phase-b B1 | `validateManifest`@arm-approval | B1은 재검사 안 함(문서 그대로) |
| `.harnie` 셸 접근 금지(읽기 포함) | SKILL §Execution State | Bash 가드(blanket — 명령 텍스트의 `.harnie` 참조 전부) | export/Read가 공인 경로 |
| control 파일 직접 Write/Edit 금지 | SKILL §Execution State | `decideWriteEdit`(control basenames: manifest·execution·ledger·state·receipt 등) | **비-control 아티팩트(round-N.txt 등)는 직접 Write 허용** — 문서 계약만 |
| 빌더 threadId 귀속 | phase-b | PostToolUse `registerBuilderAuto`(run root cwd + 마커/serial 예외) | 0.13: 태스크별 worktree 매핑 삭제 |
| run-root 부트스트랩은 마커로만 | phase-b-parallel §correction | `registerBuilderAuto` + `rebind-task` 마커 | 추측 바인딩 fail-closed |
| watchdog 예산·auto-cap 1회(2×) | phase-b watchdog contract | `taskWatchdogUsage`/`decideWatchdog` + `watchdogExtend` 캡 | 캡 초과는 사용자 게이트(문서) |
| 리뷰 상태 fail-closed(ledger·state 정합) | loop.md / driver R4 | `loop.mjs apply` | 문서의 상태머신 서술은 loop.md에만 |
| verify 리시트·vacuous 검출 | phase-a A5.0 / phase-b B4 | `execution.mjs verify` | A5.0의 "왜"는 문서만(사고 유래) — 유지 |
| capture baseline 영속화 | driver R1 | `loop.mjs capture --record`(이원 컨테인먼트) | v0.10.0 |
| 세션 분할 권고 | SKILL §Context Budget | `loop.mjs apply`의 `sessionSplitRecommended` | 제안은 문서, 신호는 기계 |

**문서만 있는 규범(강제 없음, 사고 유래 — 삭제 금지 목록):** blob 경로 위임 금지(위임 참조 규칙), 브리프 원문 발췌(요약 금지), 빌더 응답에 소스 금지, 리뷰어 재리뷰 비용 계약, 직렬 경로 선택 근거 기록(B1), D8 재시도 캡(2연속 idle timeout = 인프라 분류), granularity 규칙(A4). 이들은 실측 run의 실패 관측에서 나온 행동 계약이라 엔진 강제 대상이 아니거나(판단 필요) 아직 승격 트리거 미충족이다 — 반복 위반이 관측되면 승격 후보가 된다(`quality-digest`).
