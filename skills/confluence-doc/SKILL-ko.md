---
name: confluence-doc
description: 개발 문서(설계서·정의서·제안서 등)를 가독성 높은 Confluence 페이지로 구조화·강등(Mermaid→표/ASCII/Expand)해 Atlassian MCP로 발행한다. 문서 종류별 섹션 골격은 skeletons/ 아래의 대응 파일로 분리해 on-demand 로드하고, 입력 수집·렌더링·강등·발행 엔진은 종류와 무관하게 공통이다. 발행 대상(cloudId·space·부모·명명·계정·상태 라벨)은 호출자가 주입하며, 문서 내용 생성·품질 판단은 하지 않는다(상류 소유).
---

# Confluence 개발 문서화 (구조화 · 강등 · 발행)

이 스킬은 **문서 내용을 생성하지 않는다.** 내용 사고는 상류 아키텍처·상세 설계 방법론, harnie 빌드 스텝, 티켓, 코드에 있다. 이 스킬은 **이미 존재하는 컨텍스트를 받아, 타 팀도 한눈에 읽는 Confluence 문서로 재편·발행**한다.

이 스킬이 소유하는 것(무엇/왜):
1. **무엇이 좋은 Confluence 문서인가** — 종류별 골격·가독성(스캔가능성) 판단.
2. **강등(degrade)** — 상류 산출물의 Mermaid·장황한 산문을 Confluence에서 깨지지 않는 표/ASCII/패널로 변환.
3. **발행 오케스트레이션** — Atlassian MCP 호출.

이 스킬이 소유하지 **않는** 것(호출자=플랫폼 계층/루틴이 주입):
- 발행 대상: `cloudId` · `spaceId` · `parentId` · 페이지 제목 규칙 · 작성자/리뷰어 계정 ID · 상태 라벨 값 · 필수 리뷰어. 전부 배포처·환경 특화.
- **품질 판단** — 미결정·미커버 요구·누락 실패모드 검증은 상류 설계/설계리뷰(`instructions/design-review.md`)가 소유한다. 이 스킬은 판단하지 않고 상류 표기를 **그대로 옮긴다.**

충돌 시: **문서 구조·강등·가독성은 이 스킬, 발행 대상·계정·명명은 호출자.**

> **엔진 ↔ 골격 분리:** 입력 수집·렌더링·강등·발행은 **문서 종류와 무관한 엔진**이라 이 파일이 소유한다. 달라지는 건 **섹션 골격뿐**이므로 골격은 종류별 파일(`skeletons/<type>.md`)로 분리해 요청 시 로드한다.

---

## 출력 언어

- 최종 Confluence 페이지의 생성 제목·섹션 제목·본문·표·패널·다이어그램 캡션·발행 확인 요약은 **한국어로 작성한다.** 호출자가 정확한 페이지 제목을 제공하면 그 제목은 그대로 유지한다.
- 코드 식별자·파일 경로·API/스키마 이름·요구사항 ID·제품명·인용한 원문은 원래 표기를 유지하고, 이를 둘러싼 설명문은 한국어로 작성한다.

---

## 입력 (설계 컨텍스트 수집)

아래 네 소스 중 **있는 것을 모아 합성**한다. 우선순위: ① 상류 설계 산출물(ARCH/DETAIL) > ② 티켓 AC(Jira/ADO) > ③ 사용자 브리프 > ④ 코드/PR(as-built).

- 없는 정보는 **지어내지 않는다.** 상류의 `[미결정]`·`[가정]`·요구사항 ID(`FR-001`/`NFR-001`/`DEC-001`/`DR-NNN`)를 **그대로 보존**해 옮긴다.
- 문서 종류(아키텍처 vs 상세)를 입력에서 판별하고, 없으면 한 번 묻는다.

---

## 문서 종류 & 골격 (레지스트리 — on-demand 로드)

1. 입력에서 **문서 종류(`<type>`)를 판별**한다(모르면 한 번 묻는다).
2. 아래 **골격 해석 순서**로 처음 발견되는 골격 파일을 읽어 **그 섹션 구성·강약을 그대로 따른다.** 상단 요약 패널은 모든 종류 공통이다(아래 렌더링 규칙 참조).
3. 렌더링·강등·발행은 종류와 무관하게 아래 공통 규칙을 적용한다.

### 골격 해석 순서 (사용자 설정 가능)

문서 종류의 골격은 **사용자가 오버라이드할 수 있다.** 아래 순서로 **처음 발견되는 것**을 쓴다:

1. **호출자 주입 경로** — 루틴/환경 계층이 이 종류에 대해 골격 경로를 주입했으면 그것. (예: 회사 계층 `~/…/skeletons/<type>.md`)
2. **사용자 오버라이드** — `~/.claude/confluence-doc/skeletons/<type>.md` 가 있으면 그것. (사용자가 여기 파일만 두면 자동 인식)
3. **번들 기본값** — 플러그인 내장 `skeletons/<type>.md`.

셋 다 없으면 발행하지 말고, 이 스킬의 공통 원칙으로 최소 구조를 제안하거나 사용자에게 골격을 요청한다.

### 번들 기본값 vs 사용자 계층

| 문서 종류 | `<type>` | 골격 출처 |
|---|---|---|
| 설계서 (아키텍처/상세) | `design` | **번들 기본값** `skeletons/design.md` (범용) |
| 정의서 | `definition` | **사용자/호출자 골격** (번들 기본값 없음 — 조직마다 관례 상이) |
| 제안서 | `proposal` | **사용자/호출자 골격** (번들 기본값 없음) |

- **새 문서 종류 확장** = 골격 `.md`를 위 3위치 중 하나에 두고 이 표에 한 줄. 엔진은 손대지 않는다.
- **골격 파일이 스켈레톤(빈 섹션)이면** 채워진 섹션만 규칙으로 삼고, 빈 곳은 공통 원칙(가독성·강등·ID 보존)을 따른다.
- 공통 원칙(상류 방법론과 동일): 다이어그램 화살표엔 프로토콜·목적 표기, 대안 비교 전 결론 선암시 금지, 앞에서 정의한 내용은 재서술 대신 섹션 참조, 요구사항 ID(`FR-001`/`NFR-001`/`DEC-001`/`DR-NNN`) 보존.

---

## Confluence 렌더링 규칙 (HTML+ / ADF)

`createConfluencePage`/`updateConfluencePage`를 `contentFormat: "html"`로 호출한다. **옛 storage XML(`<ac:structured-macro>`) 금지** — `data-type` 노드만 쓴다.

- **상단 요약** = `<div data-type="panel-info">`. 상태는 `<span data-type="status" data-color="...">`(리뷰중=yellow, 승인=green, 초안=neutral). 날짜 `<time datetime="YYYY-MM-DD">`, 리뷰어 `<span data-type="mention" data-user-id="...">`(계정은 호출자), 관련 문서·티켓은 인라인 카드 `<a href="URL" data-card-appearance="inline">`.
- **주의·제약·실패 모드** = `<div data-type="panel-warning">`.
- **결정·미결정** = `<ul data-type="decision-list"><li data-type="decision-item" data-state="DECIDED|UNDECIDED">`. ADR의 **대안 비교는 표**로.
- **표** = 표준 `<table>`; 넓으면 `data-layout="wide|full-width"`.
- **코드/ASCII** = `<pre><code class="language-text">`.

### ADF 중첩 제약 (어기면 발행이 검증에서 실패한다)
- **패널 안에는 표·Expand·인용·패널을 못 넣는다.** → 요약/경고 패널은 **문단·status·mention·인라인카드 등 인라인 요소만.** 표가 필요하면 패널 밖 별도 블록으로 뺀다.
- **목록 아이템 안에 heading/table/panel/expand 금지.**
- **표 셀 안에서는 일반 `<details>` 대신 `<details data-type="nested-expand">`만** 가능(중첩 표는 불가).
- task/decision 아이템·heading·caption은 **인라인 전용.**
- 불투명 ID(`data-user-id`·`data-id` 등)는 **기존 콘텐츠/도구 출력에서 복사만** 하고 새로 지어내지 않는다. 새 노드엔 `data-local-id`를 넣지 않는다.

---

## 다이어그램 강등 규칙 (핵심 — Mermaid → Confluence)

상류 방법론은 다이어그램을 Mermaid(C4·sequence·state)로 준다. Confluence는 Mermaid를 **못 쓴다(유료).** draw.io·Gliffy·PlantUML도 유료 매크로 → **일절 쓰지 않는다.** 대신 무료 네이티브로 강등한다:

| 원본(Mermaid) | 본문 렌더 | 소스 보존 |
|---|---|---|
| flowchart / C4 Container | **컴포넌트 표**(컴포넌트·단일책임·소유데이터·의존) + 필요시 **ASCII 위상도** | 아래 Expand |
| sequenceDiagram | **단계 표**(단계·From·To·프로토콜/방식·처리/페이로드) | 아래 Expand |
| stateDiagram | **상태 전이 표**(현재상태·이벤트·다음상태·가드/부수효과) | 아래 Expand |

**소스 보존(유지보수 훅):** 표/ASCII 바로 아래에 최상위 `<details><summary>다이어그램 소스 (무료 draw.io 웹의 삽입▸고급▸Mermaid에 붙여 이미지화)</summary><pre><code class="language-text">…원본 Mermaid…</code></pre></details>` 를 둔다. 나중에 사람이 그 텍스트만 긁어 이미지로 뽑을 수 있다. (Expand는 최상위·표 셀에선 `nested-expand`.)

ASCII 위상도는 선문자(`┌ ┐ └ ┘ ─ │`)·화살표(`▲ ▼ ▶ ◀`)로. 복잡하면 ASCII를 생략하고 표만 쓴다.

---

## 발행 절차 (오케스트레이션)

1. **호출자 config 확보** — `cloudId`·`spaceId`(또는 space key)·`parentId`·제목 규칙·작성자/리뷰어 계정·상태 라벨. **없으면 발행하지 말고 사용자에게 요청한다** — 환경 특화 설정이라 스킬이 지어내지 않는다. (호출자가 플랫폼 계층 설정에서 on-demand로 주입한다.)
2. space key만 있으면 `getConfluenceSpaces`로 `spaceId` 확인.
3. **발행 전 사람 확인(필수)** — 제목·space·부모·상태(current/draft)를 요약해 보여주고 **승인을 받은 뒤** 발행한다. (공개 위키 콘텐츠 생성이므로.)
4. 신규 = `createConfluencePage`(cloudId, spaceId, title, parentId, body, contentFormat:"html", status). 갱신 = `updateConfluencePage`(cloudId, pageId, body, versionMessage).
5. 발행 후 **페이지 URL을 반환**한다.

---

## 하지 않는 것

- 설계 내용을 **생성·판단**하지 않는다(상류 소유). `[미결정]`을 스스로 채우지 않는다.
- **품질 게이트 없음**(사용자 선택). 미커버 요구·누락 실패모드를 검증·차단하지 않는다.
- Confluence **대상·계정·명명**을 결정하지 않는다(환경 특화 · 호출자 소유).
- **유료 매크로**(Mermaid/draw.io/Gliffy/PlantUML)를 쓰지 않는다. 이미지 첨부도 기본이 아니다(텍스트 우선).

---

## 입출력 계약

- **입력:** 설계 컨텍스트(상류 산출물/브리프/티켓/코드 중 있는 것) + 호출자 발행 config(대상·명명·계정·상태).
- **출력:** ① Confluence HTML+ 본문, ② (승인 후) 발행된 페이지 URL, ③ 강등 요약 — 어떤 다이어그램을 표/ASCII로 바꿨고 원본 소스를 어느 Expand에 넣었는지.

---

## 확장 노트

렌더링·강등·발행 **엔진은 문서 종류와 무관**하다. 새 종류·새 골격은 골격 해석 순서의 세 위치(호출자 주입 / 사용자 오버라이드 / 번들) 중 하나에 `.md`를 두고 레지스트리 표에 한 줄 넣으면 된다 — 엔진·렌더링·발행 코드는 손대지 않는다.

**번들엔 범용 `design`만 둔다.** 조직마다 관례가 크게 다른 정의서·제안서 골격은 번들에 박지 않고 **사용자/호출자 계층**에 둬서, 각자 자기 하우스 스타일로 오버라이드하게 한다. 이 덕에 공개 플러그인은 특정 조직 관례에 오염되지 않는다.
