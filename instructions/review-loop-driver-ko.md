# 리뷰 루프 구동 (canonical) — quick·plan 공통 CLI 배선

`loop.md`가 리뷰 루프의 **상태전이·출력 스키마·ledger 규칙·progress·재리뷰 범위**를 소유한다(먼저 읽는다). 이 파일은 그걸 **어떻게 결정적으로 돌리는가**(CLI·codex 호출)만 배선한다. ledger 병합·verdict 정합·상태 전이를 **손으로 하지 말 것** — false approval을 막는 결정적 코어는 `scripts/loop.mjs`가 소유한다.

**리뷰어 = producer의 반대 프로바이더 = Codex.** codex MCP 툴명은 설치 형태에 따라 `mcp__plugin_harnie_codex__codex`(플러그인) 또는 `mcp__codex__codex`(로컬 .mcp.json), 재리뷰는 `*__codex-reply`. `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`, `<dir>` = 트랙별 상태 디렉터리(`.harnie/quick/<slug>/` 또는 `.harnie/plan/<slug>/review/<unit>/`).

## R1. fix-delta 캡처 (orchestrator 독립 생성 — producer 자기보고 아님)
수정 **직전** baseline을 캡처해 두고, 수정 후:
```
node <ROOT>/scripts/loop.mjs delta <repo> <baselineSHA> --scope <touched,paths> --out <dir>/delta.patch
```
- 첫 리뷰: baseline = producer 착수 직전 캡처(전체 변경). 재리뷰: baseline = **이번 수정 직전** 캡처(증분만).
- 출력 JSON의 `outOfScope`가 비어있지 않으면 **외부/동시 변경** → producer 변경으로 귀속하지 말고 중단·조정(loop.md 귀속 불변). 병렬 작업은 비중첩 경로 또는 격리 worktree로 single-writer 보장.

## R2. 리뷰어 호출
- **첫 리뷰** = codex MCP `codex`. `sandbox:"read-only"`, `cwd:<repo>`, `model` high급, `developer-instructions` = 먼저 읽은 **loop.md 스키마 + 해당 리뷰 기준**(코드 = code-review.md·verification-tiers.md / 설계 = design-review.md, 아키·상세 고도는 호출자가 신호). `prompt` = 작업 의도 + 제약 + (plan이면)설계 + producer가 선언한 tier·검증 증거 + delta.patch 내용. 응답의 **threadId를 기록.**
- **재리뷰** = `codex-reply`(threadId 재사용, stateful). 새로 주는 것은 **증분 fix-delta + 검증에 필요한 주변 문맥**뿐. ⚠️ 반복 루프에서 stateless `codex review` 재실행 금지(누적 전체 재-read → 비용 폭증).

## R3. receipt 저장
codex 응답 원문을 `<dir>/round-N.txt`에 그대로 저장(감사·재현용).

## R4. ledger 병합 + 상태 판정 (결정적)
```
node <ROOT>/scripts/loop.mjs apply \
  --ledger <dir>/ledger.json --review <dir>/round-N.txt \
  --ns <CR|DR> --state <dir>/state.json [--progress auto|yes|no]
```
- `--ns`: 코드 리뷰 = `CR`, 설계 리뷰(아키·상세) = `DR`.
- `--progress`: 기본 `auto`(= gate progress ③, open blocking count 감소만 자동 progress). loop.md ①(새 증거)·②(산출물 개선) **정성 progress를 orchestrator가 인정하면 `--progress yes`** + 근거를 receipt에 기록. regression으로 판단하면 그대로 `auto`(no progress).
- 출력 해석:
  - `needsReRequest: true` → 파싱/verdict 불일치/blocking 누락. ledger·state 불변. **리뷰어에게 스키마·누락을 지적해 재요청**(codex-reply).
  - `machineState: APPROVED` → 이 리뷰 단위 통과.
  - `REVISING` → producer가 open 이슈 수정 → **R1로**(수정 직전 새 baseline 캡처부터).
  - `STALLED` → 정지. 증거·blocker·미검증 범위를 사용자에게 보고.
- `protocolViolations`(non-blocking 누락)는 진행은 가능하되 receipt에 기록.

## R5. (옵션) 최종 사인오프
규모가 있거나 사용자가 원하면, 마지막에 stateless `codex review --uncommitted`(git-aware) **1회**로 권위 리뷰. 반복 루프에는 쓰지 않는다.

> **불변**: 모든 수정은 반드시 리뷰된다. receipt(세션·verdict·ledger·progress 근거·수정 요약)를 남긴다. **open blocking 0이 아니면 done이 아니다.**
