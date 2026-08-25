# Model Matrix (Canonical) — Design Altitude, Run Difficulty, and Model Assignment

Owns three decisions for the `harnie:dev` pipeline: ① the design-altitude boundary, ② the run-difficulty rubric (judged once per run), ③ the model each stage derives from them. Call sites restate concrete names for convenience; on conflict this file wins.

## 1. Design Altitude (three layers, never mixed in one document or loop)

- **ARCH** — boundaries, new components, data ownership, technology selection, cross-module/repo contracts, SPOF/scaling decisions. Produced only in the L stage's architecture step (formal profile `design-authoring-arch.md`); its trigger checklist also drives S/M/L escalation to L.
- **CONTRACT** — task decomposition + inter-task contracts (`design-authoring-contract.md`), L only; the approval-gate artifact.
- **TASK-DETAIL** — implementation design inside settled boundaries (`design-authoring-detail.md`): each L task's design (by its runner) and M's single design.

## 2. Run Difficulty — judged once, run-wide

Judge **easy / medium / hard** once (at entry, alongside the provisional size) and keep it fixed; re-judge only on a user scope change. Size (S/M/L) and difficulty are independent axes.

- **easy** — localized change, known pattern, no new logic design. *Mechanical subtype:* rename/mirror/repetitive edits needing no judgment.
- **medium** — multi-file, new logic within existing patterns, moderate blast radius.
- **hard** — new module or complex logic; concurrency/security/data-integrity concerns; high blast radius or costly rollback.

Difficulty tiers producer models and, conservatively, the Claude code reviewer. Review gates never drop below sonnet; the top tier is kept where a miss is most expensive.

## 3. Model Assignment

**Producers (by difficulty):**

| Producer role | easy | medium | hard |
|---|---|---|---|
| Codex builder (all sizes) | `gpt-5.6-luna` — `gpt-5.3-codex-spark` when purely mechanical | `gpt-5.6-terra` | `gpt-5.6-sol` |
| Claude designer, TASK-DETAIL (M inline/designer; L runner-authored) | sonnet | sonnet | opus |
| Claude designer, CONTRACT (L) | sonnet | sonnet | opus |
| Claude designer, ARCH (L, when triggered) | **fable** | **fable** | **fable** (fallback opus, noted in the plan) |

**Reviewers (never below sonnet):**

| Reviewer role | easy | medium | hard |
|---|---|---|---|
| Code unit reviews (S/M inline loop; L runner inline) | sonnet | opus | opus |
| Confirmation reviews (post-merge re-check of already-gated code) | sonnet | sonnet | opus |
| Final Review (L, single unit — last line of defense) | **opus** | **opus** | **opus** |
| Design reviewer (Codex, all `DR` loops) | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` |

**Fixed:** `harnie-scout` = haiku (frontmatter-pinned).

**dev-solo (Codex-standalone) inversion:** the producer is Codex at every stage, so the reviewer is Claude via `claude -p --model <tier>` — **design reviews (all altitudes) = opus, provisional** (same rationale as the fixed Codex design reviewer: small volume, costliest defect class; to be confirmed or re-tiered from the first solo run's cost measurement — open item U-3 in design-0.11-detail.md); **code reviews = the code-reviewer rows above**. The self-review fallback runs `codex exec -m gpt-5.6-sol`.

**Mechanics:** Codex models via the `codex` call's `model` param (`codex-reply` keeps the thread's); Claude subagent tiers via the Task model override where supported (frontmatter `opus` is the fallback). The orchestrator/session model is not assigned here — every quality-bearing role is pinned independently, so **sonnet is sufficient and recommended as the session model** (measured runs put the orchestrator's own calls at well over half of total tokens — the single largest cost lever).
