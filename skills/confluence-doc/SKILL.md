---
name: confluence-doc
description: Structure development documents such as designs, definitions, and proposals into readable Confluence pages, degrade unsupported content (Mermaid → tables/ASCII/Expand), and publish through the Atlassian MCP. Load each document type's section skeleton from the matching file under skeletons/ on demand while using one type-independent engine for input collection, rendering, degradation, and publication. The caller injects publication targets (cloudId, space, parent, naming, accounts, and status labels). Do not generate document content or judge its quality; upstream owns both.
---

# Confluence Development Documentation (Structure · Degrade · Publish)

This skill **does not generate document content.** Upstream architecture and detailed-design methodologies, harnie build steps, tickets, and code own content reasoning. Accept existing context and reorganize it into a Confluence document that other teams can scan at a glance, then publish it.

This skill owns the following concerns and their rationale:

1. **What makes a good Confluence document** — Type-specific skeletons and scanability judgments.
2. **Degradation** — Convert upstream Mermaid and verbose prose into tables, ASCII, and panels that do not break in Confluence.
3. **Publication orchestration** — Call the Atlassian MCP.

This skill does **not** own the following; the caller (platform layer or routine) injects them:

- Publication target: `cloudId`, `spaceId`, `parentId`, page-title rules, author/reviewer account IDs, status-label values, and required reviewers. All are deployment- and environment-specific.
- **Quality judgment:** upstream design and design review (`instructions/design-review.md`) own checks for unresolved decisions, uncovered requirements, and missing failure modes. Do not judge them here; transfer upstream annotations **unchanged**.

When rules conflict, **this skill governs document structure, degradation, and readability; the caller governs publication targets, accounts, and naming.**

> **Separate engine from skeleton:** This file owns input collection, rendering, degradation, and publication because they form a **document-type-independent engine**. Only the **section skeleton** varies, so load it on demand from a type-specific file at `skeletons/<type>.md`.

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
3. Apply the shared rendering, degradation, and publication rules below regardless of type.

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

## Confluence Rendering Rules (HTML+ / ADF)

Call `createConfluencePage`/`updateConfluencePage` with `contentFormat: "html"`. **Do not use legacy storage XML (`<ac:structured-macro>`);** use only `data-type` nodes.

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

## Diagram Degradation Rules (Core: Mermaid → Confluence)

Upstream methodology supplies diagrams in Mermaid (C4, sequence, and state). Confluence **cannot render Mermaid without a paid add-on**. draw.io, Gliffy, and PlantUML are also paid macros, so **do not use any of them**. Degrade to free native content instead:

| Source (Mermaid) | Body rendering | Source preservation |
|---|---|---|
| flowchart / C4 Container | **Component table** (component, single responsibility, owned data, dependencies) + optional **ASCII topology** | Expand below |
| sequenceDiagram | **Step table** (step, From, To, protocol/mechanism, processing/payload) | Expand below |
| stateDiagram | **State-transition table** (current state, event, next state, guard/side effects) | Expand below |

**Preserve source as a maintenance hook:** Immediately below the table or ASCII, add a top-level `<details><summary>Diagram source (paste into free draw.io web: Insert ▸ Advanced ▸ Mermaid to create an image)</summary><pre><code class="language-text">…original Mermaid…</code></pre></details>`. A person can later extract only that text and render it as an image. Use a top-level Expand; inside a table cell use `nested-expand`.

Build ASCII topology with box-drawing characters (`┌ ┐ └ ┘ ─ │`) and arrows (`▲ ▼ ▶ ◀`). If it becomes complex, omit ASCII and use only the table.

---

## Publication Procedure (Orchestration)

1. **Obtain caller configuration:** `cloudId`, `spaceId` (or space key), `parentId`, title rules, author/reviewer accounts, and status label. **If any required value is absent, do not publish; ask the user for it.** These are environment-specific settings and must not be invented. The caller injects them on demand from platform-layer configuration.
2. If only a space key is provided, resolve `spaceId` with `getConfluenceSpaces`.
3. **Require human confirmation before publication.** Summarize the title, space, parent, and status (current/draft), then **publish only after approval** because this creates public wiki content.
4. For a new page, call `createConfluencePage` with `(cloudId, spaceId, title, parentId, body, contentFormat:"html", status)`. For an update, call `updateConfluencePage` with `(cloudId, pageId, body, versionMessage)`.
5. Return the **page URL** after publication.

---

## Do Not

- Do not **generate or judge** design content; upstream owns it. Do not fill `[미결정]` (`undecided`) items yourself.
- Do not add a **quality gate**; this is user-selectable. Do not validate or block on uncovered requirements or missing failure modes.
- Do not decide Confluence **targets, accounts, or naming**; they are environment-specific and caller-owned.
- Do not use **paid macros** such as Mermaid, draw.io, Gliffy, or PlantUML. Image attachments are also not the default; prefer text.

---

## Input/Output Contract

- **Input:** Design context from any available upstream artifact, brief, ticket, or code + caller publication configuration for target, naming, accounts, and status.
- **Output:** ① Confluence HTML+ body, ② published page URL after approval, and ③ degradation summary describing which diagrams became tables/ASCII and which Expand contains each preserved source.

---

## Extension Notes

The rendering, degradation, and publication **engine is independent of document type**. To add a type or skeleton, place a `.md` file in one of the three resolution locations—caller injection, user override, or bundle—and add one registry row. Do not change engine, rendering, or publication code.

**Bundle only the generic `design` skeleton.** Because conventions for definition documents and proposals vary significantly across organizations, keep those skeletons in the **user/caller layer** so each user can apply their own house style. This prevents a public plugin from being contaminated by one organization's conventions.
