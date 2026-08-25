---
name: dev-solo
description: Codex 단독 개발 파이프라인 — Codex에서의 모든 코드 변경 요청(신규 기능, 버그 수정, 리팩터링, 마이그레이션)에 사용한다. harnie:dev와 동일한 harnie 파이프라인과 하드 규칙을 Claude 서브에이전트 없이 실행한다: Codex가 생산하고, claude CLI로 Claude가 리뷰하며(자기 리뷰 폴백), 권한은 오직 harnie CLI를 통해서만.
---

# dev-solo — harnie 파이프라인, Codex 단독

당신은 harnie의 단일 파이프라인을 **Claude 서브에이전트나 훅 없이** 실행하는 Codex다. `harnie:dev`와 같은 단계, 같은 하드 규칙; 배선만 다르다. `<SNAP>` = 이 플러그인의 설치 루트(마켓플레이스 스냅샷 — 이 파일 자신의 위치에서 1회 해석한다). 모든 상태 CLI는 `node <SNAP>/scripts/execution.mjs|loop.mjs …`다.

## 배선 차이 (그 외 전부는 harnie:dev 계약을 따른다 — 지금 `<SNAP>/skills/dev/SKILL.md`를 Read하고, L이면 `<SNAP>/skills/dev/stages/large.md`도)

- **초기화 (부트스트랩 훅 없음)**: `execution.mjs init --root <repo> --slug <slug> --authority cli` — run worktree/브랜치(또는 워크스페이스 run-state 디렉터리)를 생성하고 **workroot**를 출력한다; 어디서나 그것을 사용한다. 이어서 잠정 규모/난이도를 판정하고 `set-mode`로 확정한다.
- **승인 (M/L)**: `plan.md`를 대화로 사용자에게 제시한다; 명시적 승인 후 `execution.mjs approve --root <workroot> --slug <slug> --plan-hash <hash>`를 실행한다(cli-authority run에서만 유효; 해시 불일치는 실패). approve 호출, 해시, 시각이 감사 기록이다.
- **프로듀서 = 당신.** 설계와 코드를 직접 작성한다(빌더 위임 없음). 빌더 계약이 금지하는 모든 것이 여전히 당신을 구속한다: 스코프 테스트만, 요청되지 않은 작업 금지, 증거 기반 완료(`<SNAP>/instructions/builder-contract.md`).
- **리뷰어 = 새 서브프로세스, 크로스-모델 우선**:
  - `command -v claude`가 성공하면: `node <SNAP>/scripts/run-capped.mjs <timeout-ms> claude -p "<review prompt>" --model <tier> --allowedTools Read Grep Glob` — tier는 `model-matrix.md`의 **dev-solo 역전** 기준: 설계 리뷰(모든 고도) = opus, 코드 리뷰 = 코드-리뷰어 행. 프롬프트는 기준 파일 경로(`<SNAP>/instructions/code-review.md` 또는 고도를 명시한 `design-review.md`, `verification-tiers.md`, `review-schema.md`), delta.patch/설계 경로, 이전 원장 경로를 명시하고, review-schema의 정확한 출력을 요구한다.
  - 폴백(claude 부재, 또는 호출 실패/타임아웃): `node <SNAP>/scripts/run-capped.mjs <timeout-ms> codex exec --sandbox read-only -m gpt-5.6-sol "<same review prompt>"` — 새 프로세스는 당신의 컨텍스트를 전혀 공유하지 않는다. 다른 폴백은 없다; 이마저 실패하면 멈추고 보고한다.
  - 어느 쪽이든: stdout을 `<dir>/round-N.txt`로 저장한 뒤 `review-loop-driver.md` R4에 정확히 따라 `loop.mjs apply …`한다(CR 아티팩트는 `loop.mjs capture/delta`에서; DR 아티팩트는 `dr:` 해시로). 스키마 무효 응답(`needsReRequest`)은 1회 재요청한다; 그래도 무효면 **멈추고 프로토콜 실패를 사용자에게 보고한다** — `apply`는 무효 라운드에 어떤 상태도 기록하지 않으므로 이는 STALLED 래치가 아니며 `--reentry`는 적용되지 않는다.
- **검증/완료**: `verify --task`, `verify --integration`, `completion`은 harnie:dev와 동일; `HARNIE_STATUS` 푸터의 유일한 출처는 `completion`이다. 당신이 프로듀서더라도 각 프로듀서 윈도 전후에 `seal`/`seal-verify`를 실행한다 — 우발적 권한 파일 편집을 잡아낸다.
- **L run**: 러너 서브에이전트 없음 — **설계로 결정된 solo 편차**다(design-0.11-detail.md §9, rev-6): 태스크를 직접 **순차** 실행하되, 각 태스크를 자기 worktree에서(러너의 1단계처럼 태스크별로 생성) 러너 프로토콜의 태스크별 시퀀스와 게이트를 따른다 — 증분 그라운딩 → TASK-DETAIL 설계 + 설계 리뷰 → 스코프 빌드 → 코드 리뷰 → 스코프 커밋 — 단 **solo 배선으로 치환한다**: Codex MCP 위임 대신 직접 빌드하고, 리뷰는 위의 새-서브프로세스 경로를 거치며, 브리프 대신 CONTRACT 섹션을 직접 읽는다(보호할 컨텍스트 격리가 없다) — 그에 따라 당신의 TASK-DETAIL `dr:` edition 토큰은 `solo:contract-rev-N`이다(드라이버 R4). 그래서 계약 리비전이나 승인된 errata는 재개 시에도 낡은 설계 승인을 여전히 무효화한다. 러너의 재개 테이블과 `contract-conflict` 정지 규칙이 적용된다; 당신이 메인이기도 하므로 충돌은 errata 경로로 직접 처리한다. solo 모드에서는 병렬 격리가 불가능함을 플랜에 기록한다.

## NEVER (harnie:dev 목록에 더하여)

- 자신의 판단으로 승인하거나, 리뷰 ID를 닫거나, HARNIE_STATUS를 내보내지 않는다 — 오직 CLI만.
- 이 대화의 컨텍스트에서 자신의 작업을 리뷰하지 않는다 — 리뷰어는 항상 새 서브프로세스다.
- 리뷰 경로에 MCP 서버를 등록하거나 의존하지 않는다; 위 두 서브프로세스 경로가 계약의 전부다.
