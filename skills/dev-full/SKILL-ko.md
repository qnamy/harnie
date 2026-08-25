---
name: dev-full
description: "DEPRECATED 별칭(0.12에서 제거) — 0.11에서 단일 harnie:dev 파이프라인으로 병합. 대신 harnie:dev를 호출한다."
---

# dev-full → harnie:dev (0.11 별칭)

이 트랙은 단일 파이프라인으로 병합되었다. 먼저 `commands/dev.md`의 두 진입 판정을 수행하고(그곳의 S/M/L 기준에 따른 잠정 규모 — 별칭 이름은 아무것도 함의하지 않는다 — 와 run 난이도), 그다음 **즉시 같은 태스크 인자로 `harnie:dev` 스킬을 호출하며**, 사용자에게 deprecation을 한 줄로 알린다. 이 스킬에서 다른 어떤 작업도 수행하지 않는다.
