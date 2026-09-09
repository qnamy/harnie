---
name: confluence-doc
description: 설계·정의·제안 같은 개발 문서를 읽기 좋은 Confluence 페이지로 구조화하고, 호출자가 주입한 다이어그램 매크로가 있으면 Mermaid를 네이티브로 렌더링하며(없으면 표/ASCII/Expand로 강등하고), Atlassian MCP로 발행한다. 각 문서 유형의 섹션 스켈레톤은 skeletons/ 아래 대응 파일에서 필요할 때 로드하고, 입력 수집·렌더링·다이어그램 처리·발행은 하나의 문서-유형-독립 엔진으로 처리한다. 호출자는 발행 대상(cloudId, space, parent, 명명 규칙, 계정, 상태 라벨, 선택적 Mermaid 매크로 정체성)을 주입한다. 문서 내용을 생성하거나 그 품질을 판단하지 않는다 — 둘 다 상위 단계 소유다.
---

# Confluence 개발 문서화 (구조화 · 강등 · 발행)

이 스킬은 **문서 내용을 생성하지 않는다.** 상위 아키텍처·상세설계 방법론, harnie 빌드 단계, 티켓, 코드가 내용 추론을 소유한다. 기존 맥락을 그대로 받아 다른 팀이 한눈에 훑어볼 수 있는 Confluence 문서로 재구성한 뒤 발행한다.

이 스킬은 다음 관심사와 그 근거를 소유한다.

1. **좋은 Confluence 문서란 무엇인가** — 유형별 스켈레톤과 가독성 판단.
2. **다이어그램 처리** — 호출자가 Mermaid 다이어그램 매크로를 주입하면 상위 Mermaid를 네이티브로 렌더링하고, 그렇지 않으면 Mermaid와 장문의 산문을 Confluence에서 깨지지 않는 표·ASCII·패널로 강등한다.
3. **발행 오케스트레이션** — Atlassian MCP를 호출한다.

이 스킬은 다음을 소유하지 **않는다**. 호출자(플랫폼 계층 또는 루틴)가 이를 주입한다.

- 발행 대상: `cloudId`, `spaceId`, `parentId`, 페이지 제목 규칙, 작성자/리뷰어 계정 ID, 상태-라벨 값, 필수 리뷰어. 모두 배포·환경별이다.
- **발행 어댑터:** `publicationAdapter.contentFormat` — 작성기의 본문 포맷이며 **기본값은 `"html"`**(이 스킬의 노드 형식이 겨냥하는, 여기서 검증된 경로인 Atlassian MCP HTML+ 작성기)이다. 호출자는 비-HTML+ 작성기를 쓸 때만 이를 오버라이드하며, 그 경우 렌더링 규칙 아래 명시한 어댑터 범위대로 어댑터별 본문/노드 계약을 스스로 소유한다.
- **Mermaid 매크로(선택):** `mermaidMacro` — **대상 사이트에 설치된** Mermaid 다이어그램 마켓플레이스/Forge 앱의 정체성(`extensionKey`와 선택적 `extensionType`/`layout`)이다. `mermaidMacro`**에 더해 호환되는 발행 어댑터**(그 확장 노드를 실어 나를 수 있는 기본 HTML+ 작성기, 또는 호출자가 제공하는 동등한 노드 계약)가 함께 있어야 네이티브 렌더링(아래 모드 A)이 선택된다. 그 조건에 미달하면 강등(모드 B)이 선택된다. 그런 앱이 설치되어 있는지와 그 키는 환경별이므로 호출자가 주입한다. 특정 사이트의 앱 정체성을 이 스킬에 하드코딩하지 않는다.
- **품질 판단:** 미해결 결정, 미충족 요구사항, 누락된 실패 모드에 대한 점검은 상위 설계와 설계 리뷰(`software-design-review` 스킬)가 소유한다. 여기서 판단하지 않고 상위 주석을 **그대로** 옮긴다.

규칙이 충돌하면 **이 스킬은 문서 구조·강등·가독성을 다스리고, 호출자는 발행 대상·계정·명명을 다스린다.**

> **엔진과 스켈레톤을 분리한다.** 이 파일은 입력 수집·렌더링·다이어그램 처리·발행을 소유한다. 이들이 **문서-유형-독립 엔진**을 이루기 때문이다. 변하는 것은 **섹션 스켈레톤**뿐이므로 `skeletons/<type>.md`의 유형별 파일에서 필요할 때 로드한다.

---

## 출력 언어

- 최종 Confluence 페이지는 **한국어로** 작성한다. 생성되는 페이지 제목, 섹션 헤딩, 본문 텍스트, 표, 패널, 다이어그램 캡션, 발행-확인 요약이 모두 포함된다. 호출자가 정확한 페이지 제목을 지정하면 그대로 보존한다.
- 코드 식별자, 파일 경로, API·스키마 이름, 요구사항 ID, 제품명, 인용된 원문은 원형 그대로 보존한다. 그 주변의 설명 산문만 한국어로 번역한다.

---

## 입력 (설계 맥락 수집)

다음 네 가지 출처 중 존재하는 것을 모두 수집·종합한다. 우선순위: ① 상위 설계 산출물(ARCH/DETAIL) > ② 티켓 수용 기준(Jira/ADO) > ③ 사용자 브리프 > ④ 코드/PR(as built).

- **누락된 정보를 지어내지 않는다.** 상위의 `[미결정]`(`undecided`), `[가정]`(`assumption`), 요구사항 ID(`FR-001`/`NFR-001`/`DEC-001`/`DR-NNN`)를 원래 마커 텍스트를 포함해 **정확히** 보존·전달한다.
- 입력으로부터 문서 유형(아키텍처 대 상세)을 추론한다. 추론할 수 없으면 한 번만 물어본다.

---

## 문서 유형과 스켈레톤 (레지스트리; 필요할 때 로드)

1. 입력으로부터 **문서 유형(`<type>`)**을 추론한다. 모르면 한 번만 물어본다.
2. 아래 **스켈레톤 해석 순서**를 따른다. 처음 발견되는 스켈레톤 파일을 읽고 그 섹션 구성과 상대적 비중을 그대로 보존한다. 상단 요약 패널은 모든 유형에 공통이다. 아래 렌더링 규칙을 참조한다.
3. 유형과 무관하게 아래 공유 렌더링·다이어그램-처리·발행 규칙을 적용한다.

### 스켈레톤 해석 순서 (사용자 설정 가능)

사용자는 **문서 유형의 스켈레톤을 오버라이드**할 수 있다. 다음 순서에서 첫 번째 일치를 사용한다.

1. **호출자가 주입한 경로** — 회사 계층의 `~/…/skeletons/<type>.md` 같은, 루틴이나 환경 계층이 이 유형에 대해 주입한 스켈레톤 경로.
2. **사용자 오버라이드** — `~/.claude/confluence-doc/skeletons/<type>.md`가 있으면 사용한다. 사용자는 자동 탐지를 위해 이 위치에 파일을 둘 수 있다.
3. **번들 기본값** — 플러그인 내장 `skeletons/<type>.md`.

어느 것도 없으면 발행하지 않는다. 이 스킬의 공유 원칙을 사용해 최소 구조를 제안하거나, 사용자에게 스켈레톤을 요청한다.

### 번들 기본값 대 사용자 계층

| 문서 유형 | `<type>` | 스켈레톤 출처 |
|---|---|---|
| 설계 문서 (아키텍처/상세) | `design` | **번들 기본값** `skeletons/design.md` (범용) |
| 정의 문서 | `definition` | **사용자/호출자 스켈레톤** (번들 기본값 없음, 조직마다 관례가 다름) |
| 제안서 | `proposal` | **사용자/호출자 스켈레톤** (번들 기본값 없음) |

- **문서 유형을 추가하려면** 위 세 위치 중 한 곳에 스켈레톤 `.md`를 두고 이 표에 행 하나를 추가한다. 엔진은 바꾸지 않는다.
- **스켈레톤 파일이 성글고 빈 섹션을 담고 있으면**, 채워진 섹션은 규칙으로 취급하고 나머지는 공유 원칙(가독성·강등·ID 보존)으로 채운다.
- 상위 방법론과 일치하는 공유 원칙: 다이어그램 화살표에 프로토콜과 목적을 라벨링한다. 대안을 비교하기 전에 결론을 먼저 드러내지 않는다. 정의를 다시 쓰지 않고 앞 섹션을 참조한다. 요구사항 ID(`FR-001`/`NFR-001`/`DEC-001`/`DR-NNN`)를 보존한다.

---

## Confluence 렌더링 규칙 (HTML+)

**어댑터 범위.** 아래 노드 형식(패널, 상태, 결정, 표, 모드 A 확장 노드)은 **HTML+ `data-type` 노드**이므로, 이 스킬은 HTML+ 작성기 — `contentFormat:"html"`을 쓰는 Atlassian MCP `createConfluencePage`/`updateConfluencePage`, 여기서 종단간 검증된 경로 — 를 겨냥한다. 발행 절차는 `publicationAdapter.contentFormat`(기본값 `"html"`)에서 포맷을 읽는다. `data-type` 노드를 실어 나를 수 없는 어댑터(예: 마크다운 전용 작성기)는 이 스킬의 HTML+ 범위 밖이다 — 호출자가 그 어댑터에 맞는 동등한 노드 계약을 제공하거나, 다이어그램 경로가 모드 B로 떨어진다. **레거시 storage XML(`<ac:structured-macro>`)을 쓰지 않는다.** `data-type` 노드만 쓴다.

- **상단 요약** = `<div data-type="panel-info">`. 상태에는 `<span data-type="status" data-color="...">`(검토 중 = 노랑, 승인 = 초록, 초안 = 무채색)를 쓴다. 날짜에는 `<time datetime="YYYY-MM-DD">`를 쓴다. 리뷰어에는 호출자가 제공한 계정으로 `<span data-type="mention" data-user-id="...">`를 쓴다. 관련 문서와 티켓에는 인라인 카드로 `<a href="URL" data-card-appearance="inline">`을 쓴다.
- **경고·제약·실패 모드** = `<div data-type="panel-warning">`.
- **결정과 미해결 결정** = `<ul data-type="decision-list"><li data-type="decision-item" data-state="DECIDED|UNDECIDED">`. ADR의 **대안 비교는 표로** 렌더링한다.
- **표** = 표준 `<table>`. 넓을 때는 `data-layout="wide|full-width"`를 추가한다.
- **코드/ASCII** = `<pre><code class="language-text">`.

### ADF 중첩 제약 (위반 시 발행 검증 실패)

- **패널 안에 표, Expand, 인용, 패널을 넣지 않는다.** 요약 패널과 경고 패널은 상태·멘션·인라인 카드 같은 **문단과 인라인 요소만** 담을 수 있다. 표는 패널 밖의 별도 블록으로 옮긴다.
- **리스트 항목 안에 헤딩, 표, 패널, Expand를 넣지 않는다.**
- 표 셀 안에서는 일반 `<details>`가 아니라 반드시 `<details data-type="nested-expand">`만 쓴다. 중첩 표는 허용되지 않는다.
- 태스크/결정 항목, 헤딩, 캡션은 **인라인 전용**이다.
- `data-user-id`, `data-id` 같은 **불투명 ID는 기존 콘텐츠나 도구 출력에서만 복사한다.** 지어내지 않는다. 새 노드에 `data-local-id`를 추가하지 않는다.

---

## 다이어그램 렌더링 규칙 (Mermaid)

상위 방법론은 Mermaid(C4, 시퀀스, 상태)로 다이어그램을 제공한다. 호출자의 설정에서 경로를 고른다. **`mermaidMacro` + 호환되는 발행 어댑터 ⇒ 네이티브로 렌더링(모드 A), 그렇지 않으면 ⇒ 강등(모드 B).**

### 모드 A — 호출자의 Mermaid 매크로를 통한 네이티브 렌더링 (가능하면 선호)

일부 Confluence 사이트에는 Mermaid 다이어그램 마켓플레이스/Forge 앱(예: "Mermaid Diagrams for Confluence")이 설치되어 있다. 호출자가 `mermaidMacro`를 주입하면 Mermaid 소스를 그 앱의 확장 매크로에 담아 Confluence가 실제 다이어그램으로 렌더링하게 한다.

**어댑터 게이트.** 모드 A는 HTML+ 확장 노드를 방출하므로 HTML+ 작성기(`publicationAdapter.contentFormat:"html"`, 이 사이트에서 종단간 검증된 경로)를 요구한다. `publicationAdapter.contentFormat`이 `"html"`이 아니면(예: adf- 또는 마크다운 전용 작성기), 모드 A는 호출자가 그 어댑터에 맞는 동등한 확장-노드 계약을 주입할 때만 가능하다. 그렇지 않으면 다이어그램은 모드 B로 떨어진다. HTML+ 노드를 비-HTML+ 작성기에 방출하지 않는다.

**매크로 계약(좁게, 보편적이지 않게).** 이 프로필은 `.../static/mermaid-diagram`이 그러듯 소스를 `guestParams.input`의 JSON 문자열로 받는 Mermaid 매크로를 지원한다. 이는 **하나의 특정 앱의 계약이지 일반적인 Forge/마켓플레이스 관례가 아니다.** 호출자의 앱이 다르면, 호출자는 `extensionKey`만이 아니라 `{{input}}` 슬롯이 있는 완전한 노드 템플릿을 주입한다. 이 스킬은 아래의 인코딩만 소유한다.

`mermaidMacro`(호출자 주입): `extensionKey`(설치된 앱의 키, 예: `<APP_ID>/<ENV_ID>/static/mermaid-diagram`), `extensionType`(예: `com.atlassian.ecosystem`), 선택적 `layout`(`wide`/`full-width`). 다이어그램당 노드 하나를 방출한다.

```html
<div data-type="extension"
     data-extension-key="<APP_ID>/<ENV_ID>/static/mermaid-diagram"
     data-extension-type="com.atlassian.ecosystem"
     data-layout="wide"
     data-parameters="<ENCODED_PARAMETERS>"></div>
```

- **`data-type`, `data-extension-key`, `data-extension-type`, `data-parameters`, 선택적 `data-layout`만 작성한다** — HTML+ 작성기가 확장 노드에 대해 문서화한 속성들이다. 그 계약에 따라 새 노드에는 **`data-local-id`를 생략한다**(다른 모든 불투명 ID도 마찬가지다). `localId`는 에디터가 부여하는 노드별 UUID이지 페이지에서 유도되는 값이 **아니다.** `embeddedMacroContext`, `forgeEnvironment`, `extensionId`도 작성하지 않는다. **최소 노드에는 불필요하기 때문이다**(이들 없이 발행한 초안이 정상 렌더링되었고 재조회 시에도 이들을 얻지 않았다). 기존 페이지를 읽을 때 그런 필드가 보이더라도 그것은 **표현 방식에 특유한 읽기-후 메타데이터**이지 필수 입력이 아니다. 특정 앱이 더 많은 것 없이는 끝내 렌더링을 거부한다면, 스킬이 필드를 추측하는 대신 호출자가 **검증된 노드 템플릿**을 주입한다.
- **`data-parameters` 만들기 — 결정적, 두 계층 (순서를 틀리면 이중 인코딩되어 렌더링이 깨진다):**
  1. **JSON 계층.** 객체 `{"layout":"extension","guestParams":{"input":<MERMAID>,"url":""}}`를 만들고 실제 직렬화기(`JSON.stringify`)로 직렬화한다. 수작업 이스케이프는 절대 하지 않는다. 이 단계만으로 소스가 올바르게 처리된다: `"`→`\"`, 줄바꿈→`\n`, `\`→`\\`.
  2. **HTML 속성 계층.** 그 직렬화된 문자열을 속성 값으로 쓰기 위해 HTML-인코드한다. **`&`를 먼저** 바꾸고 나머지를 바꾼다: `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`. `&`를 먼저 하는 것은 필수다. `<`/`>`/`"`를 먼저 인코드하면 `&lt;`/`&quot;` 안의 `&`가 다시 인코드되어 `&amp;lt;`/`&amp;quot;`가 되어버린다.
- **정답 예시.** Mermaid `graph LR` + 줄바꿈 + `  A["X<br>Y"] -->|go| B`를 JSON.stringify한 뒤 속성-인코드하면 다음과 같이 된다.

  ```
  data-parameters="{&quot;layout&quot;:&quot;extension&quot;,&quot;guestParams&quot;:{&quot;input&quot;:&quot;graph LR\n  A[\&quot;X&lt;br&gt;Y\&quot;] --&gt;|go| B&quot;,&quot;url&quot;:&quot;&quot;}}"
  ```

  계층을 읽어보면: 라벨의 따옴표 → `\&quot;`(백슬래시는 JSON에서, `&quot;`는 HTML에서), `<br>` → `&lt;br&gt;`, `-->` → `--&gt;`, 줄바꿈 → `\n`. 이스케이프를 최소화하려면 따옴표나 `<br>`이 없는 라벨을 쓴다.
- **일회성 검증(사이트+앱별로).** 이 최소-노드 경로는 초안에 발행되어 **참조 배포 환경**(HTML+ 작성기와, 소스를 `guestParams.input`에서 읽는 Mermaid 앱)에서 Confluence UI에 렌더링됨이 확인되었다. 구체적인 사이트와 앱 식별자는 환경별이며 호출자의 배포 설정과 검증 기록에 있다 — 이 스킬에는 없다. **다른** 사이트나 앱에서는 네이티브 렌더링을 검증되지 않은 것으로 취급하고, 그 라운드트립을 반복한다. 따옴표·`<br/>`·`&`·줄바꿈을 포함하는 Mermaid로 **초안** 하나를 발행하고 재조회해 렌더링을 확인한다.
- 모드 B의 소스-보존 Expand는 여기서는 **선택 사항**이다(렌더링되고 나면 중복이다). 호출자가 복사-붙여넣기용 유지보수 훅을 원할 때만 추가한다.

### 모드 B — 표/ASCII로 강등 (매크로가 주입되지 않았을 때의 대안)

Confluence는 **그런 앱 없이는 Mermaid를 렌더링할 수 없으며**, draw.io·Gliffy·PlantUML도 유료 매크로다 — **이들이 설치되어 있다고 가정하지 않는다.** `mermaidMacro`가 없으면 대신 무료 네이티브 콘텐츠로 강등한다.

| 소스 (Mermaid) | 본문 렌더링 | 소스 보존 |
|---|---|---|
| flowchart / C4 Container | **컴포넌트 표**(컴포넌트, 단일 책임, 소유 데이터, 의존성) + 선택적 **ASCII 토폴로지** | 아래 Expand |
| sequenceDiagram | **단계 표**(단계, From, To, 프로토콜/메커니즘, 처리/페이로드) | 아래 Expand |
| stateDiagram | **상태-전이 표**(현재 상태, 이벤트, 다음 상태, 가드/부수효과) | 아래 Expand |

**소스를 유지보수 훅으로 보존한다.** 표나 ASCII 바로 아래에 `<details><summary>다이어그램 소스 (무료 draw.io 웹에 붙여넣기: Insert ▸ Advanced ▸ Mermaid로 이미지 생성)</summary><pre><code class="language-text">…원본 Mermaid…</code></pre></details>`를 추가한다. 나중에 사람이 그 텍스트만 추출해 이미지로 렌더링할 수 있다. 최상위 Expand를 쓰고, 표 셀 안에서는 `nested-expand`를 쓴다.

ASCII 토폴로지는 박스-드로잉 문자(`┌ ┐ └ ┘ ─ │`)와 화살표(`▲ ▼ ▶ ◀`)로 만든다. 복잡해지면 ASCII를 생략하고 표만 쓴다.

---

## 발행 절차 (오케스트레이션)

1. **호출자 설정을 받는다.** `cloudId`, `spaceId`(또는 space key), `parentId`, 제목 규칙, 작성자/리뷰어 계정, 상태 라벨. 여기에 `publicationAdapter.contentFormat`(기본값 `"html"`)과 선택적 `mermaidMacro`(`mermaidMacro` + 호환 어댑터 ⇒ 모드 A 네이티브 렌더링, 그렇지 않으면 ⇒ 모드 B 강등)를 더한다. **필수 값이 하나라도 없으면 발행하지 않고 사용자에게 요청한다.** 이들은 환경별 설정이므로 지어내면 안 된다. 호출자가 플랫폼 계층 설정에서 필요할 때 주입한다.
2. space key만 주어졌으면 `getConfluenceSpaces`로 `spaceId`를 확인한다.
3. **발행 전 사람의 확인을 요구한다.** 제목, space, parent, 상태(현재/초안)를 요약하고, 승인 후에만 **발행한다.** 공개 위키 콘텐츠를 만드는 작업이기 때문이다.
4. 새 페이지는 `(cloudId, spaceId, title, parentId, body, contentFormat:publicationAdapter.contentFormat, status)`로 `createConfluencePage`를 호출한다. 갱신은 `(cloudId, pageId, body, contentFormat, versionMessage)`로 `updateConfluencePage`를 호출한다. 이 스킬의 `body` 노드 형식은 `contentFormat:"html"`을 전제한다. 비-HTML+ 포맷은 호출자의 어댑터별 본문을 필요로 한다.
5. 발행 후 **페이지 URL**을 반환한다.

---

## 하지 않을 것

- 설계 내용을 **생성하거나 판단하지 않는다.** 상위가 소유한다. `[미결정]`(`undecided`) 항목을 스스로 채우지 않는다.
- **품질 게이트**를 추가하지 않는다. 이는 사용자 선택 사항이다. 미충족 요구사항이나 누락된 실패 모드를 검증하거나 그것으로 발행을 막지 않는다.
- Confluence **대상, 계정, 명명**을 결정하지 않는다. 이들은 환경별이며 호출자 소유다.
- **사이트의 매크로 정체성을 하드코딩**하거나 Mermaid/draw.io/Gliffy/PlantUML 앱이 설치되어 있다고 가정하지 않는다. 네이티브 Mermaid 매크로는 **호출자가 `mermaidMacro`를 주입했을 때만** 쓴다(모드 A). 그렇지 않으면 강등한다(모드 B). 복사한 cloudId/accountId로 `embeddedMacroContext`를 작성하지 않는다. 이미지 첨부도 기본값이 아니다. 가능하면 매크로를, 아니면 텍스트를 선호한다.

---

## 입출력 계약

- **입력:** 가용한 상위 산출물·브리프·티켓·코드로부터의 설계 맥락 + 대상·명명·계정·상태에 대한 호출자 발행 설정, 그리고 `publicationAdapter.contentFormat`(기본값 `"html"`)과 선택적 `mermaidMacro`.
- **출력:** ① 어댑터-호환 본문(기본 HTML+), ② 승인 후 발행된 페이지 URL, ③ 어느 다이어그램이 네이티브로 렌더링되었는지(모드 A — `mermaidMacro` + 호환 어댑터)와 어느 것이 표/ASCII로 강등되었는지(모드 B), 그리고 각각 보존된 소스가 어디에 있는지를 설명하는 다이어그램 요약.

---

## 확장 노트

렌더링·다이어그램-처리·발행 **엔진은 문서 유형과 무관하다.** 유형이나 스켈레톤을 추가하려면 세 해석 위치 — 호출자 주입, 사용자 오버라이드, 번들 — 중 한 곳에 `.md` 파일을 두고 레지스트리 행 하나를 추가한다. 엔진, 렌더링, 발행 코드는 바꾸지 않는다.

**범용 `design` 스켈레톤만 번들한다.** 정의 문서와 제안서의 관례는 조직마다 크게 다르므로, 그 스켈레톤들은 **사용자/호출자 계층**에 두어 각 사용자가 자신의 하우스 스타일을 적용할 수 있게 한다. 이는 공개 플러그인이 특정 조직의 관례로 오염되는 것을 막는다.
