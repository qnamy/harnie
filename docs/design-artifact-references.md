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

상한 3의 근거는 셋이 같은 대역을 가리킨다. Anthropic이 숫자를 낸 유일한 지점이 리서치 서브에이전트 3~5개, Parnas·Weiss의 리뷰 그룹 2~4인, harnie `instructions/team-collab.md`의 렌즈 1~2개·팀원 ≤4다.

병합에 심판과 다수결을 금지한 것도 측정 때문이다. 토론 로그를 읽는 LLM 판정자가 순이득 음수를 냈고, 갈린 사례의 약 1/4에서 정답이 소수 쪽에 있다(arXiv 2606.29270, 프리프린트).

## 11. 발견마다 유효성 증명을 강제한 이유

Anthropic이 자사 리뷰 에이전트에 "발견이 유효하다는 증명을 쓰도록" 요구한 것을 반응률 16% → 54% 개선의 근거로 든다. 같은 문서 계열이 리뷰 파이프라인을 검증(거짓양성 필터) → 중복제거 → 심각도 랭킹 3단계로 서술하고, `REVIEW.md` 커스터마이즈 가이드는 행동 클레임에 `file:line` 인용을 요구하라고 쓴다. 기계가 없는 개인 프로세스에서는 그 3단계를 리뷰어 자기검증 → 코디네이터 중복제거 → 심각도순 처리로 옮겼다.

수렴 규칙(2라운드부터 신규 `nit:` 금지, 재검토 범위 = 열린 항목 + 변경분)의 근거는 둘이다. 같은 공식 문서가 1차 리뷰 후 신규 nit을 억제한다고 밝히고, 크로스컨텍스트 검증에서 라운드를 늘려도 개선 없이 노이즈만 커진 보고가 있다(arXiv 2603.16244, 프리프린트).

## 12. 렌즈 발동을 비가역성 단일축으로 둔 이유

실무 트리거 목록은 전부 OR 게이트다. OWASP Secure by Design이 "any one of these should prompt a threat model"로 넷 중 하나를 요구하고, GitLab은 스키마 변경·데이터 마이그레이션이라는 단일 신호로 DB 리뷰를 강제하며, PCI-DSS·SOX는 카드·재무 데이터를 건드린다는 콘텐츠 단일 조건으로 정식 변경통제를 건다. **도메인 두 개 이상의 동시 충족을 요구하는 선례는 조사 범위에서 하나도 나오지 않았다.**

안전 표준은 도메인을 세지 않는다. DO-178C는 최악 결과의 단일 심각도 척도로 등급을 정하고 IEC 61508은 심각도×빈도를 쓴다. FMEA의 곱셈형 RPN은 원전 문헌이 스스로 안전 항목을 저평가한다고 지적하므로 점수제는 쓰지 않았다.

다만 저 출처들은 "리뷰를 할 것인가"를 가르고 이 스킬의 트리거는 "리뷰어를 여럿 둘 것인가"를 가른다. 기본값에 이미 크로스 프로바이더 리뷰 한 벌이 들어 있어서 OR을 그대로 얹으면 DB나 인증에 닿는 설계 전부가 렌즈를 받는다. 그래서 구조는 OR로 두고 조건을 최악 결과로 좁혔다 — 닿는 것이 아니라, 틀렸을 때 되돌릴 수 없는 것.

## 13. 리뷰어 실행 수단 — 측정된 것과 안 된 것

`mcp__codex__codex`가 `sandbox: read-only`와 `model`을 받고 `codex-reply`가 `threadId`로 스레드를 잇는다(도구 스키마 확인). 반대 방향은 막혀 있다. `codex exec --sandbox read-only` 안에서 `claude -p`는 두 블로커에 걸린다(2026-09-04 실측) — 키체인 접근 차단으로 136ms에 `Not logged in`으로 끝나고, DNS 차단 때문에 환경변수로 토큰을 줘도 `ENOTFOUND`가 되며 그 실패에 193초가 걸린다. 그래서 Codex 설계 세션의 크로스 프로바이더 리뷰어는 orca 대화형 세션이 유일한 경로다.

**측정되지 않은 것**: orca 대화형 세션과 이 세션에서 여는 크로스 프로바이더 스레드의 비용 차이. orca는 벤더 문서에도 문헌에도 없는 로컬 도구라 외부 비교 자료가 존재하지 않고, 스킬 본문의 사다리 순서는 추론이다. 레포 `CLAUDE.md` §열린 판정이 이 표본을 요구한다.

## 14. 사람 실무에서 가져온 것과 버린 것

- **가져온 것**: Parnas·Weiss Active Design Reviews(ICSE 1985)의 리뷰어 1인 1측면·2~4인 소규모와 설계자가 측면별 질문지를 쓰는 배치, ATAM의 시나리오로 실패 조건을 뽑는 방식, Google 설계문서 실무의 교차 관심사(보안·프라이버시·관측가능성).
- **버린 것**: AWS·Azure Well-Architected 필라(5~6개)와 ISO 25010(9개)의 전체 열거. 기능 한 건 설계에 매번 돌리면 그 자체가 노이즈다. 교차 관심사는 렌즈로 세우지 않고, 설계가 실제로 닿을 때만 발화하는 MUST-find 한 줄로 넣었다.
- **공백**: 기능 규모 설계 문서 리뷰에 렌즈 몇 개가 적정한지 처방한 표준이나 논문은 찾지 못했다. 상한 3은 §10의 세 출처가 같은 대역을 가리킨다는 근거뿐이고 벤치마크된 값이 아니다.

## 출처

- https://github.com/github/spec-kit (`templates/spec-template.md`, `plan-template.md`, `tasks-template.md`)
- https://kiro.dev/docs/specs/ · https://kiro.dev/docs/specs/feature-specs/
- https://github.com/bmad-code-org/BMAD-METHOD (`src/bmm-skills/plan/bmad-architecture/`)
- https://code.claude.com/docs/en/best-practices · https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.industrialempathy.com/posts/design-docs-at-google/ · https://github.com/adr/madr · https://github.com/rust-lang/rfcs/blob/master/0000-template.md · https://blog.pragmaticengineer.com/rfcs-and-design-docs/
- https://github.com/DietrichGebert/ponytail · https://blog.scottlogic.com/2026/06/16/ponytail-yagni-and-the-problem-with-prompt-benchmarks.html
- https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools (Amp · Codex CLI 유출 프롬프트)
- arXiv 2604.12147 · arXiv 2603.24631 · arXiv 2307.03172 · https://aider.chat/2024/09/26/architect.html

설계 리뷰 계약(§9~14)의 출처

- https://code.claude.com/docs/en/code-review · https://code.claude.com/docs/en/sub-agents · https://www.anthropic.com/engineering/building-effective-agents · https://www.anthropic.com/engineering/multi-agent-research-system
- https://owasp.org/www-project-secure-by-design-framework/ · https://docs.gitlab.com/development/database_review · https://pcidssguide.com/change-control-management-for-pci-dss/ · https://standards.ieee.org/standard/1028-2008.html
- https://en.wikipedia.org/wiki/Architecture_tradeoff_analysis_method · https://dl.acm.org/doi/10.5555/319568.319599 (Parnas & Weiss, ICSE 1985) · https://www.cs.ubc.ca/~gregor/teaching/papers/4+1view-architecture.pdf
- https://thecloudstrap.com/design-assurance-level-dal-in-do-178c/ · https://www.perforce.com/blog/qac/what-iec-61508-safety-integrity-levels-sils · https://www.hbkworld.com/en/knowledge/resource-center/articles/examining-risk-priority-numbers-in-fmea
- arXiv 2308.07201(ChatEval, ICLR 2024) · Smit et al., ICML 2024(proceedings.mlr.press/v235/smit24a.html) · arXiv 2402.08115 · arXiv 2605.29800 · arXiv 2606.29270 · arXiv 2604.19049 · arXiv 2603.16244 · arXiv 2411.03079
