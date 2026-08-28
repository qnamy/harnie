---
description: Single development pipeline entry — judges provisional size (S/M) and difficulty, then runs the harnie:dev skill
argument-hint: "<task description>"
---

Task: $ARGUMENTS

You are entering harnie's single development pipeline. The bootstrap hook has already created this run's state (`mode: "sizing"`); its context message names the **run root** — the user's existing git repo root. Use it as `--root` for every `execution.mjs`/`loop.mjs apply` call; it is also the run's single git tree and the builder cwd.

**If the task above is empty, this is a resume, not a new run.** The bootstrap hook reused the active run's recorded base — no new run was created. Do not ask the user for a task description and do not re-judge size or difficulty; both are already recorded. Read the run's remaining blockers (`execution.mjs runs --root <run root>`) and continue from the next incomplete stage per the `harnie:dev` skill's "Resume and runtime handoff" section. If there is no active run, bootstrap has already failed and told you so.

Otherwise, do exactly two judgments, announce them in one line each, then invoke the `harnie:dev` skill with the task unchanged:

1. **Provisional size** — S: localized fix, no design judgment needed. M: design judgment needed, one review unit suffices. **Larger than M** — any ARCH trigger (new component/boundary/data-ownership/technology/SPOF decision) **or** two or more tasks with independent review value — is **not harnie's**: report the handoff to the human + orca process instead of starting a run. This is provisional — the skill confirms it after grounding, and only upward escalation exists.
2. **Run difficulty** — easy/medium/hard/very hard per `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §2 (judged at entry, re-judged at two later checkpoints per §2; selects producer/reviewer models).

When uncertain between sizes, prefer the smaller — escalation is cheap and downward reclassification does not exist. Do not write code or files in this step.
