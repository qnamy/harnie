---
description: 단일 개발 파이프라인 진입점 — 잠정 규모(S/M)와 난이도를 판정한 뒤 harnie:dev 스킬을 실행한다
argument-hint: "<task description>"
---

Task: $ARGUMENTS

당신은 harnie의 단일 개발 파이프라인에 진입하고 있다. 부트스트랩 훅이 이미 이 run의 worktree와 상태(`mode: "sizing"`)를 생성했다; 훅의 컨텍스트 메시지가 **workroot**를 알려준다 — 모든 `execution.mjs`/`loop.mjs apply` 호출의 `--root`로 그것을 사용하며, 이는 run의 유일한 git 트리이기도 하다(그리고 빌더 cwd).

정확히 두 가지 판정을 수행하고, 각각 한 줄로 공표한 뒤, 태스크를 그대로 담아 `harnie:dev` 스킬을 호출한다:

1. **잠정 규모** — S: 국소 수정, 설계 판단 불필요. M: 설계 판단이 필요하고, 리뷰 유닛 하나로 충분. **M보다 큰 작업** — ARCH 트리거(신규 컴포넌트/경계/데이터 소유권/기술 선택/SPOF 결정) 중 하나라도 해당하거나 독립적 리뷰 가치를 지닌 태스크가 2개 이상 — 은 **harnie의 몫이 아니다**: run을 시작하지 말고 사람 + orca 프로세스로의 인계를 보고한다. 이는 잠정 판정이다 — 스킬이 그라운딩 후 확정하며, 상향 에스컬레이션만 존재한다.
2. **Run 난이도** — `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §2에 따라 easy/medium/hard/very hard(진입 시 판정, §2의 두 체크포인트에서 재판정; 프로듀서/리뷰어 모델을 선택한다).

규모 사이에서 불확실하면 더 작은 쪽을 택한다 — 에스컬레이션은 저렴하고 하향 재분류는 존재하지 않는다. 이 단계에서 코드나 파일을 작성하지 않는다.
