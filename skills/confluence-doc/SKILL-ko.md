---
name: confluence-doc
description: 개발 문서(설계서·정의서·제안서 등)를 가독성 높은 Confluence 페이지로 구조화하고, 호출자가 Mermaid 다이어그램 매크로를 주입하면 네이티브로 렌더링(없으면 표/ASCII/Expand로 강등)해 Atlassian MCP로 발행한다. 문서 종류별 섹션 골격은 skeletons/ 아래의 대응 파일로 분리해 on-demand 로드하고, 입력 수집·렌더링·다이어그램 처리·발행 엔진은 종류와 무관하게 공통이다. 발행 대상(cloudId·space·부모·명명·계정·상태 라벨·선택적 Mermaid 매크로 식별자)은 호출자가 주입하며, 문서 내용 생성·품질 판단은 하지 않는다(상류 소유).
---

# Confluence 개발 문서화 (구조화 · 강등 · 발행)

이 스킬은 **문서 내용을 생성하지 않는다.** 내용 사고는 상류 아키텍처·상세 설계 방법론, harnie 빌드 스텝, 티켓, 코드에 있다. 이 스킬은 **이미 존재하는 컨텍스트를 받아, 타 팀도 한눈에 읽는 Confluence 문서로 재편·발행**한다.

이 스킬이 소유하는 것(무엇/왜):
1. **무엇이 좋은 Confluence 문서인가** — 종류별 골격·가독성(스캔가능성) 판단.
2. **다이어그램 처리** — 호출자가 Mermaid 다이어그램 매크로를 주입하면 상류 Mermaid를 네이티브로 렌더링하고, 없으면 Mermaid·장황한 산문을 Confluence에서 깨지지 않는 표/ASCII/패널로 강등.
3. **발행 오케스트레이션** — Atlassian MCP 호출.

이 스킬이 소유하지 **않는** 것(호출자=플랫폼 계층/루틴이 주입):
- 발행 대상: `cloudId` · `spaceId` · `parentId` · 페이지 제목 규칙 · 작성자/리뷰어 계정 ID · 상태 라벨 값 · 필수 리뷰어. 전부 배포처·환경 특화.
- **발행 어댑터:** `publicationAdapter.contentFormat` — writer의 body 포맷, **기본값 `"html"`**(이 스킬의 노드 형태가 대상으로 하는 Atlassian MCP HTML+ writer이자 여기서 검증된 경로). 호출자는 non-HTML+ writer일 때만 이를 오버라이드하고, 그때는 어댑터별 body/노드 계약을 호출자가 소유한다(아래 렌더링 규칙의 어댑터 스코프 참조).
- **Mermaid 매크로(선택):** `mermaidMacro` — **대상 사이트에 설치된** Mermaid 다이어그램 Marketplace/Forge 앱의 식별자(`extensionKey`, 선택적으로 `extensionType`/`layout`). `mermaidMacro` **+ 호환 발행 어댑터**(확장 노드를 담을 수 있는 것 — 기본 HTML+ writer, 또는 호출자가 제공한 동등 노드 계약)면 네이티브 렌더링(아래 Mode A), 그에 못 미치면 강등(Mode B)을 선택한다. 그런 앱의 설치 여부·키는 환경 특화이므로 호출자가 주입한다 — 사이트의 앱 식별자를 이 스킬에 하드코딩하지 않는다.
- **품질 판단** — 미결정·미커버 요구·누락 실패모드 검증은 상류 설계/설계리뷰(`instructions/design-review.md`)가 소유한다. 이 스킬은 판단하지 않고 상류 표기를 **그대로 옮긴다.**

충돌 시: **문서 구조·강등·가독성은 이 스킬, 발행 대상·계정·명명은 호출자.**

> **엔진 ↔ 골격 분리:** 입력 수집·렌더링·다이어그램 처리·발행은 **문서 종류와 무관한 엔진**이라 이 파일이 소유한다. 달라지는 건 **섹션 골격뿐**이므로 골격은 종류별 파일(`skeletons/<type>.md`)로 분리해 요청 시 로드한다.

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
3. 렌더링·다이어그램 처리·발행은 종류와 무관하게 아래 공통 규칙을 적용한다.

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

## Confluence 렌더링 규칙 (HTML+)

**어댑터 스코프.** 아래 노드 형태(패널·status·결정·표·Mode A 확장 노드)는 **HTML+ `data-type` 노드**이므로, 이 스킬은 HTML+ writer — `contentFormat:"html"`의 Atlassian MCP `createConfluencePage`/`updateConfluencePage`, 여기서 end-to-end 검증된 경로 — 를 대상으로 한다. 발행 절차는 포맷을 `publicationAdapter.contentFormat`(기본 `"html"`)에서 읽는다. `data-type` 노드를 담지 못하는 어댑터(예: markdown 전용 writer)는 이 스킬의 HTML+ 스코프 밖이다 — 호출자가 그 어댑터용 동등 노드 계약을 제공하거나, 다이어그램 경로는 Mode B로 떨어진다. **옛 storage XML(`<ac:structured-macro>`) 금지** — `data-type` 노드만 쓴다.

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

## 다이어그램 렌더링 규칙 (Mermaid)

상류 방법론은 다이어그램을 Mermaid(C4·sequence·state)로 준다. 호출자 config에 따라 경로를 고른다: **`mermaidMacro` + 호환 발행 어댑터면 네이티브 렌더(Mode A), 아니면 강등(Mode B).**

### Mode A — 호출자 Mermaid 매크로로 네이티브 렌더 (가능하면 우선)

일부 Confluence 사이트에는 Mermaid 다이어그램 Marketplace/Forge 앱이 설치돼 있다(예: "Mermaid Diagrams for Confluence"). 호출자가 `mermaidMacro`를 주입하면, 그 앱의 확장 매크로 안에 Mermaid 소스를 넣어 Confluence가 실제 다이어그램으로 렌더하게 한다.

**어댑터 게이트.** Mode A는 HTML+ 확장 노드를 emit하므로 HTML+ writer(`publicationAdapter.contentFormat:"html"`)를 요구한다 — 이 사이트에서 end-to-end 검증된 경로다. `publicationAdapter.contentFormat`이 `"html"`이 아니면(예: adf·markdown 전용 writer), 호출자가 그 어댑터용 동등 확장-노드 계약을 주입한 경우에**만** Mode A가 가능하고, 아니면 다이어그램은 Mode B로 떨어진다. HTML+ 노드를 non-HTML+ writer에 emit하지 않는다.

**매크로 계약(범용 아님, 좁음).** 이 프로필은 `.../static/mermaid-diagram`처럼 소스를 `guestParams.input` JSON 문자열로 받는 Mermaid 매크로를 지원한다. 이는 **특정 앱 하나의 계약이지 일반 Forge/Marketplace 관례가 아니다.** 호출자의 앱이 다르면 `extensionKey`만이 아니라 `{{input}}` 슬롯이 든 전체 노드 템플릿을 주입한다 — 스킬은 아래 인코딩만 소유한다.

`mermaidMacro`(호출자 주입): `extensionKey`(설치된 앱 키, 예 `<APP_ID>/<ENV_ID>/static/mermaid-diagram`), `extensionType`(예 `com.atlassian.ecosystem`), 선택 `layout`(`wide`/`full-width`). 다이어그램마다 노드를 하나씩 emit한다:

```html
<div data-type="extension"
     data-extension-key="<APP_ID>/<ENV_ID>/static/mermaid-diagram"
     data-extension-type="com.atlassian.ecosystem"
     data-layout="wide"
     data-parameters="<ENCODED_PARAMETERS>"></div>
```

- **작성하는 속성은** `data-type`·`data-extension-key`·`data-extension-type`·`data-parameters`와 선택 `data-layout`뿐 — HTML+ writer가 확장 노드에 대해 문서화한 속성들이다. 그 계약대로 신규 노드엔 **`data-local-id`를(그리고 모든 불투명 ID를) 넣지 않는다.** `localId`는 에디터가 노드마다 부여하는 UUID이지 **페이지에서 파생되는 값이 아니다.** `embeddedMacroContext`·`forgeEnvironment`·`extensionId`도 작성하지 않는다: **최소 노드엔 불필요하다**(이들 없이 발행한 draft가 정상 렌더됐고 재조회 ADF에도 추가되지 않았다). 기존 페이지를 읽을 때 보이는 그런 필드는 **표현별 read-back 메타데이터**이지 필수 입력이 아니다. 특정 앱이 더 없이는 렌더를 거부하면, 스킬이 필드를 추측하지 말고 호출자가 **검증된 노드 템플릿**을 주입한다.
- **`data-parameters` 만들기 — 결정적 2단계(순서가 틀리면 이중 인코딩돼 렌더가 깨진다):**
  1. **JSON 단계.** 객체 `{"layout":"extension","guestParams":{"input":<MERMAID>,"url":""}}`를 만들어 실제 직렬화기(`JSON.stringify`)로 직렬화한다 — 손으로 이스케이프하지 않는다. 이 단계만으로 소스가 올바르게 처리된다: `"`→`\"`, 개행→`\n`, `\`→`\\`.
  2. **HTML 속성 단계.** 직렬화된 문자열을 속성값용으로 HTML 인코딩하되 **`&`를 먼저** 바꾸고 나머지를 바꾼다: `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`. `&` 먼저가 필수다: `<`/`>`/`"`를 먼저 바꾸면 `&lt;`/`&quot;`의 `&`가 다시 `&amp;lt;`/`&amp;quot;`로 이중 인코딩된다.
- **Golden example.** Mermaid `graph LR` + 개행 + `  A["X<br>Y"] -->|go| B`는 JSON.stringify 후 속성 인코딩하면:

  ```
  data-parameters="{&quot;layout&quot;:&quot;extension&quot;,&quot;guestParams&quot;:{&quot;input&quot;:&quot;graph LR\n  A[\&quot;X&lt;br&gt;Y\&quot;] --&gt;|go| B&quot;,&quot;url&quot;:&quot;&quot;}}"
  ```

  레이어를 읽어보면: 라벨 따옴표 → `\&quot;`(백슬래시는 JSON, `&quot;`는 HTML), `<br>` → `&lt;br&gt;`, `-->` → `--&gt;`, 개행 → `\n`. 이스케이프를 줄이려면 라벨에 따옴표·`<br>`를 쓰지 않는 편이 좋다.
- **일회 검증(사이트+앱마다).** 이 최소-노드 경로는 draft로 발행해 **reference deployment**(HTML+ writer + 소스를 `guestParams.input`으로 읽는 Mermaid 앱)에서 Confluence UI 렌더를 확인했다. 구체 사이트·앱 식별자는 환경 특화라 호출자의 배포 설정·검증 기록에 두고 **이 스킬엔 두지 않는다.** **다른** 사이트·앱이면 라운드트립을 다시 통과하기 전까진 네이티브 렌더를 미입증으로 본다: 따옴표·`<br/>`·`&`·개행을 포함하는 Mermaid로 **draft**를 하나 발행 → 재조회 → 렌더 확인.
- Mode B의 소스 보존 Expand는 여기선 **선택**이다(렌더되면 중복). 호출자가 복붙 유지보수 훅을 원할 때만 추가한다.

### Mode B — 표/ASCII로 강등 (매크로 미주입 시 폴백)

Confluence는 그런 앱 없이는 Mermaid를 **못 렌더**하고, draw.io·Gliffy·PlantUML도 유료 매크로다 — **설치돼 있다고 가정하지 않는다.** `mermaidMacro`가 없으면 무료 네이티브로 강등한다:

| 원본(Mermaid) | 본문 렌더 | 소스 보존 |
|---|---|---|
| flowchart / C4 Container | **컴포넌트 표**(컴포넌트·단일책임·소유데이터·의존) + 필요시 **ASCII 위상도** | 아래 Expand |
| sequenceDiagram | **단계 표**(단계·From·To·프로토콜/방식·처리/페이로드) | 아래 Expand |
| stateDiagram | **상태 전이 표**(현재상태·이벤트·다음상태·가드/부수효과) | 아래 Expand |

**소스 보존(유지보수 훅):** 표/ASCII 바로 아래에 최상위 `<details><summary>다이어그램 소스 (무료 draw.io 웹의 삽입▸고급▸Mermaid에 붙여 이미지화)</summary><pre><code class="language-text">…원본 Mermaid…</code></pre></details>` 를 둔다. 나중에 사람이 그 텍스트만 긁어 이미지로 뽑을 수 있다. (Expand는 최상위·표 셀에선 `nested-expand`.)

ASCII 위상도는 선문자(`┌ ┐ └ ┘ ─ │`)·화살표(`▲ ▼ ▶ ◀`)로. 복잡하면 ASCII를 생략하고 표만 쓴다.

---

## 발행 절차 (오케스트레이션)

1. **호출자 config 확보** — `cloudId`·`spaceId`(또는 space key)·`parentId`·제목 규칙·작성자/리뷰어 계정·상태 라벨, 그리고 `publicationAdapter.contentFormat`(기본 `"html"`)와 선택적 `mermaidMacro`(`mermaidMacro` + 호환 어댑터면 Mode A 네이티브 렌더 / 아니면 Mode B 강등). **없으면 발행하지 말고 사용자에게 요청한다** — 환경 특화 설정이라 스킬이 지어내지 않는다. (호출자가 플랫폼 계층 설정에서 on-demand로 주입한다.)
2. space key만 있으면 `getConfluenceSpaces`로 `spaceId` 확인.
3. **발행 전 사람 확인(필수)** — 제목·space·부모·상태(current/draft)를 요약해 보여주고 **승인을 받은 뒤** 발행한다. (공개 위키 콘텐츠 생성이므로.)
4. 신규 = `createConfluencePage`(cloudId, spaceId, title, parentId, body, contentFormat:publicationAdapter.contentFormat, status). 갱신 = `updateConfluencePage`(cloudId, pageId, body, contentFormat, versionMessage). 이 스킬의 `body` 노드 형태는 `contentFormat:"html"`을 전제하며, non-HTML+ 포맷이면 호출자의 어댑터별 body가 필요하다.
5. 발행 후 **페이지 URL을 반환**한다.

---

## 하지 않는 것

- 설계 내용을 **생성·판단**하지 않는다(상류 소유). `[미결정]`을 스스로 채우지 않는다.
- **품질 게이트 없음**(사용자 선택). 미커버 요구·누락 실패모드를 검증·차단하지 않는다.
- Confluence **대상·계정·명명**을 결정하지 않는다(환경 특화 · 호출자 소유).
- 사이트의 **매크로 식별자를 하드코딩**하거나 Mermaid/draw.io/Gliffy/PlantUML 앱이 설치돼 있다고 가정하지 않는다. 네이티브 Mermaid 매크로는 **호출자가 `mermaidMacro`를 주입할 때만**(Mode A) 쓰고, 없으면 강등한다(Mode B). `embeddedMacroContext`에 복사한 cloudId/accountId를 절대 작성하지 않는다. 이미지 첨부도 기본이 아니다(가능하면 매크로, 아니면 텍스트 우선).

---

## 입출력 계약

- **입력:** 설계 컨텍스트(상류 산출물/브리프/티켓/코드 중 있는 것) + 호출자 발행 config(대상·명명·계정·상태) + `publicationAdapter.contentFormat`(기본 `"html"`) + 선택적 `mermaidMacro`.
- **출력:** ① 어댑터 호환 본문(기본 HTML+), ② (승인 후) 발행된 페이지 URL, ③ 다이어그램 요약 — 어떤 다이어그램을 네이티브 렌더(Mode A — `mermaidMacro` + 호환 어댑터)했고, 어떤 것을 표/ASCII로 강등(Mode B)했으며 원본 소스를 어디에 뒀는지.

---

## 확장 노트

렌더링·다이어그램 처리·발행 **엔진은 문서 종류와 무관**하다. 새 종류·새 골격은 골격 해석 순서의 세 위치(호출자 주입 / 사용자 오버라이드 / 번들) 중 하나에 `.md`를 두고 레지스트리 표에 한 줄 넣으면 된다 — 엔진·렌더링·발행 코드는 손대지 않는다.

**번들엔 범용 `design`만 둔다.** 조직마다 관례가 크게 다른 정의서·제안서 골격은 번들에 박지 않고 **사용자/호출자 계층**에 둬서, 각자 자기 하우스 스타일로 오버라이드하게 한다. 이 덕에 공개 플러그인은 특정 조직 관례에 오염되지 않는다.
