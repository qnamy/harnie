# Model Matrix (Canonical) — Design Altitude, Run Difficulty, and Model Assignment

This file owns three decisions shared by `/harnie:dev`, `dev-quick`, and `dev-full`: ① the **design-altitude** boundary (architecture vs detailed), ② the **run-difficulty** rubric (judged once per run), and ③ the **model assignment** each stage derives from them. Call sites restate the concrete model names for convenience; on any conflict, this file wins.

## 1. Design Altitude — Architecture vs Detailed (Fixed Boundary)

Two altitudes, never mixed in one document or one review loop:

- **ARCH (architecture design):** system boundaries, new components/modules/services, data ownership and storage choices, technology selection, cross-module or cross-repo contracts, SPOF/scaling/availability decisions. Produced only in **dev-full A3** (formal profile, `design-authoring-arch.md`) and reviewed with the architecture-altitude lens of `design-review.md` under `review/design-arch/`.
- **DETAIL (detailed design):** implementation design inside settled boundaries — a specific module, API, DB schema, or processing logic; requirement traceability; work breakdown. Produced in **dev-full A4** (formal profile) or **dev-quick Step 3** (lightweight profile, both from `design-authoring-detail.md`) and reviewed with the detailed-altitude lens under `review/design-detail/` (full) or `review/design/` (quick).

Routing consequences:

- Any ARCH-altitude trigger (the A3 trigger checklist in `phases/phase-a.md`) routes the task to the **plan track**. `dev-quick` supports the DETAIL altitude only, by construction.
- Inside dev-full, A3 runs **only** when an ARCH trigger is actually present; otherwise skip straight to A4. An unsupported formal architecture stage is scope inflation.

## 2. Run Difficulty — Judged Once, Run-Wide

Judge **easy / medium / hard** exactly once per run, then keep it fixed:

- Via the `/harnie:dev` router: the router judges difficulty during classification and announces it together with the track.
- Direct entry (`/harnie:dev-quick`, `/harnie:dev-full`): the track skill judges it at its first step (quick Step 1 / full A0) and announces it. dev-full also records it in `plan.md`.
- The track skill inherits the router's judgment rather than re-judging. Re-judge only when the user changes the scope or goal (a `replace` or scope-changing `add`), together with the scope recomputation those already require.

Track and difficulty are **independent axes**: a quick-track bugfix can be medium; a full-track run can be medium rather than hard.

Rubric (pick the highest tier any signal justifies):

- **easy** — localized change in one module or a few files; a known pattern applies; no new logic design. *Mechanical subtype:* rename, mirror translation, or repetitive edits requiring no judgment.
- **medium** — multi-file change; new logic within existing patterns; some judgment calls; moderate blast radius.
- **hard** — new module or complex logic; concurrency, security, or data-integrity concerns; many open design decisions; high blast radius or costly rollback.

Difficulty tiers **producer models only**. **Reviewer models are never tiered** — reviews are quality gates, and lowering a gate's model weakens exactly what it exists to catch.

## 3. Model Assignment

**Producers (tiered by run difficulty):**

| Producer role | easy | medium | hard |
|---|---|---|---|
| Codex builder (quick Step 4; full B2/B2′) | `gpt-5.6-luna` — or `gpt-5.3-codex-spark` when the work is purely mechanical | `gpt-5.6-terra` | `gpt-5.6-sol` |
| Claude designer, DETAIL altitude (`harnie-designer`: quick Step 3; full A4) | sonnet | sonnet | opus |
| Claude designer, ARCH altitude (full A3 only) | **fable** | **fable** | **fable** |

> ARCH-altitude design always uses the top tier (fable) regardless of run difficulty: A3 exists precisely for the highest-cost decisions in the system, and a run that triggers A3 at all has already crossed that cost line.

**Fixed roles (never tiered):**

| Role | Model |
|---|---|
| Design reviewer (Codex, `DR` loops) | `gpt-5.6-sol` |
| Code reviewer (`harnie-reviewer`, `CR` loops incl. Final Wave) | opus (pinned in agent frontmatter) |
| Scout (`harnie-scout`) | haiku (pinned in agent frontmatter) |

**Selection mechanics and fallbacks:**

- **Codex models:** set the `model` parameter on the Codex MCP `codex` call (`codex-reply` continues the thread's model). If the installation does not expose model selection, the installation default applies — do not fail the stage over it.
- **Claude subagent models:** `harnie-reviewer` and `harnie-scout` are pinned by agent frontmatter. For `harnie-designer` (frontmatter default `opus`), pass the tier's model as the Task-call model override where the installation supports it; where it does not, the frontmatter default applies.
- **fable fallback:** if this installation cannot select fable for a subagent, use `opus` for A3 and note the substitution in `plan.md`.
