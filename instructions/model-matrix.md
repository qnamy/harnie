# Model Matrix (Canonical) — Design Altitude, Run Difficulty, and Model Assignment

Owns three decisions for the `harnie:dev` pipeline: ① the design-altitude boundary, ② the run-difficulty rubric (judged at entry, re-judged at two later checkpoints — §2), ③ the model each stage derives from them. Call sites restate concrete names for convenience; on conflict this file wins.

## 1. Design Altitude (two layers, never mixed in one document or loop)

- **ARCH** — boundaries, new components, data ownership, technology selection, cross-module/repo contracts, SPOF/scaling decisions (formal profile `design-authoring-arch.md`). Produced by the standalone `design-authoring` skill, outside any run; its trigger checklist is also what tells `harnie:dev` a job is **larger than M** and belongs to the human + orca process.
- **TASK-DETAIL** — implementation design inside settled boundaries (`design-authoring-detail.md`): M's single design, and any standalone detailed design.

## 2. Run Difficulty — judged at entry, re-judged at two checkpoints

Judge **easy / medium / hard / very hard** at entry, alongside the provisional size. Re-judge at two later checkpoints: ① right after grounding — new evidence may reveal a different blast radius than the entry guess; ② for M, right before the approval gate; for S (no approval gate), right before the build call — the last "cheap to change" boundary before that size starts writing source. Size (S/M) and difficulty are independent axes.

- **easy** — localized change, known pattern, no new logic design. *Mechanical subtype:* rename/mirror/repetitive edits needing no judgment.
- **medium** — multi-file, new logic within existing patterns, moderate blast radius.
- **hard** — new module or complex logic; concurrency/security/data-integrity concerns; high blast radius or costly rollback.
- **very hard** — hard's concerns at a scale where hard's own model tier and watchdog budget are judged insufficient (e.g. a cross-cutting engine change with unusually wide blast radius, or a defect class this run has already shown is expensive to catch late). Escalate here only with a stated reason — for M, in the plan; for S (no plan document), the required one-line user notice below is the reason record. Not a default for "large-looking" work.

**Escalation** (to a harder tier) at either checkpoint is automatic: state it to the user in one line, and record it with `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>` (wire value uses a hyphen — `very-hard`, not the prose `very hard` above; `validateManifest`/`set-difficulty` reject anything else). It applies only to subsequent stages — including the watchdog budget tier: `resolveTaskDifficulty()` re-reads `execution.json`/`manifest.json` from disk on every call (not a cached value), and `decideWatchdog()` looks up `guards.mjs`'s `WATCHDOG_TIERS` (a static table) by whatever difficulty string it's handed — so no separate wiring is needed once the recorded value changes. This means a post-approval re-judgment (the "After approval, `set-difficulty` is the sole record" case above) takes effect on a task's watchdog budget immediately, including one already `building` — a downward change can shrink `maxCodexCalls`/wall-clock below a count the task has already used, causing its next builder call to `deny` right away (advisory; recoverable via `watchdog-extend`, but not a silent no-op). Escalation itself is never retroactive on the model tier: a review unit already APPROVED before the checkpoint keeps the model tier it was reviewed under — only the watchdog budget (not the model) can shift under a running task.

**De-escalation** (to an easier tier) is never automatic — it requires an explicit `AskUserQuestion` confirmation before the recorded difficulty changes, because a wrong downgrade silently lowers the model/watchdog tier of every subsequent stage.

`set-difficulty` writes only `execution.json`'s `difficulty` field — never `manifest.json` (whose `difficulty`, once approved, is frozen into the `planHash`). `taskWatchdogUsage` reads `execution.json.difficulty` first and falls back to the approved `manifest.json.difficulty` for runs that never re-judged. **For M, both checkpoints fall before A5 approval — before arming, sync any re-judged value into `plan.md` itself** (the difficulty line and the `harnie-manifest` block's `"difficulty"` field) so the manifest that gets sealed matches what the user actually approves; `set-difficulty` alone is not enough pre-approval, since arm-approval reads `plan.md`, not `execution.json`. After approval, `set-difficulty` is the sole record for any further re-judgment (`plan.md` is never re-edited post-approval — that would desync `planHash`). Difficulty tiers producer models and, conservatively, the Claude code reviewer. Review gates never drop below sonnet; the top tier is kept where a miss is most expensive.

## 3. Model Assignment

**This file solely owns the tier → (Claude model, Codex model) mapping.** Agent bodies (`agents/*.md`) and skill bodies (`skills/*/SKILL.md`) name **tier symbols T1–T4 only**, never a concrete model name, so replacing a model generation is a one-file edit here. The one exception is an agent's frontmatter `model:` field — that is the Claude dispatch adapter, not prose, and takes a concrete name.

| Tier | Claude | Codex |
|---|---|---|
| T1 | haiku | `gpt-5.6-luna` (`gpt-5.3-codex-spark` when purely mechanical) |
| T2 | sonnet | `gpt-5.6-terra` |
| T3 | opus | `gpt-5.6-sol` |
| T4 | fable (fallback: opus at effort high) | `gpt-5.6-sol` at effort high |

The role tables below stay in concrete names — they are this file's own mapping surface.

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

**Exploration (`harnie-scout`):** default **T1**; **T2** when the exploration needs semantic or structural judgment (what a boundary means, which of several patterns a file follows). The axis is judgment density, not how much there is to search. The frontmatter model pin is removed, so the caller picks the tier per call.

**Effort-override footnote (VERIFIED 2026-08-26):** Codex MCP call sites can set call-scoped reasoning effort with `config: {model_reasoning_effort: "high"}`; a typo in the exact `model_reasoning_effort` key is silently ignored by Codex, so its spelling matters. Claude subagents dispatched through the Agent tool have no effort field (confirmed absent), so those call sites can only use model-tier upgrades for the very-hard tier, never an effort override. Verification source: `~/Tradlinx/task2-recovery/effort-e2e.md`.

**dev-solo (Codex-standalone):** the producer is Codex at every stage, and so is the reviewer — a **fresh `codex exec --sandbox read-only -m gpt-5.6-sol` self-review subprocess** (effort high only at `very-hard`) is the entire review path for both design and code reviews, at every altitude; there is no cross-model reviewer to fall back to. This is not a degraded fallback: dev-solo exists so development can continue Codex-standalone when Claude usage/tokens are exhausted, and in that scenario a cross-model reviewer is unavailable by construction — an accepted, documented tradeoff (see `skills/dev-solo/SKILL.md`).

**Mechanics:** Codex models via the `codex` call's `model` param (`codex-reply` keeps the thread's); Claude subagent tiers via the Task model override where supported (frontmatter `opus` is the fallback). The orchestrator/session model is not assigned here — every quality-bearing role is pinned independently, so **sonnet is sufficient and recommended as the session model** (measured runs put the orchestrator's own calls at well over half of total tokens — the single largest cost lever).
