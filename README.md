# harnie

**개발 체인 스킬 허브** — Claude Code · Codex 공용 플러그인. 요구사항 → 설계 → 설계리뷰 → 구현 → 구현리뷰 → 검증의 6단계를 스킬 여섯 개로 나누고, 리뷰와 검증은 다른 프로바이더의 별도 세션에서 돌린다. 구독 로그인만으로 동작하고 API 키는 쓰지 않는다.

`v0.15.0` · 테스트 3 pass (`node --test hooks/*.test.mjs`) · MIT

> 이 도구들을 일상 업무에서 어떻게 운영하는가(지침 정본 단일화 · Claude/Codex 동기화 · 자동화 루틴 · 토큰 경제)는 자매 레포 [agent-ops](https://github.com/qnamy/agent-ops)에 있다.

---

## 1. 개발 체인

| 단계 | 스킬 | 입력 | 산출 |
|---|---|---|---|
| 요구사항 | `requirements` | 짧거나 모호한 요청 | `_chain/requirements.md` — 해석이 갈리는 지점을 질문·가정·`[미결정]`으로 고정 |
| 설계 | `software-design` | 요구사항 파일 또는 직접 요청 | `_chain/design.md` — 저추론 구현자가 결정 없이 실행할 수 있는 1~7절 + 대안 비교 8절 |
| 설계리뷰 | `software-design-review` | 설계 + 요구사항 원문 | `_chain/design-review-N.md` · `design-response-N.md` — 요구사항을 기준선으로 결정 공백·사실 오류·과설계를 찾음 |
| 구현 | `implementation` | 설계(없으면 요청 원문) + 선택적 범위 한정 | 코드 + 보고서(baseline 커밋 · 검증 명령과 실제 결과 · 변경 파일) |
| 구현리뷰 | `implementation-review` | 계약(설계 또는 요청) + 요구사항 + baseline + 구현 보고서 | `_chain/implementation-review-N.md` · `implementation-response-N.md` — 계약 정합성과 정확성 |
| 검증 | `acceptance-verification` | 요구사항 기준 · 검증 명령 · baseline · 구현리뷰 판정 | `_chain/acceptance-verification.md` — 기준별 검증됨/미검증/실패 |

요구사항·설계·검증은 스킵할 수 있다. 설계 → 구현 → 구현리뷰, 설계 → 설계리뷰 → 구현, 구현 → 구현리뷰 전부 성립하고, 설계가 없으면 요청 원문이 계약이다.

**리뷰어는 다른 프로바이더의 별도 세션이다.** 설계나 코드를 쓴 세션이 코디네이터가 되어 orca로 대화형 세션 하나(Claude에서는 Codex, Codex에서는 Claude)를 열고, 요청과 결과를 파일로 주고받는다. 자율 라운드는 2회이고 그 뒤는 사용자가 푼다. 발견은 심각도 라벨이 아니라 필요성으로 수용하고, 장치를 추가하는 수정은 삭제·범위 축소·관찰 유예로 닫히는지 먼저 본다. 검증 세션은 구현을 쓴 세션이 아니어야 한다.

**요구사항이 기준선이다.** 무엇이 빠졌고 무엇이 과한지는 설계가 스스로 선언한 범위가 아니라 요구사항 파일 또는 요청자의 원문에 대고 판정한다. 실사용에서 수용된 발견마다 기준선이 올라가 설계가 팽창한 사고에서 나온 규칙이다(`docs/skill-feedback-software-design-review.md`).

**산출물은 워크트리 루트 `_chain/` 하나에 둔다.** 한 워크트리에 한 체인. 커밋하지 않고 `.gitignore`에도 넣지 않는다. 구현 스킬의 clean 트리 확인과 구현리뷰의 변경축은 이 디렉터리만 무시한다.

**체인 불변식을 강제하는 훅은 없다.** 리뷰어·검증자가 결과 파일 외를 고치지 않는 것은 스킬 문장과 세션을 여는 실행 옵션이 지키고, 실제 위반이 반복 관측되면 그 지점만 훅으로 올린다. 유일한 훅은 `hooks/skill-guard.mjs`로, Claude Code에서 체인이 대체하는 번들 스킬(`code-review`·`simplify`) 호출을 막고 대체 스킬을 안내한다(2026-09-08 headless Claude에서 deny 실측). Codex에는 스킬 호출 훅 이벤트가 없어 발화하지 않으며, Codex 로더가 `UserPromptExpansion` 항목을 어떻게 다루는지는 플러그인 동기화 후 확인 전이다. 근거는 [docs/design-artifact-references.md](docs/design-artifact-references.md) §14.

## 2. 체인 밖 스킬

각 스킬은 판단과 작성만 담당하고, 플랫폼 API 호출·투표·상태 전환은 호출자에게 남긴다. 같은 판단 기준을 사람 리뷰와 자동 루틴이 함께 쓴다.

| 스킬 | 하는 일 |
|---|---|
| `pr-review` | PR을 시니어 기준으로 리뷰해 `issue:`/`discuss:`/`nit:`로 분류하고 승인 권고를 낸다 |
| `comment-resolve` | 내가 남긴 리뷰 지적에 대한 응답이 실제 해소인지 검증해 resolve·재투표를 권고한다 |
| `deploy-approval` | 배포 승인 요청의 대상 변경을 검토해 승인/보류를 판정하고 정족수 도달 시 전진을 권고한다 |
| `quality-digest` | 누적된 리뷰 지적을 클러스터링해 lint·CI·리뷰 기준으로 승격할 후보를 제안한다(제안까지만) |
| `pr-delivery` | 주입된 Delivery Profile에 따라 PR 제목·본문과 리뷰요청 내용을 작성한다 |
| `confluence-doc` | 개발 문서를 Confluence 페이지로 구조화하고 Mermaid를 네이티브 렌더링해 발행한다 |

## 3. 스킬 작성 규약

Claude Code와 Codex가 같은 `SKILL.md`를 읽는다. 이식되는 것은 본문과 `name`·`description`뿐이라 Claude 전용 프론트매터·`${CLAUDE_PLUGIN_ROOT}`·도구 이름·호출 문법을 본문에 쓰지 않는다. 길이는 줄 수가 아니라 동시 지시 개수로 관리한다. 규약은 [CLAUDE.md](CLAUDE.md), 근거와 수치는 [docs/skill-authoring-canon.md](docs/skill-authoring-canon.md)에 있다.

## 설치

repo 루트가 플러그인(`.claude-plugin/plugin.json`)이다. **Claude Code**(최신 stable) 또는 **`codex` CLI**(구독 로그인) 어느 쪽에서든 같은 스킬을 쓴다. 크로스모델 리뷰를 돌리려면 두 구독과 [orca](https://github.com/stablyai/orca)가 필요하다.

**Claude Code**

```bash
/plugin marketplace add qnamy/harnie
```

```bash
/plugin install harnie@harnie
```

업데이트는 `/plugin marketplace update harnie` 후 `/plugin update harnie@harnie`이고 적용에 재시작이 필요하다. 터미널에서는 `claude plugin ...`으로 같은 일을 한다. clone한 저장소는 `claude --plugin-dir ./harnie`로 바로 띄운다.

**Codex**

```bash
codex plugin marketplace add qnamy/harnie --ref main
```

```bash
codex plugin add harnie@harnie
```

업데이트는 `codex plugin marketplace upgrade` 한 줄이다. 반영은 `codex plugin list`의 `harnie@harnie` 버전으로 확인한다.

두 런타임 모두 **`plugin.json`의 버전 문자열로 갱신 여부를 판단한다.** 저장소에 새 커밋이 올라가도 버전이 그대로면 갱신 명령이 조용히 아무 일도 하지 않는다.

## 구성

```
harnie/
├── .claude-plugin/   # plugin.json + marketplace.json
├── skills/           # 개발 체인 6종 + 체인 밖 스킬 6종
├── hooks/            # skill-guard: 대체된 번들 스킬 차단 (Claude Code)
└── docs/             # 현행 계약의 설계 근거
```

영문 `*.md`가 실행 정본이고 `*-ko.md` 미러는 요청 시에만 갱신한다. 미러가 영문보다 뒤처진 상태는 정상이다.

## 문서

- [docs/design-artifact-references.md](docs/design-artifact-references.md) — 설계·리뷰·체인 계약의 근거와 2026-09-08 확정 사항
- [docs/skill-authoring-canon.md](docs/skill-authoring-canon.md) — Claude · Codex 공용 스킬 작성 규약의 근거
- [docs/codex-mechanisms.md](docs/codex-mechanisms.md) — Codex 훅·스킬·에이전트 메커니즘 실측
- [docs/skill-feedback-software-design-review.md](docs/skill-feedback-software-design-review.md) — 설계리뷰 실사용 결함 원장과 적용 판정

## 라이선스

[MIT](LICENSE).
