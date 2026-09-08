# Skeleton — Design Document (Architecture / Detailed)

This is the **design-document section skeleton** loaded by the `confluence-doc` engine. The skill body (`SKILL.md`) owns rendering, diagram handling, and publication rules. This file defines **only section structure and relative emphasis**.

Render the final Confluence document **in Korean**. The English labels and prose in this skeleton describe structure only; translate generated section headings, labels, tables, panels, and explanatory text into Korean while preserving identifiers and quoted source text.

## Emphasis by Document Type (Variable Depth)

Use one skeleton, but concentrate detail differently by document type.

- **Architecture design document** → Focus on §3 and §4 (structure and key decisions); keep §5 shallow.
- **Detailed design document** → Focus on §5 and §6 (contracts and failure handling); keep §3 brief and reference-oriented.

Do not fill every section evenly. Concentrate detail in the three to five areas with the greatest risk or cost of change, and keep the rest intentionally brief.

## Section Skeleton

```
[Top summary panel]  ← For other teams (PM, QA, FE) that will not scroll. panel-info. (Shared; see SKILL.md rendering rules)
  Status · Author · Reviewers · Due date | Audience | One-line purpose | TL;DR (three key conclusions) | Related links
1. Overview             — Background and purpose, scope (In-Scope / Out-of-Scope), non-goals
2. Requirements         — FR/NFR (preserve IDs; include only quantified NFRs) · table
3. Architecture and Data Flow — Component table + data-flow step table (+ ASCII topology when useful)
4. Key Decisions and Tradeoffs — Context · decision · alternatives comparison table · impact · revisit conditions
5. Data Model and API/Event Contracts — Tables. If a machine-readable schema exists, reference only its path and ID as the "single source of truth for the contract"
6. Constraints, Failure Modes, and Exception Handling — Edge cases · retry/DLQ · what other teams must know  ← panel-warning
7. Risks and Open Decisions — [미결정] (`undecided`) · decision deadline (decision-list)
```

## Rationale for Sections (Reference Mapping)

- **Top summary panel** ← Google Technical Writing (put audience, scope, and key conclusions first) + Atlassian DACI (put status, owner, deadline, and outcome at the top). Other departments do not read to the bottom.
- **§4 Key Decisions and Tradeoffs** ← AWS ADR (context → decision → consequences, considered alternatives, and revisit conditions). Do not signal the conclusion before comparing alternatives.
- **Separate document types (design/definition/proposal)** ← GitLab's principle of separating documentation types. This is why skeletons are split by type.

## Mapping Notes (Upstream Methodology → This Skeleton)

Fold the output of the upstream `software-design` skill (대상·범위·비범위 / 결정 / 변경 대상 / 데이터·상태 / 실패 동작 / 검증 / 가정·미결정 / 대안 비교) into the seven sections above, by concept:

- 1절 대상·범위·비범위 → top summary panel + §1
- The requirements file the design cites (기능 요구·품질 제약) → §2. The design does not restate requirements, so take them from that file; without one, from the request the design names
- 3절 변경 대상 (files, interfaces, what must not be touched) → §3
- 2절 결정 + 8절 대안 비교 → §4
- 4절 데이터·상태 → §5
- 5절 실패 동작 + 6절 검증 → §6. Carry the verification as its own table — command · pass condition · what must stay intact — so the reader can see how completion is observed
- 7절 가정·미결정 → §7 (`[가정]` as assumptions, `[미결정]` as `undecided` with decider and blocked scope)

Handle upstream **Mermaid diagrams (C4 Container, sequence, and state)** per the diagram-rendering rules in `SKILL.md`: render natively when a Mermaid macro **and** a compatible publication adapter are available (Mode A), otherwise degrade to tables/ASCII plus preserved source in an Expand (Mode B).
