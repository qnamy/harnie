---
description: Single development pipeline entry — judges provisional size (S/M/L) and difficulty, then runs the harnie:dev skill
argument-hint: "<task description>"
---

Task: $ARGUMENTS

You are entering harnie's single development pipeline (0.11 — the quick/full tracks are retired into one skill). The bootstrap hook has already created this run's worktree and state (`mode: "sizing"`); its context message names the **workroot** — use it as `--root` for every `execution.mjs`/`loop.mjs apply` call. In a single-repo run it is also the git tree (and the S/M builder cwd); in a **workspace run** (multi-repo — always size L) it is a plain state directory only. Which git tree each operation targets (member workroots for integration/capture, per-task worktrees for L builders) is defined by the skill and `stages/large.md` — do not decide it here.

Do exactly two judgments, announce them in one line each, then invoke the `harnie:dev` skill with the task unchanged:

1. **Provisional size** — S: localized fix, no design judgment needed. M: design judgment needed, one review unit suffices. L: any ARCH trigger (new component/boundary/data-ownership/technology/SPOF decision) **or** two or more tasks with independent review value. This is provisional — the skill confirms it after grounding, and only upward escalation exists.
2. **Run difficulty** — easy/medium/hard/very hard per `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §2 (judged at entry, re-judged at two later checkpoints per §2; selects producer/reviewer models).

When uncertain between sizes, prefer the smaller — escalation is cheap and downward reclassification does not exist. Do not write code or files in this step.
