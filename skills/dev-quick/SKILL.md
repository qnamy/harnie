---
name: dev-quick
description: Orchestrate small tasks such as incidents, localized bug fixes, and minor changes through a lightweight inline flow without skipping stage-by-stage cross-model review (design = Claude production → Codex review; development = Codex production → Claude review). Recommend the full track when new components, boundary/contract changes, or architecture decisions are required. Invoked by `/harnie:dev-quick` or the `/harnie:dev` router.
---

# quick Orchestrator (Class A: Incidents and Small Changes)

You, the main agent, run a lightweight inline flow. There is **no interview, approval gate, plan file, or agent orchestration**. However, **do not abbreviate review**: review the detailed design when one exists and the code with the opposite model at each stage.

## On Every User Message: Reclassify Intent (Do Not Inherit Execution Authority Blindly)

When a new user message arrives, do **not** automatically carry forward the current execution mode. Reclassify it as `replace|add|status|question`. A **status, question, or simple add** does not cancel work already in progress. If the **scope or goal changes**, however—through `replace` or a scope-changing `add`—stop the current run, recompute the target and review scope, and then continue. This resets **message intent and scope**, not execution authority.

## Step 0 — Read the Driver Contract (Required and First)

**Read `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md` now** — the CLI/Codex wiring (R1–R5) you execute directly, in your own context. You do **not** need to preload the schema, review criteria, or authoring-profile documents here: `harnie-designer`, `harnie-reviewer`, and the Codex reviewer/builder each Read their own criteria and profile files directly from the paths you pass them in Steps 3/4/6 below — do not inline those files' contents into delegation prompts. For `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md`, you only need to act on `apply`'s output (`machineState`, `needsReRequest`, `needsReentry`, per `review-loop-driver.md` R4); you do not need to load its full state-machine derivation.

> **Symmetric cross-model review** means each stage is reviewed by the opposite provider: **design** = Claude (`harnie-designer`) produces → **Codex** reviews; **development** = **Codex** builder (Codex MCP, `workspace-write`) produces → **Claude** reviews. Depending on installation, the Codex MCP tool is `mcp__plugin_harnie_codex__codex` or `mcp__codex__codex`; rebuilding and rereview use `*__codex-reply` with a stateful `threadId`. See `review-loop-driver.md` for wiring details.

## State Location

Use `.harnie/quick/<slug>/` as the task root. Store **intermediate artifacts** and review-loop state under `review/<name>/` for `design` and `code`: `design.md` for the design stage, `delta.patch`, `round-N.txt` for raw reviewer receipts, `ledger.json`, and `state.json`. Derive `slug` as a short kebab-case task name. This mirrors plan's `.harnie/plan/<slug>/review/<name>/` and keeps one schema. Development and review stages read these artifacts.

## Flow

### 1. Intent and Size

Restate the task in one line. Confirm it is **truly small**: no new component, boundary or contract change, or architecture decision — these are the ARCH-altitude triggers, and quick supports the DETAIL altitude only (`${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §1). If it is larger, stop and recommend `/harnie:dev-full`.

Then fix the **run difficulty**: if the `/harnie:dev` router already announced easy/medium/hard, inherit it; on direct entry, judge it now with the rubric in `model-matrix.md` §2 and announce it. Judged once, fixed for the run; it selects the **producer** models in Steps 3–4 below (reviewer models are never tiered).

### 2. Read (When Needed)

For unfamiliar code, spawn `harnie-scout` (haiku) in parallel to locate the relevant areas. Skip this for obvious changes.

### 3. Optional Lightweight Detailed Design + Design Review

For non-obvious work, produce a **lightweight detailed design** with producer = Claude `harnie-designer`. The authoring contract is the lightweight profile in `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md`. Main can write it for small work; delegate non-obvious work to `harnie-designer` (model by run difficulty per `model-matrix.md` §3: easy/medium = sonnet, hard = opus — pass it as the Task model override where the installation supports it; otherwise its frontmatter default `opus` applies). When delegating, **pass that file's absolute path** and signal `detailed design, lightweight`; the designer's agent body requires it to Read the profile before writing, so do not paste its contents into the prompt. Quick supports only the **DETAIL altitude** by construction; if the task requires a new component, boundary change, or architecture decision, it should already have been routed to `/harnie:dev-full` in Step 1. Do not ask for "formal" design; lightweight is the default, and depth should converge to a few lines for small changes.

**The design must land at `.harnie/quick/<slug>/review/design/design.md`** as the single source read by Step 4 development and review — when delegating to `harnie-designer`, name that path as the destination and the designer writes it directly (main only verifies the file exists); when main authors inline for small work, main writes it. Then run the **design review loop** to APPROVE following `review-loop-driver.md`: reviewer = Codex (`model:"gpt-5.6-sol"`, fixed — reviewer models are never tiered); criteria = `design-review.md`; detailed-altitude lens; ID namespace `DR`; `<dir>` = `.harnie/quick/<slug>/review/design/`. Do **not** use the R1 git delta because `design.md` is under excluded `.harnie/` and its delta would always be empty. Instead pass the **absolute path** to `design.md` in the reviewer prompt with an instruction to read it before reviewing — the path alone for the first review; the path plus the list of changed section names for rereview — and run R2–R5. Skip all of Step 3 when the task is obvious.

### 4. Write (Development Producer = Codex)

Capture a baseline excluding `.harnie/` first:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/loop.mjs capture <repo>   # → record baselineSHA
```

Then delegate implementation to the **Codex builder** through Codex MCP with `sandbox:"workspace-write"`, `approval-policy:"never"`, `cwd:<repo>`, and the run-difficulty model (`model-matrix.md` §3: easy = `gpt-5.6-luna`, purely mechanical = `gpt-5.3-codex-spark`, medium = `gpt-5.6-terra`, hard = `gpt-5.6-sol`; installation default if model selection is unavailable). Include the task intent and constraints in the prompt plus, when Step 3 ran, the contents of **`review/design/design.md`** so the builder follows the reviewed design — **inline, not as a `.harnie/` path**: the builder's `cwd` is the whole repo, so (as in dev-full's B2) it must not be pointed at `.harnie/`, where authority and review state live. Keep the change **surgical**: preserve existing style and touch only requested scope. Also include the **builder delegation contract** standing rules from `review-loop-driver.md`: baseline-relative test evidence, fail-capability proof for new tests, and a preassigned build-tool cache path when the tool caches under the home directory. Record the threadId; use `codex-reply` for revisions. The code reviewer is Claude, so the builder must be Codex to preserve cross-model review.

### 5. Verify (Self)

Use `verification-tiers.md` to select a tier based on the change's **actual risk**, then run its required verification set. "Compilation passed" is not verification. Report unverified risk honestly.

### 6. Code Review Loop (`review-loop-driver.md`, ID Namespace `CR`, `<dir>` = `.harnie/quick/<slug>/review/code/`)

Run R1–R5 from `review-loop-driver.md`. Producer = **Codex builder**. Reviewer = read-only **`harnie-reviewer` subagent** (model pinned to opus in its frontmatter — quality gates are never tiered), not main inline, so the reviewer is the opposite model and cannot write. Its agent body already instructs it to Read `code-review.md`, `verification-tiers.md`, and `review-schema.md` directly, so delegate through Task with only the delta's path, the previous ledger's path, and a short scope/intent summary. Record the reviewer's `review-schema.md` VERDICT/ISSUES response in `round-N.txt`. Pass **that round's delta `postSHA` through `--artifact` to `apply`**; this is mandatory for CR. Ask the Codex builder for fixes through `codex-reply`. Even for trivial changes, do not abbreviate the stage review; focus on one or two dimensions, correctness and side effects.

### 7. Report

Report the change summary, selected tier, verification set that passed, and review verdict including final ledger and round count. Do not call the work done unless open blocking count is zero. If STALLED, report remaining blockers and unverified scope to the user.

> **Completion footer (required):** End the final response with one machine-readable line. If every code-review dimension is APPROVE and open blocking count is zero, emit `HARNIE_STATUS: COMPLETE`; otherwise emit `HARNIE_STATUS: INCOMPLETE — <remaining blocker summary>`. The quick track has no `execution.json` or mandatory hooks, but shares this footer as the single format for honest reporting.

> The design review in Step 3 and code review in Step 6 use the **same `review-loop-driver.md` loop**. Only the producer (Claude designer ↔ Codex builder), reviewer (Codex ↔ Claude), criteria file (design-review ↔ code-review), namespace (`DR` ↔ `CR`), and state subdirectory differ.
