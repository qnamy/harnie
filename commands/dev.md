---
description: Cross-model build/review loop router that classifies task size and automatically selects the quick or plan track
argument-hint: "<task description>"
---

Task: $ARGUMENTS

You are the harnie router. Classify the task's **size and risk** and select a track. Classification is a judgment-only step: do not write code or create files.

## Classification
- **quick track**: Incident fixes, small changes, and localized bug fixes. No new component or module, no boundary or contract change, and no architecture decision required.
- **plan track**: New features or modules, changes across multiple boundaries or contracts, decisions about data ownership or technology selection, or an explicit request for "design."
- When uncertain, favor the **larger plan track**. Catching design errors before implementation is central to harnie.

## Actions
1. Restate the task in one line and announce **the selected track and why**.
2. Explain the override path: "To force a different track, use `/harnie:dev-quick` or `/harnie:dev-full`."
3. **Resolve the target repo (multi-repo entry).** If the current working directory is not itself a git repository — for example a parent workspace folder containing several repos (like `~/Tradlinx`) — do not guess a target:
   - List the immediate child directories (depth 1–2) that are git repositories.
   - Present that list with `AskUserQuestion` and let the user pick exactly one.
   - `cd` into the chosen repo, so the working directory for every subsequent tool call — including the track skill invocation in step 4 — is inside that repo.
   - If no git repos are found, or none of them fit, report that and stop.
   - If the working directory is already a git repository, skip this step.
   This resolves **one** target repo for this session; a cross-repo single run is a non-goal — see "Working across repos" below for when a *different* repo also needs work. (This resolution step is router-only: entering directly through `/harnie:dev-full` or `/harnie:dev-quick` skips it, so direct entry still requires the working directory to already be a git repo.)
4. Without waiting for a user response, immediately invoke the selected track skill:
   - quick → `dev-quick` skill
   - plan → `dev-full` skill
   Pass the task argument through unchanged so the skill can orchestrate it.

## Run model (worktree-per-run)
Every `dev-full` (plan track) run gets its own dedicated git worktree — this is what lets several runs proceed concurrently in the same repo. `dev-quick` does not use a dedicated worktree; the rest of this section applies to `dev-full` only.

When the `dev-full` bootstrap succeeds, the bootstrap hook reports the run's absolute **workroot** — a dedicated worktree path, not the directory you started in — through the hook's context message. From that point on:
- Use the reported workroot as `--root` for every `execution.mjs`/`loop.mjs` call in this run, and as `cwd` for every Codex builder call. During planning, writing source files at the directory you started in instead of the workroot is still denied by the pre-approval write guard, just like a misplaced write inside the workroot. Only a genuinely outside-the-repo absolute path, such as a scratchpad note, is ungated.
- If that message becomes unavailable later in the conversation, recover the path by reading the `workroot` field from `<repo>/.harnie/sessions/<this session's id>.json`.
- **One session = one run** (v1, fixed): this session stays bound to exactly one run's workroot for its lifetime. If this same session later asks to bootstrap a genuinely different task, bootstrap rejects it with guidance to start a new session — don't retry it in a loop.

## Working across repos
If, while working a run in repo A, it becomes clear that a *different* repo (B) also needs attention: do not try to start a second run in this session — one session is bound to one run, and this session is already bound to repo A's worktree. Instead:
1. Compose a short, self-contained prompt describing the task for repo B, including whatever context from this conversation is needed to act on it without further back-and-forth.
2. Present it to the user as a command they can run in a **new session** whose working directory is repo B — for example `/harnie:dev <task for repo B>`.
3. Continue this session's work in repo A unaffected; do not wait for the other session.
