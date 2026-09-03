# 설계 산출물 계약의 근거

> 조사일 2026-09-03. `skills/software-design/SKILL.md`의 절 계약과 금지 조항이 왜 그 모양인지의 출처다. 계약 자체는 스킬 본문이 정본이다.

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

## 출처

- https://github.com/github/spec-kit (`templates/spec-template.md`, `plan-template.md`, `tasks-template.md`)
- https://kiro.dev/docs/specs/ · https://kiro.dev/docs/specs/feature-specs/
- https://github.com/bmad-code-org/BMAD-METHOD (`src/bmm-skills/plan/bmad-architecture/`)
- https://code.claude.com/docs/en/best-practices · https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.industrialempathy.com/posts/design-docs-at-google/ · https://github.com/adr/madr · https://github.com/rust-lang/rfcs/blob/master/0000-template.md · https://blog.pragmaticengineer.com/rfcs-and-design-docs/
- https://github.com/DietrichGebert/ponytail · https://blog.scottlogic.com/2026/06/16/ponytail-yagni-and-the-problem-with-prompt-benchmarks.html
- https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools (Amp · Codex CLI 유출 프롬프트)
- arXiv 2604.12147 · arXiv 2603.24631 · arXiv 2307.03172 · https://aider.chat/2024/09/26/architect.html
