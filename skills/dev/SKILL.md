---
name: dev
description: harnie's single development pipeline — requirements grounding → approval → design → build → cross-model review → verification, with stages skipped by size (S/M). Work above M is handed off to the human + orca process. Invoked by `/harnie:dev`.
---

# dev Orchestrator — Single Pipeline, Size-Gated Stages

You (main) orchestrate one run end to end. **The review contract is not defined here**: this pipeline is one of the two call sites of `${CLAUDE_PLUGIN_ROOT}/skills/cross-review/SKILL.md` — **Read it now (Step 0)** and follow it (it points to `loop.md`, `review-schema.md`, `review-loop-driver.md`, the criteria files, and `model-matrix.md`). This file adds only the run-specific bindings below. In this pipeline the producer/reviewer pairing that skill enforces resolves to **design = Claude produces → Codex reviews; code = Codex produces → Claude reviews** (dev-solo is the one exception — see `dev-solo/SKILL.md`). The bootstrap hook already created this run (workroot in its context message; recover via `<main repo>/.harnie/sessions/<session>.json`); confirm `.harnie/active.json` exists — if absent, STOP and report (never self-init).

## Size (S/M) — provisional → confirmed, upward-only; no exit above M

The entry command judged a provisional size; **if you entered without it** (direct skill invocation), make the two judgments from `commands/dev.md` (provisional size + run difficulty) now. After grounding, **confirm the size** with `node <ROOT>/scripts/execution.mjs set-mode --root <repo> --slug <slug> --mode <S|M>` (upward transitions only; `sizing` blocks source writes conservatively). A run assumes **a single git tree** and completion fail-closes otherwise.

**Above M there is no upward exit inside harnie.** When an L trigger appears — an ARCH trigger (new component/boundary/data-ownership/technology/SPOF decision), or two or more tasks with independent review value — **stop and hand the job to the human + orca process** (decomposition, dispatch, and integration are theirs, not harnie's). Report what you found, what the decomposition looks like, and where the current tree stands; do not escalate the mode (`set-mode --mode L` is rejected by the engine). Mid-S escalation to **M** is unchanged: escalate immediately and run the skipped stages; existing agent changes since the pre-builder baseline are captured as a delta and attached to the approval as prior work, included in the first review unit on approve; a dirty tree you don't own is handed to the user, never auto-reverted.

- **S** — localized fix: grounding → baseline capture → build → tier verification → code review loop → report. No approval gate, no manifest.
- **M** — one review unit with design judgment: grounding → lightweight plan (approach + single-task manifest `t1`/`code`, scope tests, `integrationVerification`, `gates: []`, human-verification items) → **approval** → TASK-DETAIL design + design review → `set-task --task t1 --run-status building` (enables builder thread binding + watchdog) → baseline/seal → build → code review loop → `verify --task t1` → `verify --integration` → report.
- **Difficulty re-judgment**: two checkpoints (right after grounding; right before the approval gate for M, right before the build call for S) drive escalation (automatic + one-line notice) or de-escalation (needs `AskUserQuestion`); record with `execution.mjs set-difficulty --root <repo> --slug <slug> --difficulty <easy|medium|hard|very-hard>` — for M, sync into `plan.md` before arming too (see `model-matrix.md` §2).

## MUST

- **Grounding before questions**: spawn `harnie-scout` (T1; T2 when the exploration needs semantic or structural judgment — `model-matrix.md` §3) in parallel for anything unfamiliar; decide from files, not assumptions. Ask the user only what evidence cannot settle (product intent, materially different interpretations, costly-if-wrong guesses, external context) — ≤3 questions per round, each with evidence, options, impact, and your recommended default; record adopted defaults as assumptions in the plan.
- **Every modification is reviewed**, through the `cross-review` skill — including finding acceptance and the contest gate. Run-specific binding: apply round N (`committed: true`) before any next producer call, and never let a run stage substitute its own review path.
- **Delegation by disk paths of record only** — criteria/profiles/designs are paths the delegate Reads; never inline their contents, never pass tool-result blob paths. Exception: the builder gets the design **content** inlined (never a `.harnie` path) plus the `builder-contract.md` path.
- **Verification split**: human-check items are listed upfront in the plan and handed over as a checklist (`verification-tiers.md`); automated evidence goes through `verify` receipts. Tests at the unit stage are **scope tests only**; the full suite runs as `verify --integration` (M) — exactly one passing receipt bound to the final tree; a no-change rerun is refused by the engine.
- **Context budget**: propose a session split after ~3–4 completed review units (mechanical backstop: `sessionSplitRecommended`); inject only the sections a decision needs; batch independent tool calls; notify (e.g. `PushNotification`) before blocking on any user gate. `notepad.md` is append-only, single-writer (you), reusable knowledge only.
- **Honest completion**: end the final response with `HARNIE_STATUS: COMPLETE` or `INCOMPLETE — <blockers>`; completion authority is `execution.mjs completion` (S: unit APPROVED + tree binding; M: full derivation). List `needs-human-verification: N` when the checklist is unconfirmed.
- On a new user message, reclassify intent (`replace|add|status|question`); only a scope/goal change stops execution for recomputation and re-approval.

## NEVER

- Write source before approval (M; `sizing` included) — H1 enforces this; work with it.
- Run full test suites at the unit stage, or re-run an unchanged verification.
- Merge ledgers, close IDs, or declare verdicts by hand; self-approve; unlatch STALLED without a user-surfaced `--reentry`.
- Let the reviewer share the producer's provider (dev-solo is the exception — see `dev-solo/SKILL.md`), or let any reviewer write.
- Build schedulers, dependency engines, retries-with-backoff, or any execution infrastructure the docs don't define — if a guard denies something unexpectedly, STOP and report, never work around.
- Bash anything referencing `.harnie` except the sanctioned CLIs; hand-edit control files.

## Approval gate (M)

`plan.md` carries the ` ```harnie-manifest ` block. Before arming, prove every `verification[]`/`integrationVerification[]` entry exercises something (read-only proof or enumerated inputs; timeouts are **milliseconds**, write them out; silent-success tools declare `evidencePolicy: "exit-code-only"`; cold starts go in `setup`). Then `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "<label>"` and **immediately** ask via AskUserQuestion whose approve option's **selected value exactly equals that armed label** (default `승인` when the flag is omitted — the armed label and the question option must match verbatim; one-shot binding: first question after arming; one arm/pending run-wide). Post-approval manifest changes only via the re-approval path (A5.2-equivalent: fix the block, re-arm, re-ask).

## S/M flow notes

- Capture the pre-builder baseline (`loop.mjs capture <repo> --record …`) **always** — it anchors deltas and any escalation.
- **Seal around every run-root producer window**: `execution.mjs seal` immediately before each builder call (after `set-task`/baseline), `seal-verify` immediately after its output and before delta attribution — exit 3 = the builder touched authority files, void the round.
- Builder delegation and stalled-dispatch/fail-fast rules: `review-loop-driver.md`. S's implicit task is `t1` (set-mode registers it; builder cwd = workroot).
- M's design step: producer = `harnie-designer` (or you inline for small work) writing to `.harnie/plan/<slug>/review/design/design.md`; the review itself is the `cross-review` skill's DR loop. Run-specific binding: the post-approval `dr:` artifact hashes design content ‖ planHash ‖ `m-plan` (driver R4). A defect found in the approved design after approval has one path: A5.2 re-approval (fix the block, re-arm, re-ask), which changes `planHash` and thereby invalidates the stale design approval.
- Code review: the `cross-review` skill's CR loop, with the review-unit directory `.harnie/plan/<slug>/review/<unit>/` as its state location. S focuses on correctness and side effects — still never skipped.
