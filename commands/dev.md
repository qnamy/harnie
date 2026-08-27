---
description: Single development pipeline entry — judges provisional size (S/M) and difficulty, then runs the harnie:dev skill
argument-hint: "<task description>"
---

Task: $ARGUMENTS

You are entering harnie's single development pipeline. The bootstrap hook has already created this run's worktree and state (`mode: "sizing"`); its context message names the **workroot** — use it as `--root` for every `execution.mjs`/`loop.mjs apply` call, and it is also the run's single git tree (and the builder cwd).

Do exactly two judgments, announce them in one line each, then invoke the `harnie:dev` skill with the task unchanged:

1. **Provisional size** — S: localized fix, no design judgment needed. M: design judgment needed, one review unit suffices. **Larger than M** — any ARCH trigger (new component/boundary/data-ownership/technology/SPOF decision) **or** two or more tasks with independent review value — is **not harnie's**: report the handoff to the human + orca process instead of starting a run. This is provisional — the skill confirms it after grounding, and only upward escalation exists.
2. **Run difficulty** — easy/medium/hard/very hard per `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §2 (judged at entry, re-judged at two later checkpoints per §2; selects producer/reviewer models).

When uncertain between sizes, prefer the smaller — escalation is cheap and downward reclassification does not exist. Do not write code or files in this step.
