---
name: design-authoring
description: 독립 요청(/harnie:dev 루프 밖)으로 아키텍처 설계 또는 상세 설계를 작성할 때, 정본 디자이너 게이트와 해당 고도의 출력 계약을 로드해 수행한다. 얇은 래퍼 — agents/harnie-designer.md와 instructions/design-authoring-{arch,detail}.md를 참조로만 적용하며 어느 쪽도 재기술하지 않는다. 기존 설계의 리뷰는 이 스킬이 아니라 instructions/design-review.md의 기준을 따른다.
---

# 설계 작성 (얇은 래퍼)

이 스킬은 **자체 설계 방법론을 담지 않는다**. 정본은 두 곳에 있으며 참조로 로드한다:

- **페르소나·진입 게이트·작업 원칙·최종 자가리뷰** → `${CLAUDE_PLUGIN_ROOT}/agents/harnie-designer.md`
- **고도별 출력 계약** → `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-arch.md`(ARCH) 또는 `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md`(DETAIL)

이 파일이 위 문서들과 어긋나 보이면 **그 문서들이 우선**한다. 그 내용을 이 파일이나 대화에 복사하지 말고, Read해서 그대로 따른다.

## 절차

1. **고도 결정.** 고도 정의는 `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §1을 따른다. 독립 요청은 ARCH 또는 TASK-DETAIL(상세설계 프로필)이며, CONTRACT 고도는 L 파이프라인 내부 전용으로 독립 요청 대상이 아니다. 요청이 모호하면 요청자에게 고도를 한 번 확인한다.
2. **정본 로드.** 디자이너 에이전트 본문과 해당 고도 프로필을 Read한다. 직접(인라인) 작성할 때는 에이전트 본문의 진입 게이트와 작업 원칙을 스스로 적용한다. `harnie-designer` 서브에이전트에 위임할 때는 위임 프롬프트에 프로필의 **절대경로**, 고도·모드 신호, 출력 경로를 전달한다 — 에이전트 본문이 프로필을 직접 Read하도록 요구하므로 내용을 붙여넣지 않는다.
3. **작성.** 프로필의 섹션 계약을 따른다. 기본은 경량(lightweight)이며, 요청자가 명시적으로 "formal"을 신호할 때만 정식(Formal) 섹션 세트를 쓴다. 문서는 요청자가 사용하는 언어로 작성한다.

## 범위 주석

- `/harnie:dev` 파이프라인은 설계 스테이지에서 같은 계약을 직접 로드한다. 파이프라인 내부에서 이 스킬을 호출하지 않는다.
- 기존 설계의 리뷰는 이 스킬이 아니다: 대상에 맞는 고도 렌즈로 `${CLAUDE_PLUGIN_ROOT}/instructions/design-review.md`를 적용한다.
