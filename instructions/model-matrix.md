# Model Matrix (Canonical) — Design Altitude, Run Difficulty, and Model Assignment

Owns three decisions for the `harnie:dev` pipeline: ① the design-altitude boundary, ② the run-difficulty rubric (judged at entry, re-judged at two later checkpoints — §2), ③ the model each stage derives from them. Call sites restate concrete names for convenience; on conflict this file wins.

## 1. Design Altitude (two layers, never mixed in one document or loop)

- **ARCH** — boundaries, new components, data ownership, technology selection, cross-module/repo contracts, SPOF/scaling decisions (formal profile `design-authoring-arch.md`). Produced by the standalone `design-authoring` skill, outside any run; its trigger checklist is also what tells `harnie:dev` a job is **larger than M** and belongs to the human + orca process.
- **TASK-DETAIL** — implementation design inside settled boundaries (`design-authoring-detail.md`): M's single design, and any standalone detailed design.

## 2. Run Difficulty — judged at entry, re-judged at two checkpoints

Judge **easy / medium / hard / very hard** at entry, alongside the provisional size. Re-judge twice: ① right after grounding; ② for M, right before the approval gate — for S (no approval gate), right before the build call. Size (S/M) and difficulty are independent axes.

- **easy** — localized change, known pattern, no new logic design. *Mechanical subtype:* rename/mirror/repetitive edits needing no judgment.
- **medium** — multi-file, new logic within existing patterns, moderate blast radius.
- **hard** — new module or complex logic; concurrency/security/data-integrity concerns; high blast radius or costly rollback.
- **very hard** — hard's concerns at a scale where hard's own model tier and watchdog budget are judged insufficient. Escalate here only with a stated reason — for M, in the plan; for S, the one-line user notice below is the reason record. Not a default for "large-looking" work.

**MUST**

- Escalating to a harder tier: state it to the user in one line, then record it with `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>` (wire value is hyphenated — `very-hard`; anything else is rejected).
- For M, both checkpoints fall before A5 approval: sync a re-judged value into `plan.md` itself (difficulty line + the `harnie-manifest` block's `"difficulty"`) **before arming** — `set-difficulty` alone does not bind pre-approval.

**NEVER**

- Never de-escalate to an easier tier without an explicit `AskUserQuestion` confirmation — a wrong downgrade silently lowers the model and watchdog tier of every later stage.
- Never re-edit `plan.md` after approval (it desyncs `planHash`); post-approval, `set-difficulty` is the sole record.
- Never apply a re-judgment retroactively to a review unit already APPROVED — it keeps the tier it was reviewed under.

Difficulty tiers producer models and, conservatively, the Claude code reviewer; review gates never drop below sonnet. **Engine wiring** for the above (which file each command writes, watchdog re-read semantics, the immediate effect of a downward change on a running task) lives in `docs/execution-state.md` §12.

## 3. Model Assignment

**This file solely owns the tier → (Claude model, Codex model) mapping.** Agent bodies (`agents/*.md`) and skill bodies (`skills/*/SKILL.md`) name **tier symbols T1–T4 only**, never a concrete model name, so replacing a model generation is a one-file edit here. The one exception is an agent's frontmatter `model:` field — that is the Claude dispatch adapter, not prose, and takes a concrete name.

| Tier | Claude | Codex |
|---|---|---|
| T1 | haiku | `gpt-5.6-luna` (`gpt-5.3-codex-spark` when purely mechanical) |
| T2 | sonnet | `gpt-5.6-terra` |
| T3 | opus | `gpt-5.6-sol` |
| T4 | fable (fallback: opus at effort high) | `gpt-5.6-sol` at effort high |

**Producers (by difficulty):**

| Producer role | easy | medium | hard | very hard |
|---|---|---|---|---|
| Codex builder (all sizes) | `gpt-5.6-luna` — `gpt-5.3-codex-spark` when purely mechanical | `gpt-5.6-terra` | `gpt-5.6-sol` | `gpt-5.6-sol` (effort high) |
| Claude designer, TASK-DETAIL (M inline/designer; standalone detailed design) | sonnet | sonnet | opus | opus (effort high) |
| Claude designer, ARCH (standalone `design-authoring`) | opus | opus | opus (effort high) | **fable** (fallback opus, effort high — noted in the plan) |

**Reviewers (never below sonnet):**

| Reviewer role | easy | medium | hard | very hard |
|---|---|---|---|---|
| Code unit reviews (S/M inline loop) | sonnet | opus | opus | opus (effort high) |
| Confirmation reviews (post-merge re-check of already-gated code) | sonnet | sonnet | opus | opus |
| Design reviewer (Codex, all `DR` loops) | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` (effort high) |

**Exploration (`harnie-scout`):** default **T1**; **T2** when the exploration needs semantic or structural judgment. The axis is judgment density, not how much there is to search — the caller picks the tier per call.

**Effort override:** available on Codex call sites only (`config: {model_reasoning_effort: "high"}`); Claude subagents have no effort field, so a Claude very-hard tier is expressed as a model upgrade. Measurement and the silent-typo caveat: `docs/codex-mechanisms.md`.

**dev-solo (Codex-standalone):** producer and reviewer are both Codex — a native subagent spawned with `fork_turns: "none"` and `model: gpt-5.6-sol` (`reasoning_effort: "high"` only at `very-hard`) is the entire review path at every altitude. Rationale for having no cross-model reviewer, and why the subagent replaced the former `codex exec --sandbox read-only` subprocess: `skills/dev-solo/SKILL.md`.

**Mechanics:** Codex models via the `codex` call's `model` param (`codex-reply` keeps the thread's); Claude subagent tiers via the Task model override where supported (frontmatter `opus` is the fallback). The orchestrator/session model is not assigned here — every quality-bearing role is pinned independently, so **sonnet is sufficient and recommended as the session model**.
