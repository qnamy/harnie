---
name: cross-review
description: Run a cross-model review loop (producer and reviewer from different providers, reviewer read-only, approval computed from a ledger) over a code delta or a design document — in a plain session outside any pipeline, or from inside the harnie:dev M pipeline. Thin wrapper — it assembles instructions/loop.md, review-schema.md, review-loop-driver.md, the criteria files, and model-matrix.md by reference and restates none of them.
---

# Cross-Model Review (Thin Wrapper)

This skill owns **no review contract of its own**. It exists so the cross-model review loop can be run from any session — not only from inside a pipeline — while the contract stays single-sourced. If this file ever appears to disagree with the documents below, they win. Read them; do not copy their content here or into the conversation.

`<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`.

| What you need | Canonical file |
|---|---|
| Loop contract — ledger, state transitions, progress, contest gate, re-review scope, invariants | `<ROOT>/instructions/loop.md` |
| Output schema the reviewer returns | `<ROOT>/instructions/review-schema.md` |
| Deterministic wiring — capture/delta, reviewer invocation, receipt, `apply`, sign-off | `<ROOT>/instructions/review-loop-driver.md` (R1–R5) |
| Criteria — code loop (`CR`) | `<ROOT>/instructions/code-review.md` |
| Criteria — design loop (`DR`), with the altitude lens | `<ROOT>/instructions/design-review.md` |
| Reviewer tier per difficulty, and the provider mapping | `<ROOT>/instructions/model-matrix.md` §3 |
| Finding acceptance — necessity, not severity | `<ROOT>/instructions/loop.md` § "Finding acceptance" |

## Two call sites, one contract

1. **Human-driven** — you are working in a plain session (no `harnie:dev` run) and want the produced artifact reviewed by the opposite provider before it is called done. This skill is the entry point.
2. **Pipeline-internal** — `harnie:dev` (M) calls the same contract at its design and code review stages. `skills/dev/SKILL.md` adds only the run-specific bindings (unit directories, seal windows, the `dr:` artifact hash, completion authority); the review contract itself is this one.

Both must resolve to the same documents. That is the point of the skill: if the M pipeline is ever dismantled, the review loop survives here unchanged.

## Procedure

1. **Name the loop.** Code delta → `CR` namespace, criteria `code-review.md`. Design document → `DR` namespace, criteria `design-review.md`, and state the altitude (ARCH / TASK-DETAIL — `model-matrix.md` §1) in the reviewer call.
2. **Pick the reviewer.** Opposite provider from the producer: Claude produced → Codex reviews (`sandbox:"read-only"`); Codex produced → Claude reviews (`harnie-reviewer` subagent). The reviewer never writes. Tier from `model-matrix.md` §3. The single sanctioned same-provider case is `dev-solo`, which substitutes a fresh context-isolated `codex exec --sandbox read-only` subprocess — see `skills/dev-solo/SKILL.md`; do not invent other exceptions.
3. **Run the rounds.** `review-loop-driver.md` R1–R5, as written.
4. **Decide each finding**, and close the loop, by `loop.md` — its "Finding acceptance" section for accept/reject, its contest gate for a blocking finding you reject, its ledger rules and invariants for when the work is done.

## Standalone notes (call site 1)

- The review unit's directory is `<repo>/.harnie/review/<unit>/` in the repo being reviewed. Pass that same repo as `apply --root` and as the positional repo of `capture`/`delta`; the CLI enforces containment and rejects paths outside it. R1's `capture --record <dir>` works unchanged here — a record directory under the positional repo's own `.harnie` needs no run sentinel — so the baseline receipt is kept standalone too, exactly as R1 requires.
- **DR artifact outside a run**: there is no `planHash` and no approval to bind to, which is the condition `review-loop-driver.md` R4 already names for pre-approval design loops — so its content-alone `dr:` hash is the applicable rule. The `content ‖ planHash ‖ m-plan` form is specific to M's post-approval design loop and has no standalone counterpart.
- The Bash guard denies any command mentioning `.harnie` that is not a sanctioned CLI invocation — a single plain `node <ROOT>/scripts/{loop,execution,worktree}.mjs …` with no shell metacharacters, `<ROOT>` being the loaded plugin's own path. Write `round-N.txt` with the Write tool, not with shell redirection; `ledger.json`/`state.json` are control files no tool may write directly.
- No run state, no approval gate, and no completion CLI are involved outside a run; the ledger is the whole authority. Do not simulate the pipeline's other machinery here.

## NEVER

- Let the reviewer share the producer's provider (except `dev-solo` as above), or let any reviewer write files.
- Merge ledgers, close IDs, or declare a verdict by hand — `loop.mjs apply` decides state.
- Copy the contract text out of the files above into this skill, a prompt, or a run artifact. Pass paths.
