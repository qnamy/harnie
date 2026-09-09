# 설계 산출물·설계 리뷰 계약의 근거

> 조사일 2026-09-03(§1~8) · 2026-09-04(§9~14). `skills/software-design/SKILL.md`와 `skills/software-design-review/SKILL.md`의 계약이 왜 그 모양인지의 출처다. 계약 자체는 각 스킬 본문이 정본이다.

## 1. 고도 축을 버린 이유

spec-driven 도구 세 개 모두 설계 산출물을 **하나**로 두고 깊이만 조절한다. 아키텍처 고도와 상세 고도를 별도 프로파일로 가르는 구조를 쓰는 곳이 없다.

| 도구 | 설계 산출물 절 |
|---|---|
| AWS Kiro `design.md` | Overview / Architecture / Components and Interfaces / Data Models / Error Handling / Testing Strategy |
| GitHub Spec Kit `plan.md` | Summary / Technical Context / Constitution Check / Project Structure / Complexity Tracking (상세는 `research.md`·`data-model.md`·`contracts/`로 분산) |
| BMAD-METHOD v6 spine | Design Paradigm / Inherited Invariants / Invariants & Rules / Consistency Conventions / Stack / Structural Seed / Capability → Architecture Map / Deferred |

harnie의 ARCH / TASK-DETAIL 분리는 파이프라인이 ARCH 승인과 태스크 단위를 따로 세워야 했던 사정에서 나온 것이고, 개인 프로세스(요구사항 → 설계 → 설계리뷰 → 개발)에는 그 사정이 없다.

세 도구 모두 **요구사항 → 설계 → 태스크를 문서 존재 의존으로 강제**한다. Kiro는 명시적이다. *"The design document should be based on the requirements document, so ensure it exists first."*

## 2. 독자가 둘이라는 것 — 결정부/근거부 분리

가장 값나가는 발견은 BMAD의 분리다. 설계 문서를 **build substrate**로 규정한다.

> "Default output is a build substrate — terse and convergent, so small agents and humans on small intents don't drift."
> "Decisions, not rationale (rationale lives in the memlog)... never emit a comment in the finished spine."

BMAD는 근거를 별도 `.memlog.md`로 뺀다. 반대로 사람 설계 리뷰는 근거 없이 판단할 수 없다. Google 설계문서 실무(Malte Ubl)가 대안 비교 절을 이렇게 평가한다.

> "[Alternatives considered] is one of the most important [sections] as it shows very explicitly why the selected solution is the best... This section will make or break your design doc."

파일 둘로 쪼개면 의식이 늘어난다. 한 파일 안에서 **순서로 분리**하고 구현자에게 근거부를 읽지 말라고 명시하는 쪽을 택했다. Lost in the Middle(arXiv 2307.03172, TACL)이 중간 배치 시 30% 이상 저하를 보고하므로 임계 내용의 앞·뒤 배치와도 맞는다.

## 3. 검증 절을 필수로 둔 이유

Anthropic 공식 베스트프랙티스 문구가 그대로 근거다.

> "The most useful specs are self-contained: they name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step that proves the feature works."
> "Without a check it can run, 'looks done' is the only signal available."

arXiv 2603.24631 "Coherence Collapse"가 같은 실패에 이름을 붙였다. 코드는 맞는데 변경이 문제를 실제로 푸는지 아무도 검증하지 않아 자신 있게 완료로 끝나는 것. 여러 출처가 공통으로 지목한 최다 실패 모드가 **silent drift / false-done**이다.

## 4. 태스크 분해를 이 스킬이 만들지 않는 이유

Kiro·Spec Kit은 `tasks.md`를 따로 둔다. 그러나 arXiv 2604.12147("From Plan to Action", 21,120 트라젝토리, SWE-bench)이 **모델의 추론 방식과 어긋나는 계획은 계획이 없는 것보다 나쁘다**고 측정했다. 단계 순서를 설계가 고정하면 구현자의 실행 방식과 충돌할 수 있으므로, 설계는 결정·계약·검증까지만 잡고 분해는 구현 단계에 남긴다.

저추론 구현자를 상대로 계획을 문서에 박아야 한다는 근거는 GPT-5 프롬프팅 가이드다. *"prompted planning is more important, as the model has fewer reasoning tokens to do internal planning."* 여기서 "계획"은 단계 목록이 아니라 **결정**을 뜻하도록 계약을 잡았다.

3절 끝의 선택적 **병렬 단위**(§15)는 이 규칙의 예외가 아니다. 그것은 세션 사이의 파일 소유와 선후이지 한 세션 안의 단계 순서가 아니며, 한 세션이 할 일에는 쓰지 않는다.

## 5. `[미결정]` 승계

Spec Kit이 `[NEEDS CLARIFICATION]` 마커로 모호함을 모델이 조용히 결정하지 못하게 막는다. `requirements` 스킬의 `[미결정]`이 같은 역할이고, 설계가 이를 조용히 결정해버리면 요구사항 단계가 무효가 된다. 그래서 설계 스킬은 승계 아니면 명시적 결정 중 하나를 강제한다.

## 6. 오버엔지니어링 금지 문구는 짧을수록 낫다

Ponytail AGENTS.md가 7단 사다리(YAGNI → 이미 있나 → 한 줄로 되나 …)로 LOC −54%, 토큰 −22%, 비용 −20%, 시간 −27%를 자체 보고했다(n=4, Haiku 4.5, 12티켓). Scott Logic이 독립 재현에서 **"Follow YAGNI principles, and one-liner solutions" 한 줄로 동등하거나 더 나은 결과**를 얻고, 사다리 기여분은 약한 베이스라인이 만든 착시라고 반박했다. 정교한 절보다 짧고 단호한 몇 줄을 택한 근거다.

실제로 효과가 보고된 문구들은 추상 원칙이 아니라 **repo 규약 앵커링**이다. Codex CLI 유출 프롬프트가 대표적이다.

> "do not add tests to codebases with no tests... If the codebase does not have a formatter configured, do not add one... do not attempt to fix unrelated bugs."

Amp/Sourcegraph: *"Local guard > cross-layer refactor. Single-purpose util > new abstraction layer. Don't introduce patterns not used by this repo."*

Spec Kit의 Complexity Tracking 표(`Violation | Why Needed | Simpler Alternative Rejected Because`)는 메커니즘 추가에 근거를 강제하는 장치다. 스킬 본문의 "추가한 메커니즘마다 막는 실패 시나리오를 한 줄로" 규칙과 같은 계열이고, harnie `harnie-designer.md`도 같은 요구를 이미 갖고 있다.

## 7. 사람 설계문서 실무에서 가져온 것

- **MADR**: 템플릿 자체가 필수로 두는 절은 셋뿐이다. Context and Problem Statement / Considered Options / Decision Outcome. 나머지는 전부 optional 표기.
- **Nygard ADR**: *"All consequences should be listed here, not just the 'positive' ones."*
- **Rust RFC**의 Drawbacks 절은 내부자(Nick Cameron) 지적대로 "기술적으로 변경은 나쁘다" 류 무내용 문장으로 채워지기 쉽다. 의식으로 굳는 절의 사례로 참고만 한다.
- **Monzo**만 Risks 절을 "must have!"로 명시한다(Pragmatic Engineer 사내 비교).

## 8. 측정되지 않은 것 (주장 강도 표기)

"설계 문서의 구체성"을 독립 변수로 두고 **약한 모델의 성공률**을 잰 통제 실험은 찾지 못했다. Aider의 architect/editor 분리(o1-preview + DeepSeek 85.0% 대 단일 79.7%)는 모델 페어링 측정이지 이 질문의 답이 아니다. 따라서 "구체적 설계가 저추론 구현자를 살린다"는 **실무 합의이자 추론**이지 벤치마크된 사실이 아니다.

## 9. 리뷰어를 설계 세션에서 떼어낸 이유

자기비평 누적 오류 측정(arXiv 2402.08115)이 어려운 추론 과제에서 자기 리뷰가 첫 답보다 나빠지는 구간을 보고한다. 같은 세션은 앵커링과 컨텍스트 오염을 그대로 물려받으므로 리뷰어에 신선 컨텍스트를 요구했다.

프로바이더까지 가르는 근거는 따로 있다. 같은 계열이 승인한 수정 19건 중 3건(약 16%)에서 다른 계열이 오류를 추가로 잡았다(arXiv 2604.19049, 프리프린트). Anthropic은 병렬 리뷰 에이전트가 "편향과 사각지대를 공유하지 않는다"고 쓰지만, §10의 판정단 측정은 같은 모델 계열에서 오류가 강하게 상관된다고 말한다. 두 진술이 양립하는 조건은 모델·스캐폴딩이 실제로 다를 때뿐이고, 그래서 렌즈를 나누기 전에 프로바이더를 나눈다.

## 10. 다관점 팬아웃을 기본에서 뺀 이유

- 독립 실행 LLM 판정단 9개의 유효 독립표가 2.18개(95% CI 2.07–2.31), 패널 정확도 72.0% 대 최고 단일 판정자 71.8%. CoT를 켜면 상관이 올라가 1.94로 떨어진다(arXiv 2605.29800, 프리프린트지만 직접 측정).
- 다중 에이전트 토론이 self-consistency·앙상블 대비 신뢰할 만한 우위를 못 낸다(Smit et al., ICML 2024).
- 페르소나 다양화 판정은 +2.5~6.2%p를 내되, 같은 역할 설명을 쓰면 성능이 떨어진다(ChatEval, ICLR 2024). 이득의 원천은 개수가 아니라 관점의 실제 차이다.
- 80개 넘는 에이전트가 존재하지 않는 OpenSSL 패딩 오라클을 만장일치로 승인했고 경험적 테스트 하나가 그것을 기각했다(arXiv 2604.19049). 만장일치는 정확성 신호가 아니다.

2026-09-08부터는 팬아웃이 조건부로도 없다. 비가역 결정에서만 렌즈 3개로 갈랐던 조항과 구현리뷰의 발견별 교차 확인 독자를 삭제했다 — 리뷰어 수단이 orca 대화형 세션 하나로 고정되자(§12) 추가 독자를 세우는 절차가 그 수단과 양립하지 않았고, 위 측정이 말하는 팬아웃 이득이 그 비용을 넘지 않는다.

## 11. 발견마다 유효성 증명을 강제한 이유

Anthropic이 자사 리뷰 에이전트에 "발견이 유효하다는 증명을 쓰도록" 요구한 것을 반응률 16% → 54% 개선의 근거로 든다. 같은 문서 계열이 리뷰 파이프라인을 검증(거짓양성 필터) → 중복제거 → 심각도 랭킹 3단계로 서술하고, `REVIEW.md` 커스터마이즈 가이드는 행동 클레임에 `file:line` 인용을 요구하라고 쓴다. 기계가 없는 개인 프로세스에서는 그 3단계를 리뷰어 자기검증 → 코디네이터 중복제거 → 심각도순 처리로 옮겼다.

수렴 규칙(2라운드부터 신규 `nit:` 금지, 재검토 범위 = 열린 항목 + 변경분)의 근거는 둘이다. 같은 공식 문서가 1차 리뷰 후 신규 nit을 억제한다고 밝히고, 크로스컨텍스트 검증에서 라운드를 늘려도 개선 없이 노이즈만 커진 보고가 있다(arXiv 2603.16244, 프리프린트).

## 12. 리뷰어 실행 수단 — 측정된 것과 안 된 것

`mcp__codex__codex`가 `sandbox: read-only`와 `model`을 받고 `codex-reply`가 `threadId`로 스레드를 잇는다(도구 스키마 확인). 반대 방향은 막혀 있다. `codex exec --sandbox read-only` 안에서 `claude -p`는 두 블로커에 걸린다(2026-09-04 실측) — 키체인 접근 차단으로 136ms에 `Not logged in`으로 끝나고, DNS 차단 때문에 환경변수로 토큰을 줘도 `ENOTFOUND`가 되며 그 실패에 193초가 걸린다. 그래서 Codex 설계 세션의 크로스 프로바이더 리뷰어는 orca 대화형 세션이 유일한 경로다.

**2026-09-08 확정: 리뷰어 실행 수단은 orca 대화형 크로스 프로바이더 세션 하나다.** 이전 스킬 본문의 4단 사다리(orca 세션 → 크로스 프로바이더 MCP 스레드 → 동종 서브에이전트 → 사용자 개설)는 삭제했다. 근거는 대칭성이다. Claude 세션에서는 MCP 스레드와 orca 세션이 둘 다 되지만 Codex 세션에서는 위 실측대로 orca 세션만 되므로, 양 플랫폼이 같은 본문을 읽는 스킬에 남길 수 있는 기본값은 하나뿐이다. 동종 서브에이전트는 리뷰로 치지 않는다(§9). 탈출구는 사용자에게 세션 개설을 부탁하는 것 하나다. 두 수단의 비용 비교 측정은 2026-09-04에 사용자 판단으로 폐기했다(측정 비용이 얻을 정보를 넘는다).

## 13. 사람 실무에서 가져온 것과 버린 것

- **가져온 것**: Parnas·Weiss Active Design Reviews(ICSE 1985)의 리뷰어 1인 1측면·2~4인 소규모와 설계자가 측면별 질문지를 쓰는 배치, ATAM의 시나리오로 실패 조건을 뽑는 방식, Google 설계문서 실무의 교차 관심사(보안·프라이버시·관측가능성).
- **버린 것**: AWS·Azure Well-Architected 필라(5~6개)와 ISO 25010(9개)의 전체 열거. 기능 한 건 설계에 매번 돌리면 그 자체가 노이즈다. 교차 관심사는 렌즈로 세우지 않고, 설계가 실제로 닿을 때만 발화하는 MUST-find 한 줄로 넣었다.
## 14. 체인 6종 정리에서 확정한 것 (2026-09-08)

체인 = 요구사항 → 설계 → 설계리뷰 → 구현 → 구현리뷰 → 검증. 요구사항·설계·검증은 스킵할 수 있다. 사용자 결정 4건과 그로부터 따라온 계약 변경을 적는다.

| 결정 | 값 | 근거 |
|---|---|---|
| 자율 리뷰 라운드 상한 | 2 (이후는 사용자가 푼다) | 스킬 자체 개발 리뷰 3건 전부에서 "내 수정이 만든 결함"은 라운드 2에서 잡혔고, 라운드 3은 신규 id 0건(implementation-review)이거나 설계 팽창 연쇄를 만들었다(실사용 F-11). 1라운드는 그 검출 경로를 닫는다 |
| 리뷰어 수단 | orca 대화형 크로스 프로바이더 세션 1개 | §12 |
| 산출물 위치 | 워크트리 루트 `_chain/` 하나. 요구사항·설계의 기본 출력 위치이고, 리뷰 라운드·응답·검증 파일은 설계가 어디 있든 항상 여기에 쓴다. 한 워크트리에 한 체인. 커밋하지 않고 `.gitignore`에도 넣지 않는다(개인 디렉터리). 스킬은 이 디렉터리의 파일을 지우지 않고, 다른 체인의 파일이 있으면 멈추고 사용자에게 묻는다. 체인이 끝나면 사용자가 남길 내용을 `docs/`의 기존 문서에 합치고 디렉터리를 지운다 | 산출물이 untracked로 코드 트리에 흩어지면 구현의 clean 트리 확인과 구현리뷰의 변경축(baseline diff + untracked)에 걸린다(라운드 1 S-07). 디렉터리 하나를 두 검사가 무시하는 규칙 한 줄이 파일명 패턴 열거를 대신한다. 리뷰 파일을 "설계 옆"에 두는 안은 설계가 `docs/`에 있을 때 라운드 파일이 변경축에 재유입돼 폐기(라운드 3 S-10). 구현 스킬의 판정 파일 자동 선택은 같은 디렉터리의 다른 설계 판정을 집을 수 있어 폐기하고 호출자 지명으로 바꿨다(S-09) |
| 설계 없는 구현의 계약 | 요청 원문 또는 요구사항 파일 | 구현 스킬이 최소 설계를 인라인으로 쓰는 안은 "리뷰 안 된 설계를 만들지 않는다" 조항과 충돌하고, 계획 산출물이 뒷문으로 들어온다(§4). 변경 파일·검증 명령은 구현 보고서가 기록한다 |
| 기준선 | 요구사항(또는 요청 원문). 설계가 스스로 선언한 범위가 아니다 | 실사용 원장 F-01·F-03·F-04: 과설계 펜스가 설계 선언 범위를 기준으로 삼으면 수용된 발견마다 기준선이 올라가 연쇄가 난다(D-16 → D-17 → D-18) |

계약 변경.

- **산출물 파일명**: `design-review-N.md`/`design-response-N.md`, `implementation-review-N.md`/`implementation-response-N.md`. 이전에는 두 리뷰가 같은 자리에 `review-N.md`를 써서 한 설계에 두 리뷰가 돌면 덮어썼다.
- **baseline은 구현 스킬이 기록한다.** 시작 시 트리가 clean인 HEAD가 baseline이고 dirty면 선행 작업 커밋을 요구한 뒤 시작한다(stash 금지 — 워크트리 간 스택 공유). 구현리뷰·검증은 보고서의 그 값을 받는다. 이전에는 구현리뷰 코디네이터가 사후 산정했고 dirty 케이스가 미검증 상태로 남아 있었다.
- **실사용 원장 12건 적용**(`docs/skill-feedback-software-design-review.md`). PoC/운영 단계 개념(F-06)은 도입하지 않고 요구사항의 허용치를 실패 처리의 천장으로 삼는 규칙(F-05)에 흡수했다. `issue:` 안의 차단/비차단 구분(F-10)은 접미어를 늘리는 대신 요구사항 근거 없는 추가 발견이 `issue:`가 될 수 없게 한 펜스로 대신했다. F-09(누적 규모 재점검)는 D-02 기각 판정과 정합하게 코디네이터 확인 목록에 넣었다. 같은 원칙을 `implementation-review`에 대칭으로 넣었다.
- **강제 훅은 두지 않는다 (2026-09-08 사용자 결정).** 후보였던 리뷰어·검증자 쓰기 가드, 구현 보고서 Stop 검사, 라운드 응답 선행 검사는 전부 지침으로만 남긴다. 근거는 셋이다. 리뷰어·검증자가 금지 파일을 실제로 고친 사례를 이번 조사(`_research/result-3.md`, 2026-09-08)는 저장소 기록에서도 외부에서도 찾지 못했다(이전 enforcement-map의 기록은 "권한상 쓸 수 있었다"는 실측이지 사고가 아니다). "결과 파일 하나는 쓰고 나머지는 못 쓴다"를 OS 경계로 표현하는 수단은 Codex에서 조사한 셋 중 어느 것도 확인되지 않았고(`read-only`는 결과 파일까지 막는다; `-C <dir>`가 쓰기 루트를 그 디렉터리로 한정하는지, `writable_roots`에 단일 파일을 넣을 수 있는지는 공식 문서가 말하지 않아 미확인이다), Claude에서는 경로별 `Edit`/`Write` deny와 도구 제한의 조합으로 조건부로 가능하되 Bash 리다이렉션·MCP는 따로 닫아야 한다. 그리고 두 공급자 문서는 결정적 런타임 조건을 훅·샌드박스·권한으로, 판단이 필요한 것을 지침이나 prompt/agent 훅으로 다루라고 하되 고정 분류표는 주지 않으며, 게이트 추가의 마찰(우회 35%, GitHub status check 부담)은 기록돼 있는데 게이트의 품질 효과를 분리 측정한 자료는 없다. 이 위에서 사용자가 "너무 강하게 잠그지 않는다"를 택했다. 대신 두 리뷰 스킬의 "The reviewer" 단락에 "런타임이 주는 가장 좁은 쓰기 표면으로 열고, 그 경계를 못 만들면 지침에 의존해 진행하되 결과 파일을 막는 read-only로는 열지 않는다"를 넣었고, 구체 명령 형태는 orca 디스패치 문서 몫이다. 반복 위반이 관측되면 그 지점만 승격한다(기계로 판정할 수 있고 실제 사고가 관측된 불변식만 훅으로 올린다는, 이전 enforcement-map 문서의 기준과 같다. 그 문서는 0.15.0에서 삭제됐다).
- **공식 스킬과는 겹치지 않고 공존한다 (2026-09-08 조사).** Claude Code·Codex·orca의 공식 스킬·커맨드 중 요구사항·설계 문서를 입력으로 받는 것, 다른 프로바이더로 리뷰하는 것, 라운드를 관리하는 것은 없다. 겹치는 자리는 코드 리뷰 셋(Claude `code-review`, Codex `review`, Codex system skill `review-agent`)과 `simplify`·`plan`이고, 이들의 입력은 diff·PR·브랜치·파일이다. `design`은 UI 시각 설계라 겹치지 않는다. 그래서 체인 6종은 공식 스킬을 감싸지 않고 별도로 서며, 충돌은 이름이 아니라 description 자동 매칭에서만 생긴다.
- **이름은 현행 6개를 유지한다 (2026-09-08 조사·사용자 확정).** Claude 내장·Codex 번들·system·orca 스킬 어디에도 동명·접두어 충돌이 없고, Claude는 플러그인 네임스페이스(`harnie:`)로, Codex는 병합 없이 둘 다 표시해 이름으로 덮이지 않는다. 검토한 대안은 전부 더 나빴다 — `design`은 Claude UI 디자인 스킬과 동명, `verification`/`verify`는 Claude 번들 `/verify`와 경쟁, `review`는 Codex `/review`와 동명, 공통 접두어는 트리거가 description이라 충돌 회피 이득이 없다.
- **유일한 훅은 번들 스킬 차단(`hooks/skill-guard.mjs`)이다.** Claude Code에서 체인이 대체하는 `code-review`(별칭 `review`)·`simplify`의 모델 호출과 직접 입력을 막고 reason에 대체 스킬을 적는다. `plan`·`design`·`security-review`는 겹치지 않거나 사용자가 남기기로 해 막지 않는다. 번들 스킬은 bare name으로 호출되므로 네임스페이스가 붙은 이름(다른 플러그인)과 `command_source: plugin`은 통과시킨다. 실측 2026-09-08: `claude -p --model haiku --plugin-dir <이 트리>`에서 모델의 `Skill(code-review)` 호출이 deny되고 reason 문장이 모델 답변으로 그대로 돌아왔다 — `tool_input.skill` 키가 설치 버전에서 실재함을 함께 확인. Codex에는 스킬 호출 훅 이벤트가 없어 이 훅은 발화하지 않으며, `hooks.json`의 `UserPromptExpansion`(Codex 미지원 이벤트)을 Codex 로더가 무시하는지 설정 오류로 보는지는 `[미확인]`이다 — 플러그인 동기화 후 첫 Codex 세션에서 확인한다. Codex에서 파일 단위 비활성은 사용자 `config.toml`의 `[[skills.config]]`로 한다.
- **에이전트는 플러그인에 두지 않는다.** Claude `agents/*.md`와 Codex TOML은 형식이 다르고 Codex 플러그인은 에이전트를 배포하지 못한다. 코드 탐색은 양쪽 내장(`Explore`·`explorer`)을 쓰되 모델을 고정한다 — Claude는 디스패치 시 model 인자(haiku/sonnet, effort 높음), Codex는 사용자 수준 `~/.codex/agents/explorer.toml`(`gpt-5.6-luna`·high·read-only)이 같은 이름의 내장을 덮고, 어려운 탐색은 spawn 시 `gpt-5.6-terra`로 올린다(명시 spawn 값 > 에이전트 기본값 > 부모 설정).
- **복잡도 억제는 코디네이터 수용 규칙에 둔다(F-08).** 런타임 장치(상태·retry·lock·controller·health check·boot service)를 추가하는 수정을 수용하기 전에 삭제·범위 축소·관찰 유예로 닫히는지 먼저 보고, 직전 라운드 수정이 만든 발견은 그 수정의 되돌리기를 먼저 평가한다. 승인 게이트는 새로 두지 않았다.

## 15. `dev` 스킬과 병렬 단위 (2026-09-08)

`dev`는 체인 스킬 다섯 개(설계 → 설계리뷰 → 구현 → 구현리뷰 → 검증)를 한 지시로 순서대로 돌리는 조합 스킬이다. 요구사항 단계는 없고 요청 원문이 기준선이다. 이전 `dev`·`dev-solo`(파이프라인 러너·승인 게이트·seal)는 전부 버렸고, 크로스 세션은 orca가 열므로 `dev-solo`는 대체 없이 없다. 사용자 결정 4건은 조사 3건(`_research/result-5.md`~`result-7.md`, 2026-09-08)을 보고 정했다.

| 결정 | 값 | 근거 |
|---|---|---|
| 거절 시점과 기준 | 2단. 시작 전에는 정성 신호(요구 모호·스키마/마이그레이션·외부 계약·다중 저장소·인증/결제 경로·병렬 요청)로 거절하고, 설계 뒤에는 3절 파일 6개 초과·병렬 단위 존재·7절 차단 항목이면 설계를 남기고 넘긴다 | 조사 5: 실행 전 자동 거절 판정식을 가진 제품은 없고, Copilot·Codex·Claude Code·Cursor·Devin·OpenHands 전부 정성 신호만 문서화한다. 수치는 경험칙뿐이다(Codex "수백 줄·약 1시간", Devin "3시간 이하", OpenHands "100 LOC 미만"). 큰 변경은 계획을 먼저 만들고 그 결과로 판단하는 패턴이 공통(Codex Ask→Code, Claude plan mode)이라 설계 뒤 게이트를 둔다. 6개는 이 저장소의 기본값이고 경험칙이다 |
| 병렬 분할의 위치 | 설계 3절 끝의 선택적 병렬 단위(유닛 이름·파일 단독 소유·공유 기반 유닛·유닛 간 의존). 설계리뷰가 분할 결함(두 유닛에 든 파일·어느 유닛에도 없는 파일·미기재 의존·순환·공유 기반 분산)을 MUST find로 본다 | 조사 6: 분할을 계획 산출물에 적는 쪽(spec-kit `[P]`는 `/speckit.implement`가 실제로 읽는다, cc-sdd Boundary/Depends)과 실행 시 나누는 쪽(Kiro wave, Cursor, Codex)이 둘 다 있어 표준은 없다. 분할 기준은 공통으로 "서로 다른 파일 + 미완료 의존 없음"이고 공유 기반은 한 유닛에 몬다. 분할 결과를 리뷰하는 게이트를 둔 선례는 cc-sdd·Claude Squad다. 디스패치 시점 분할은 리뷰를 거치지 않으므로 택하지 않았다. 2026-09-03 조사가 "실행기가 마커를 안 쓴다"고 적은 판정은 spec-kit에 대해 틀렸다 |
| 스킬 구성 | `dev`는 직렬 간단 작업 전용. 병렬 절차는 harnie 스킬이 아니라 `~/workspace/agent-ops/claude/orca-dispatch.md` §Chain units from a design | 조사 5: 직렬과 병렬은 진입점을 나누는 쪽이 다수(BMAD quick/full, cc-sdd spec-quick/impl, superpowers executing-plans/subagent-driven). orca CLI는 Claude Code 전용이라 Codex 공용 스킬 본문에 명령을 쓸 수 없고, "디스패치는 orca, 품질은 harnie"라는 분업과도 맞는다 |
| 병렬 시 리뷰·검증 위치 | 유닛별 구현리뷰(하위 워크트리, 유닛 세션이 코디네이터) + 전부 머지 후 부모에서 검증 1회. 머지 후 코드 리뷰는 없다 | 조사 7: 사람 실무(Google small CL, Graphite/GitHub 스택, merge queue·Bors·Zuul)와 에이전트 제품(Copilot·Codex cloud·Devin·OpenHands·Factory) 전부 PR/유닛별 리뷰 + 머지 시점 결합 상태 테스트이고, 머지 후 통합 코드 리뷰를 표준으로 둔 출처는 없다. 리뷰 200~300줄 이하에서 결함 검출 밀도가 높다(SmartBear/Cisco). 통합 실패 측정치는 부모 통과 후 머지 커밋 실패 중앙값 2.34%(MSR 2017, 348개 프로젝트)로, 결합 상태 검증 1회를 두는 근거다 |

유닛은 두 모양이다(2026-09-09 사용자 확정). 설계가 결정을 끝낸 유닛은 `implementation` → `implementation-review`를 범위 한정으로 돌리고, 설계가 경계(소유 파일·다른 유닛이 부르는 인터페이스)만 정하고 내부를 남긴 유닛은 **상세설계 위임**으로 표시해 유닛 세션이 `dev`를 돌린다(내부 설계 → 설계리뷰 → 구현 → 구현리뷰 → 검증). 위임 유닛의 설계 항목이 그 유닛 체인의 **유일한 요청 원문·기준선**이라, 항목에는 경계 외에 유닛이 할 일과 유닛에 적용되는 요구사항 조건(허용치·품질 한도)까지 적고, 부모 요구사항·요청은 유닛에 넘기지 않는다(리뷰 P-07: 둘을 같이 넘기면 자식 설계리뷰가 다른 유닛 몫을 미커버 요구로 잡고, 부모 원문의 병렬 요청이 dev Gate 1에 걸린다). 부모 요구사항은 머지 후 부모 검증이 판정한다. 설계리뷰는 위임 유닛의 내부에는 결정 공백 규칙을 적용하지 않고 항목이 경계·할 일·조건을 고정했는지만 본다. 검토했지만 뺀 두 모양: 유닛은 구현만 하고 머지 후 구현리뷰 1회, 워크트리 없이 같은 트리에서 서브에이전트 병렬. 둘 다 유닛이 작을 때의 절약안인데, 그 크기면 나누지 않는 것이 맞다는 판단이다.

하위 워크트리 규약은 orca-dispatch.md에 있다. 부모 = 설계가 있는 워크트리, 유닛은 `--parent-worktree`로 부모 브랜치에서 따고, 코디네이터만 부모에 머지(rebase → 유닛 검증 재실행 → ff)하며, 충돌은 설계가 약속한 파일 단독 소유의 위반이라 손으로 풀지 않고 설계로 되돌린다. 결정 유닛의 워크트리 `_chain/`에는 부모의 `design.md`·최종 `design-review-N.md`(·`requirements.md`)를 복사해 "한 워크트리에 한 체인"과 "라운드 파일은 설계 옆 `_chain/`"을 그대로 지키고, 위임 유닛의 `_chain/`은 비워 두어 `dev`의 Gate 1(다른 체인 파일이 있으면 멈춤)에 걸리지 않게 한다(조사 6: worktree는 파일과 일부 git 상태만 나누고 refs·의존성·포트·DB는 나누지 않으며, 사고 대응은 per-worktree 자원과 명시 대상만 remove다).

## 16. 전역 PreToolUse deny 훅 두 개를 제거한 근거 (2026-09-08)

harnie 밖(agent-ops) 훅이지만 이 체인이 도는 환경의 중단점이라 여기 적는다. 사용자 결정은 "복합 명령 차단 훅 양쪽 제거, Grep 유도 훅 제거 + 지침 한 줄, 기본 권한 모드 `acceptEdits`, `.harnie` 잔재 전부 제거"다. 근거는 `_research/result-8.md`와 서브에이전트 실측.

| 훅 | 도입 근거 | 2026-09-08 확인 사실 | 처분 |
|---|---|---|---|
| `hook-bash-guard.py` (Claude·Codex PreToolUse Bash) | 복합 명령(`&&` `;` `\|\|` `$()` 백틱)은 allow 규칙이 자동 승인하지 못하므로 프롬프트 대신 deny로 바꿔 모델이 나누게 한다 | Claude Code 2.1.263 공식 권한 문서: "A rule must match each subcommand independently", 각 부분이 읽기 전용이면 `cd packages/api && ls`는 프롬프트 없이 실행. 2.1.59~2.1.141 changelog에 복합 명령 판정 보정 4건. 훅은 이 판정 앞에서 `&&` 존재만으로 deny하므로 allow에 맞는 명령까지 막는다. Codex: 승인 사유는 샌드박스·네트워크 경계이고 명령 형태와 무관(공식 config·sandbox 문서), 복합 여부를 보는 설정 항목 없음. 오늘 발화 흔적 83건(전체 세션 transcript) | 양쪽 제거. 미확인: Codex 0.153.4에서 경계 안 복합 명령의 실제 자동 승인 E2E, Claude의 백틱 내부 판정 — 빼고 관찰 |
| `hook-grep-guard.py` (Claude PreToolUse Grep) | Grep 출력의 절대경로 접두어(줄당 ~50자)를 피해 `rg`로 유도 | Grep에 경로를 생략하거나 상대경로를 주면 출력이 `rg`와 글자 단위로 같다(content 327/346자, 파일 목록 77/74자). 접두어는 호출 측이 절대경로를 넘길 때만 붙는다(448자). 2026-08-24 측정은 절대경로 호출만 본 것 | 제거. 전역 CLAUDE.md §Token Economy에 "Grep은 경로 생략 또는 상대경로" 한 줄 |

같은 날 정리한 것: `~/.claude/settings.json`의 삭제된 harnie `scripts/`·MCP allow 항목 4개, `~/.codex/config.toml`의 옛 harnie 훅 trusted_hash 7개, harnie `.gitignore`의 `.harnie/` 줄, `~/Tradlinx/GIT-PR.md`의 `.harnie-wt` 예시. `.harnie` run-state 디렉터리 3개와 `~/Tradlinx/.harnie-wt/`(git 등록이 이미 풀린 옛 run 워크트리 3개)는 `~/.Trash/harnie-cleanup-2026-09-08/run-state/`로 이동.

## 출처

- https://github.com/github/spec-kit (`templates/spec-template.md`, `plan-template.md`, `tasks-template.md`)
- https://kiro.dev/docs/specs/ · https://kiro.dev/docs/specs/feature-specs/
- https://github.com/bmad-code-org/BMAD-METHOD (`src/bmm-skills/plan/bmad-architecture/`)
- https://code.claude.com/docs/en/best-practices · https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.industrialempathy.com/posts/design-docs-at-google/ · https://github.com/adr/madr · https://github.com/rust-lang/rfcs/blob/master/0000-template.md · https://blog.pragmaticengineer.com/rfcs-and-design-docs/
- https://github.com/DietrichGebert/ponytail · https://blog.scottlogic.com/2026/06/16/ponytail-yagni-and-the-problem-with-prompt-benchmarks.html
- https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools (Amp · Codex CLI 유출 프롬프트)
- arXiv 2604.12147 · arXiv 2603.24631 · arXiv 2307.03172 · https://aider.chat/2024/09/26/architect.html

설계 리뷰 계약(§9~13)의 출처

- https://code.claude.com/docs/en/code-review · https://code.claude.com/docs/en/sub-agents · https://www.anthropic.com/engineering/building-effective-agents · https://www.anthropic.com/engineering/multi-agent-research-system
- https://owasp.org/www-project-secure-by-design-framework/ · https://docs.gitlab.com/development/database_review · https://pcidssguide.com/change-control-management-for-pci-dss/ · https://standards.ieee.org/standard/1028-2008.html
- https://en.wikipedia.org/wiki/Architecture_tradeoff_analysis_method · https://dl.acm.org/doi/10.5555/319568.319599 (Parnas & Weiss, ICSE 1985) · https://www.cs.ubc.ca/~gregor/teaching/papers/4+1view-architecture.pdf
- https://thecloudstrap.com/design-assurance-level-dal-in-do-178c/ · https://www.perforce.com/blog/qac/what-iec-61508-safety-integrity-levels-sils · https://www.hbkworld.com/en/knowledge/resource-center/articles/examining-risk-priority-numbers-in-fmea
- arXiv 2308.07201(ChatEval, ICLR 2024) · Smit et al., ICML 2024(proceedings.mlr.press/v235/smit24a.html) · arXiv 2402.08115 · arXiv 2605.29800 · arXiv 2606.29270 · arXiv 2604.19049 · arXiv 2603.16244 · arXiv 2411.03079
