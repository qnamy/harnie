# 리뷰 루프 구동 (canonical) — quick·plan 공통 CLI 배선

`loop.md`가 리뷰 루프의 **상태전이·출력 스키마·ledger 규칙·progress 규칙·재리뷰 범위**를 소유한다(먼저 읽는다). 이 파일은 그걸 **어떻게 결정적으로 돌리는가**(CLI·codex 배선)만 정의한다. ledger 병합·verdict 정합·상태 전이를 **손으로 하지 말 것** — false approval을 막는 결정적 코어는 `scripts/loop.mjs`가 소유한다.

**리뷰어 = producer의 반대 프로바이더**, 단계별로 고정(대칭 크로스-모델):
- **설계 루프:** producer = Claude(`harnie-designer`); 리뷰어 = **Codex**(codex MCP, `sandbox:"read-only"`).
- **코드 루프:** producer = **Codex**(codex MCP, `sandbox:"workspace-write"` — 빌더); 리뷰어 = **Claude**(read-only `harnie-reviewer` 서브에이전트 — 오케스트레이터 인라인 아님).

루프 코어(`loop.mjs`)는 프로바이더 무관이다: R1·R3~R5는 두 루프에서 동일하고, **R2(리뷰어 호출)**와 **producer의 수정**만 프로바이더별로 다르다. 설치 형태에 따라 codex MCP 툴명은 플러그인이면 `mcp__plugin_harnie_codex__codex`, 로컬 `.mcp.json`이면 `mcp__codex__codex`이며 재리뷰·재빌드는 대응하는 `*__codex-reply`를 쓴다. `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`. `<dir>` = 트랙별 상태 디렉터리 — 예: `.harnie/quick/<slug>/review/code/`, `.harnie/plan/<slug>/review/<unit>/`, 또는 dev-full 병렬 PHASE B에서 태스크의 머지 前 루프라면 그 태스크 자신의 격리 worktree에 뿌리를 둔 `.harnie/review/design/`·`.harnie/review/code/`.

**`<repo>`는 이번 호출의 루프가 관계하는 그 루트이지, 항상 활성 run의 루트인 것은 아니다.** quick·plan의 모든 호출은 단일 활성 run의 repo 루트를 쓴다. dev-full의 병렬 PHASE B가 유일한 예외다 — 태스크가 run 브랜치로 merge되기 前, 그 태스크의 머지 前 설계·코드 리뷰 루프는 `<repo>`를 그 태스크의 **격리된 git worktree**(`scripts/worktree.mjs`가 만든 별개의 repo 루트, run worktree 자신의 `.harnie/plan/<slug>/review/<unit>/`와는 별개)로 두고 돈다. 아래 R1~R5는 그 외엔 동일하며, `<repo>`에 대입되는 절대경로만 다르다. 언제 적용되는지는 `skills/dev-full/SKILL.md` PHASE B(B2′/B3′) 참조.

**producer의 수정(라운드 사이):** 설계 루프에서는 Claude designer가 개정한다. 코드 루프에서는 **Codex 빌더**가 `codex-reply`(stateful, `workspace-write`)로 쓰고 개정한다 — 승인된 설계(`<dir>`의 `design.md` 또는 plan의 `plan.md`)를 프롬프트로 받아 리뷰된 설계대로 짓는다. R1은 프로바이더와 무관하게 producer가 쓴 것을 그대로 캡처한다.

모든 codex/codex-reply MCP 호출은 `approval-policy:"never"`를 전제로 한다(서버 기동 오버라이드로 고정됨). 호출이 MCP idle timeout이나 `AbortError: remote-cancel`로 실패하면, 등록된 threadId로 `codex-reply`를 1회 재시도한다.

## R1. fix-delta 캡처 (오케스트레이터가 독립적으로 생성 — producer 자기보고 아님)
**R1은 코드 루프에만 적용된다.** **설계 루프**의 리뷰 대상은 `.harnie/` 아래 문서(`design.md`/`plan.md`)이고, `delta.mjs`는 이를 의도적으로 제외하므로 거기서의 git delta는 항상 비어 있다. 그래서 설계 루프는 R1의 git delta를 쓰지 **않는다**: 대신 **설계 내용을 리뷰어에게 직접 주입**한다(첫 리뷰는 전체 설계, 재리뷰는 개정된 설계 — 바뀐 섹션이든 전체든 — stateful 리뷰어에게). 나머지(R2~R5, ledger, state)는 동일하다.

코드 루프는 변경 **직전**에 baseline을 캡처하고, 변경 후 다음을 실행한다:
```
node <ROOT>/scripts/loop.mjs delta <repo> <baselineSHA> --scope <touched,paths> --out <dir>/delta.patch
```
- 첫 리뷰: producer 착수 직전에 baseline을 캡처 — delta에 producer 변경 전체가 담긴다. 재리뷰: **이번 수정 직전**에 새 baseline을 캡처 — delta에는 그 증분만 담긴다.
- 출력 JSON의 `outOfScope`가 비어있지 않으면 외부 또는 동시 변경이 발생한 것이다. producer 변경으로 귀속하지 말고, `loop.md`의 귀속 불변에 따라 중단·조정한다. delta는 **전체 tree를 비교**하므로 **진짜 동시 producer는 격리 worktree가 필요하고, 공유 worktree라면 각 producer의 write-and-capture 구간을 직렬화**해야 한다(비중첩 경로만으로는 오염을 막지 못한다).

## R2. 리뷰어 호출
기준은 프로바이더와 무관하게 동일하다(이미 읽은 `loop.md` 스키마 + 해당 리뷰 기준: 코드는 `code-review.md`·`verification-tiers.md`, 설계는 `design-review.md`를 호출자가 명시한 고도로). 메커니즘만 다르다.

**리뷰어가 Codex일 때(설계 루프):** 리뷰 대상이 설계 문서이므로 (R1에 따라) **git delta가 없다** — 설계 내용을 주입한다.
- **첫 리뷰:** codex MCP `codex` 툴을 `sandbox:"read-only"`, `cwd:<repo>`, 고성능 모델로 호출한다. `developer-instructions`에 기준을 싣는다. 프롬프트에는 작업 의도·제약·**전체 설계 내용**(`design.md`/`plan.md`의 해당 섹션)을 담는다. 응답의 **threadId를 기록**한다.
- **재리뷰:** 같은 threadId로 `codex-reply`를 호출한다. git delta가 아니라 **개정된 설계**(바뀐 섹션, 또는 최신 전체 설계)를 준다. 루프 안에서 stateless `codex review`를 반복 실행하지 않는다 — 매번 전체 컨텍스트를 다시 읽으면 비용이 무한정 늘어난다.

**리뷰어가 Claude일 때(코드 루프):**
- 리뷰어는 read-only **`harnie-reviewer` 서브에이전트**(tools = Read, Grep, Glob)다 — 오케스트레이터 인라인이 아니고, 변경을 만든 것과 같은 행위자도 아니다(여기서는 producer가 Codex이므로 Claude는 크로스-모델이다). Task로 위임한다. 프롬프트에 기준·fix-delta·검증에 필요한 주변 문맥을 주입하고, **정확히 `loop.md`의 VERDICT/ISSUES 스키마**로 응답하게 한다. 그 응답을 `<dir>/round-N.txt`에 쓴다 — Codex 리뷰어가 내는 것과 같은 스키마이므로 `apply`가 동일하게 파싱한다.
- 같은 방식으로 stateful하게 유지한다: 이전 ledger를 주입해 라운드 간 기존 발견사항을 보존하고, **증분 delta + 필요한 문맥만** 리뷰한다(전체 코드베이스 재스캔 금지).
- REJECT 편향을 적용한다. 리뷰어는 빌더의 프로바이더와 달라야 하며 read-only여야 한다(쓸 수 있는 코드 리뷰어는 리뷰어가 아니다).

어느 쪽이든, 리뷰는 R4 前에 canonical 스키마로 `<dir>/round-N.txt`에 쓰인다.

## R3. receipt 저장
리뷰어 원문(Codex 또는 Claude)을 그대로 `<dir>/round-N.txt`에 저장한다(감사·재현용).

## R4. ledger 병합 + 상태 결정적 판정
```
node <ROOT>/scripts/loop.mjs apply --root <repo> \
  --ledger <dir>/ledger.json --review <dir>/round-N.txt \
  --ns <CR|DR> --state <dir>/state.json [--artifact <postSHA>] [--limit 3] [--progress auto|yes|no] [--reentry <reason>]
```
- `--root <repo>`: **필수.** 활성 repo 루트. `loop.mjs`는 `--ledger`/`--state`가 `<repo>/.harnie` 안에 있는지 (canonical, symlink-resolved로) 검증하므로, 이 state CLI가 임의경로 쓰기 primitive로 변질되지 않는다. `<repo>`는 루프의 다른 곳에서 쓰는 것과 같은 절대경로다.
- `--ns`: 코드 리뷰 = `CR`, 아키텍처·상세설계 리뷰 = `DR`.
- `--artifact <postSHA>`: **코드 루프(`CR`)에는 필수**, 설계 루프(`DR`)에는 **금지**. 리뷰된 tree의 SHA — 이번 라운드 `delta` 출력(R1)의 `postSHA`를 넘긴다. `loop.mjs`는 manifest·scope에 무관하므로 state에 `reviewedPostSHA`만 기록하고, `execution.mjs`가 나중에 그 SHA에서 `manifest.scope` 기준 `reviewedScopeHash`를 재계산해 검증을 리뷰된 tree에 바인딩한다. plan 태스크에서 이걸 빠뜨리면 완료 재도출이 fail-closed(리뷰된 정본 없음)되므로 항상 넘긴다.
- `--state`: **필수**이며 같은 리뷰-유닛 `<dir>/` 안에 `--ledger`와 함께 위치한다. STALLED 래치는 영속 state에 의존하므로, 이를 생략하면 이전 STALLED가 round 0으로 취급되어 재진입을 우회할 수 있다 — 그래서 `apply`는 이것 없이는 fail-closed된다. state 파일이 **없는** 것은 정당한 초기 상태(round 0)다. **있는** 파일은 유효한 `machineState`를 가져야 하며, 그렇지 않으면 명령이 fail-closed된다(필드 누락은 새 시작이 아니라 훼손으로 본다). 진짜 ledger를 새 state 경로에 가리키는 것을 막기 위해, `apply`는 **ledger와 state의 존재 여부가 불일치**하거나(첫 apply는 둘 다 없어야, 진행 중인 루프는 둘 다 있어야) **서로 다른 부모 디렉터리**에 있을 때도 fail-closed된다. 남는 한 가지 경우 — `--ledger`와 `--state`를 둘 다 새 유닛에 가리키는 것 — 은 진짜 새 리뷰 유닛과 구분할 수 없으며 호출자의 불변식으로 남는다.
- `--limit`: 정체 한도(기본 3). 양의 정수가 아니면 fail-closed.
- `--progress`: 기본 `auto` — gate progress ③(open blocking 이슈 수 감소)만 자동 인정한다. 오케스트레이터가 정성 progress ①(새 증거) 또는 ②(측정 가능한 산출물 개선)를 인정하면 `--progress yes`를 넘기고 근거를 receipt에 기록한다. regression이면 그대로 `auto`(진행 없음으로 처리). (REVIEWING에만 적용되며, STALLED를 풀지 **않는다**.)
- `--reentry <reason>`: STALLED에서만 유효하다. `new-evidence`·`external-state`·`user-decision`·`scope-change` 중 정확히 하나(`scope-change`는 사용자 승인 후에만 주장). STALLED를 먼저 사용자에게 보고한 뒤 주장한다 — 사유는 state와 receipt에 기록된다. STALLED 밖에서 넘기면 fail-closed.
- 출력 해석:
  - `needsReRequest: true`: 파싱 실패, verdict 불일치, 또는 blocking 이슈 누락. ledger·state 불변. 리뷰어에게 스키마 오류·누락을 지적해 재요청(Codex는 `codex-reply`, Claude는 리뷰 재실행).
  - `needsReentry: true`: 이전 state가 STALLED이고 `--reentry`가 주어지지 않음. ledger·state **불변**, 리뷰 미적용 — **이번 라운드의 gate progress나 APPROVE조차 STALLED를 자동으로 풀지 않는다.** 사용자에게 보고 후 `--reentry <reason>`로 `apply`를 재실행.
  - `machineState: APPROVED`: 이 리뷰 유닛 통과.
  - `machineState: REVISING`: producer가 open 이슈를 고친 뒤 R2로 재리뷰. **코드 루프:** 먼저 R1로 돌아가 수정 前 새 baseline(git delta)을 캡처한다. **설계 루프:** R1이 없다 — designer가 설계를 개정해 개정 내용을 재주입한다(baseline·delta 없음).
  - `machineState: STALLED`: 정지하고 증거·blocker·미검증 범위를 사용자에게 보고한다. 명시적 `--reentry` 주장으로만 재개한다.
- 생략된 non-blocking 이슈에 대한 `protocolViolations` 항목은 진행을 막지는 않지만 receipt에 반드시 기록한다.

## R5. (옵션) 최종 사인오프
규모가 크거나 사용자가 요청하면, 신선하고 git-aware한 최종 사인오프를 **1회** 돈다 — 단 **producer와 크로스-모델을 유지**해야 한다. **코드 루프**(producer = Codex)에서는 사인오프가 uncommitted diff에 대한 **신선한 Claude 리뷰**(기준을 적용하는 read-only Claude 에이전트)다. `codex review --uncommitted`를 추가하는 것은 명시적인 **dual/auxiliary** 패스로서만 허용되며, 유일한 사인오프로는 안 된다. **설계 루프**(producer = Claude)에서는 신선한 Codex 리뷰가 크로스-모델 사인오프다. 반복 루프 안에서 stateless 사인오프를 쓰지 않는다.

> **불변:** 모든 수정은 반드시 리뷰된다. 세션·verdict·ledger·progress 근거·수정 요약을 담은 receipt를 남긴다. blocking 이슈가 하나라도 열려 있으면 작업은 끝난 게 아니다.
