---
description: Resume or take over an existing harnie run in this tree — lists resumable runs and hands the selected one over. Creates no new run.
argument-hint: ""
---

You are resuming an existing harnie run. **Never create a run here** — this command has no bootstrap hook behind it and `init` is not part of this path.

If the tree has exactly one active run and you only want to continue it, stop and use `/harnie:dev` with no task arguments instead: bootstrap reuses the base recorded in `active.json` and takes you straight back into the pipeline. This command is for the rest — a run that went inactive, a takeover from Codex, or a tree with more than one resumable run.

1. **List.** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/execution.mjs runs --root <run root>`. The run root is the git repo root you are working in. Runs whose completion was already pinned to disk (`closedAt`) do not appear, and abandoned runs are not scanned.
2. **Present.** Show the user every returned run with its `slug`, `mode`, `active` flag, and `blockers[]` verbatim. Do not judge which one they meant. If the list is empty, report that and stop.
3. **Ask.** Use AskUserQuestion to let the user pick one slug. One run, one choice — harnie does not run two at once.
4. **Hand over.** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/execution.mjs handoff --root <run root> --slug <slug>`. It switches `active.json`, clears the runtime-bound state (one-shot approval/rebind files, builder thread ids), and re-anchors the watchdog clock. Cumulative counters are deliberately not reset.
5. **Read the drift report.** `handoff` returns `drift[]` — review units whose approved tree no longer matches the current one, with the changed files. If it is non-empty, present the file list to the user and ask whether those edits belong to this run. Only an answer of "unrelated" opens `rebind-tree` (see `skills/dev/SKILL.md` and `instructions/loop.md`); an overlap with the review scope is rejected by that command and the only way out is re-review.
6. **Continue.** Resume the pipeline from the run's next incomplete stage per `${CLAUDE_PLUGIN_ROOT}/skills/dev/SKILL.md` — read its "Resume and runtime handoff" section for the stage contract. Do not re-run stages the run's state already shows as complete.
