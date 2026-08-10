---
name: confluence-doc
description: Structure development documents such as designs, definitions, and proposals into readable Confluence pages, render Mermaid natively through a caller-injected diagram macro when one is available (otherwise degrade it to tables/ASCII/Expand), and publish through the Atlassian MCP. Load each document type's section skeleton from the matching file under skeletons/ on demand while using one type-independent engine for input collection, rendering, diagram handling, and publication. The caller injects publication targets (cloudId, space, parent, naming, accounts, status labels, and the optional Mermaid macro identity). Do not generate document content or judge its quality; upstream owns both.
---

# Confluence Development Documentation (Structure · Degrade · Publish)

This skill **does not generate document content.** Upstream architecture and detailed-design methodologies, harnie build steps, tickets, and code own content reasoning. Accept existing context and reorganize it into a Confluence document that other teams can scan at a glance, then publish it.

This skill owns the following concerns and their rationale:

1. **What makes a good Confluence document** — Type-specific skeletons and scanability judgments.
2. **Diagram handling** — Render upstream Mermaid natively when the caller injects a Mermaid diagram macro; otherwise degrade Mermaid and verbose prose into tables, ASCII, and panels that do not break in Confluence.
3. **Publication orchestration** — Call the Atlassian MCP.

This skill does **not** own the following; the caller (platform layer or routine) injects them:

- Publication target: `cloudId`, `spaceId`, `parentId`, page-title rules, author/reviewer account IDs, status-label values, and required reviewers. All are deployment- and environment-specific.
- **Publication adapter:** `publicationAdapter.contentFormat` — the writer's body format, **default `"html"`** (the Atlassian MCP HTML+ writer this skill's node forms target and the path verified here). The caller overrides it only for a non-HTML+ writer, and then owns the adapter-specific body/node contract (see the adapter scope under Rendering Rules).
- **Mermaid macro (optional):** `mermaidMacro` — the identity of the Mermaid diagram Marketplace/Forge app **installed on the target site** (`extensionKey`, and optional `extensionType`/`layout`). `mermaidMacro` **plus a compatible publication adapter** (one that can carry the extension node — the default HTML+ writer, or a caller-supplied equivalent node contract) selects native rendering (Mode A below); anything short of that selects degradation (Mode B). Whether such an app is installed and its key are environment-specific, so the caller injects them; never hardcode a site's app identity into this skill.
- **Quality judgment:** upstream design and design review (`instructions/design-review.md`) own checks for unresolved decisions, uncovered requirements, and missing failure modes. Do not judge them here; transfer upstream annotations **unchanged**.

When rules conflict, **this skill governs document structure, degradation, and readability; the caller governs publication targets, accounts, and naming.**

> **Separate engine from skeleton:** This file owns input collection, rendering, diagram handling, and publication because they form a **document-type-independent engine**. Only the **section skeleton** varies, so load it on demand from a type-specific file at `skeletons/<type>.md`.

---

## Output Language

- Write the final Confluence page **in Korean**, including the generated page title, section headings, body text, tables, panels, diagram captions, and publication-confirmation summary. If the caller supplies an exact page title, preserve it unchanged.
- Preserve code identifiers, file paths, API and schema names, requirement IDs, product names, and quoted source text in their original form. Translate explanatory prose around them into Korean.

---

## Input (Collect Design Context)

Collect and synthesize whichever of the following four sources exist. Priority: ① upstream design artifacts (ARCH/DETAIL) > ② ticket acceptance criteria (Jira/ADO) > ③ user brief > ④ code/PR (as built).

- **Do not invent missing information.** Preserve and transfer upstream `[미결정]` (`undecided`), `[가정]` (`assumption`), and requirement IDs (`FR-001`/`NFR-001`/`DEC-001`/`DR-NNN`) **exactly**, including the original marker text.
- Infer the document type (architecture vs. detailed) from the input. If it cannot be inferred, ask once.

---

## Document Types and Skeletons (Registry; Load on Demand)

1. Infer the **document type (`<type>`)** from the input; ask once if unknown.
2. Follow the **skeleton resolution order** below. Read the first skeleton file found and preserve its section organization and relative emphasis exactly. The top summary panel is common to all types; see the rendering rules below.
3. Apply the shared rendering, diagram-handling, and publication rules below regardless of type.

### Skeleton Resolution Order (User-Configurable)

Users can **override a document type's skeleton**. Use the first match in this order:

1. **Caller-injected path** — A skeleton path injected for this type by the routine or environment layer, such as a company-layer `~/…/skeletons/<type>.md`.
2. **User override** — `~/.claude/confluence-doc/skeletons/<type>.md`, when present. A user can place a file there for automatic discovery.
3. **Bundled default** — The plugin's built-in `skeletons/<type>.md`.

If none exists, do not publish. Propose a minimal structure using this skill's shared principles, or ask the user for a skeleton.

### Bundled Defaults vs. User Layer

| Document type | `<type>` | Skeleton source |
|---|---|---|
| Design document (architecture/detailed) | `design` | **Bundled default** `skeletons/design.md` (generic) |
| Definition document | `definition` | **User/caller skeleton** (no bundled default; conventions vary by organization) |
| Proposal | `proposal` | **User/caller skeleton** (no bundled default) |

- **To add a document type,** place a skeleton `.md` in one of the three locations above and add one row to this table. Do not change the engine.
- **If the skeleton file is sparse and contains empty sections,** treat populated sections as rules and fill the rest using shared principles: readability, degradation, and ID preservation.
- Shared principles, matching upstream methodology: label diagram arrows with protocol and purpose; do not reveal the conclusion before comparing alternatives; reference earlier sections instead of restating definitions; preserve requirement IDs (`FR-001`/`NFR-001`/`DEC-001`/`DR-NNN`).

---

## Confluence Rendering Rules (HTML+)

**Adapter scope.** The node forms below (panels, status, decisions, tables, and the Mode A extension node) are **HTML+ `data-type` nodes**, so this skill targets an HTML+ writer — the Atlassian MCP `createConfluencePage`/`updateConfluencePage` with `contentFormat:"html"`, the path verified end-to-end here. The publication procedure reads the format from `publicationAdapter.contentFormat` (default `"html"`); an adapter that cannot carry `data-type` nodes (e.g. a markdown-only writer) is out of this skill's HTML+ scope — the caller either supplies an equivalent node contract for that adapter or the diagram path falls to Mode B. **Do not use legacy storage XML (`<ac:structured-macro>`);** use only `data-type` nodes.

- **Top summary** = `<div data-type="panel-info">`. Use `<span data-type="status" data-color="...">` for status (in review = yellow, approved = green, draft = neutral); `<time datetime="YYYY-MM-DD">` for dates; `<span data-type="mention" data-user-id="...">` for reviewers, using accounts provided by the caller; and `<a href="URL" data-card-appearance="inline">` for related documents and tickets as inline cards.
- **Warnings, constraints, and failure modes** = `<div data-type="panel-warning">`.
- **Decisions and open decisions** = `<ul data-type="decision-list"><li data-type="decision-item" data-state="DECIDED|UNDECIDED">`. Render an ADR's **alternatives comparison as a table**.
- **Tables** = Standard `<table>`; add `data-layout="wide|full-width"` when wide.
- **Code/ASCII** = `<pre><code class="language-text">`.

### ADF Nesting Constraints (Violations Fail Publication Validation)

- **Do not put tables, Expands, quotes, or panels inside a panel.** Summary and warning panels may contain **only paragraphs and inline elements** such as status, mentions, and inline cards. Move any table into a separate block outside the panel.
- **Do not put headings, tables, panels, or Expands inside list items.**
- Inside a table cell, use only `<details data-type="nested-expand">`, never a regular `<details>`; nested tables are not allowed.
- Task/decision items, headings, and captions are **inline-only**.
- **Copy opaque IDs** such as `data-user-id` and `data-id` only from existing content or tool output; never invent them. Do not add `data-local-id` to new nodes.

---

## Diagram Rendering Rules (Mermaid)

Upstream methodology supplies diagrams in Mermaid (C4, sequence, and state). Pick the path from the caller's config: **`mermaidMacro` + a compatible publication adapter ⇒ render natively (Mode A); otherwise ⇒ degrade (Mode B).**

### Mode A — Native render via the caller's Mermaid macro (preferred when available)

Some Confluence sites have a Mermaid diagram Marketplace/Forge app installed (for example "Mermaid Diagrams for Confluence"). When the caller injects `mermaidMacro`, embed the Mermaid source in that app's extension macro so Confluence renders it as a real diagram.

**Adapter gate.** Mode A emits the HTML+ extension node, so it requires the HTML+ writer (`publicationAdapter.contentFormat:"html"`) — the path verified end-to-end on this site. If `publicationAdapter.contentFormat` is not `"html"` (e.g. an adf- or markdown-only writer), Mode A is available **only** when the caller injects an equivalent extension-node contract for that adapter; otherwise the diagram falls to Mode B. Do not emit an HTML+ node into a non-HTML+ writer.

**Macro contract (narrow, not universal).** This profile supports a Mermaid macro that takes its source as the JSON string at `guestParams.input`, the way `.../static/mermaid-diagram` does. That is **one specific app's contract, not a general Forge/Marketplace convention.** If the caller's app differs, the caller injects a full node template with an `{{input}}` slot instead of just an `extensionKey`; the skill only owns the encoding below.

`mermaidMacro` (caller-injected): `extensionKey` (installed app's key, e.g. `<APP_ID>/<ENV_ID>/static/mermaid-diagram`), `extensionType` (e.g. `com.atlassian.ecosystem`), optional `layout` (`wide`/`full-width`). Emit one node per diagram:

```html
<div data-type="extension"
     data-extension-key="<APP_ID>/<ENV_ID>/static/mermaid-diagram"
     data-extension-type="com.atlassian.ecosystem"
     data-layout="wide"
     data-parameters="<ENCODED_PARAMETERS>"></div>
```

- **Author only** `data-type`, `data-extension-key`, `data-extension-type`, `data-parameters`, and optional `data-layout` — the attributes the HTML+ writer documents for an extension node. Per that contract, **omit `data-local-id`** (and every other opaque ID) on new nodes; `localId` is a per-node UUID assigned by the editor, **not** derived from the page. Do **not** author `embeddedMacroContext`, `forgeEnvironment`, or `extensionId` either: **they are unnecessary for the minimal node** (a draft published without them rendered correctly and did not gain them on re-fetch), and any such fields seen when reading an existing page are **representation-specific read-back metadata**, not required input. If a particular app ever refuses to render without more, the caller injects a **verified node template** rather than the skill guessing the fields.
- **Building `data-parameters` — deterministic, two layers (getting the order wrong double-encodes and breaks rendering):**
  1. **JSON layer.** Build the object `{"layout":"extension","guestParams":{"input":<MERMAID>,"url":""}}` and serialize it with a real serializer (`JSON.stringify`) — never hand-escape. This alone handles the source correctly: `"`→`\"`, newline→`\n`, `\`→`\\`.
  2. **HTML-attribute layer.** HTML-encode that serialized string for use as an attribute value, replacing **`&` first**, then the rest: `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`. `&`-first is mandatory: encoding `<`/`>`/`"` first would then re-encode the `&` in `&lt;`/`&quot;` into `&amp;lt;`/`&amp;quot;`.
- **Golden example.** Mermaid `graph LR` + newline + `  A["X<br>Y"] -->|go| B`, after JSON.stringify then attribute-encode, yields:

  ```
  data-parameters="{&quot;layout&quot;:&quot;extension&quot;,&quot;guestParams&quot;:{&quot;input&quot;:&quot;graph LR\n  A[\&quot;X&lt;br&gt;Y\&quot;] --&gt;|go| B&quot;,&quot;url&quot;:&quot;&quot;}}"
  ```

  Read the layering: a label quote → `\&quot;` (backslash from JSON, `&quot;` from HTML), `<br>` → `&lt;br&gt;`, `-->` → `--&gt;`, newline → `\n`. Prefer labels without quotes or `<br>` to minimize escaping.
- **One-time verification (per site+app).** This minimal-node path was published to a draft and confirmed to render in the Confluence UI in a **reference deployment** (an HTML+ writer plus a Mermaid app that reads its source from `guestParams.input`). The concrete site and app identifiers are environment-specific and live in the caller's deployment config and verification record — **not** in this skill. For a **different** site or app, treat native render as unproven until you repeat the round-trip: publish one **draft** whose Mermaid exercises quotes, `<br/>`, `&`, and newlines, re-fetch it, and confirm it renders.
- The Mode B source-preservation Expand is **optional** here (redundant once it renders); add it only if the caller wants a copy-paste maintenance hook.

### Mode B — Degrade to tables/ASCII (fallback when no macro is injected)

Confluence **cannot render Mermaid without such an app**, and draw.io, Gliffy, and PlantUML are also paid macros — **do not assume any of them are installed**. When no `mermaidMacro` is available, degrade to free native content instead:

| Source (Mermaid) | Body rendering | Source preservation |
|---|---|---|
| flowchart / C4 Container | **Component table** (component, single responsibility, owned data, dependencies) + optional **ASCII topology** | Expand below |
| sequenceDiagram | **Step table** (step, From, To, protocol/mechanism, processing/payload) | Expand below |
| stateDiagram | **State-transition table** (current state, event, next state, guard/side effects) | Expand below |

**Preserve source as a maintenance hook:** Immediately below the table or ASCII, add a top-level `<details><summary>Diagram source (paste into free draw.io web: Insert ▸ Advanced ▸ Mermaid to create an image)</summary><pre><code class="language-text">…original Mermaid…</code></pre></details>`. A person can later extract only that text and render it as an image. Use a top-level Expand; inside a table cell use `nested-expand`.

Build ASCII topology with box-drawing characters (`┌ ┐ └ ┘ ─ │`) and arrows (`▲ ▼ ▶ ◀`). If it becomes complex, omit ASCII and use only the table.

---

## Publication Procedure (Orchestration)

1. **Obtain caller configuration:** `cloudId`, `spaceId` (or space key), `parentId`, title rules, author/reviewer accounts, and status label — plus `publicationAdapter.contentFormat` (default `"html"`) and the optional `mermaidMacro` (`mermaidMacro` + a compatible adapter ⇒ Mode A native render; otherwise ⇒ Mode B degrade). **If any required value is absent, do not publish; ask the user for it.** These are environment-specific settings and must not be invented. The caller injects them on demand from platform-layer configuration.
2. If only a space key is provided, resolve `spaceId` with `getConfluenceSpaces`.
3. **Require human confirmation before publication.** Summarize the title, space, parent, and status (current/draft), then **publish only after approval** because this creates public wiki content.
4. For a new page, call `createConfluencePage` with `(cloudId, spaceId, title, parentId, body, contentFormat:publicationAdapter.contentFormat, status)`. For an update, call `updateConfluencePage` with `(cloudId, pageId, body, contentFormat, versionMessage)`. The `body` node forms in this skill assume `contentFormat:"html"`; a non-HTML+ format requires the caller's adapter-specific body.
5. Return the **page URL** after publication.

---

## Do Not

- Do not **generate or judge** design content; upstream owns it. Do not fill `[미결정]` (`undecided`) items yourself.
- Do not add a **quality gate**; this is user-selectable. Do not validate or block on uncovered requirements or missing failure modes.
- Do not decide Confluence **targets, accounts, or naming**; they are environment-specific and caller-owned.
- Do not **hardcode a site's macro identity** or assume a Mermaid/draw.io/Gliffy/PlantUML app is installed. Use the native Mermaid macro **only when the caller injects `mermaidMacro`** (Mode A); otherwise degrade (Mode B). Never author `embeddedMacroContext` with a copied cloudId/accountId. Image attachments are also not the default; prefer the macro (when available) or text.

---

## Input/Output Contract

- **Input:** Design context from any available upstream artifact, brief, ticket, or code + caller publication configuration for target, naming, accounts, and status, plus `publicationAdapter.contentFormat` (default `"html"`) and the optional `mermaidMacro`.
- **Output:** ① an adapter-compatible body (default HTML+), ② published page URL after approval, and ③ a diagram summary describing which diagrams rendered natively (Mode A — `mermaidMacro` + a compatible adapter) and which degraded to tables/ASCII (Mode B) and where each preserved source lives.

---

## Extension Notes

The rendering, diagram-handling, and publication **engine is independent of document type**. To add a type or skeleton, place a `.md` file in one of the three resolution locations—caller injection, user override, or bundle—and add one registry row. Do not change engine, rendering, or publication code.

**Bundle only the generic `design` skeleton.** Because conventions for definition documents and proposals vary significantly across organizations, keep those skeletons in the **user/caller layer** so each user can apply their own house style. This prevents a public plugin from being contaminated by one organization's conventions.
