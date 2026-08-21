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
- The track boundary is the **design altitude** (`${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §1): any ARCH-altitude trigger — a new component/module, a boundary or contract change, a data-ownership or technology decision — belongs to the plan track; the quick track handles DETAIL-altitude design only.

## Run Difficulty (judged once, alongside the track)
Alongside the track, judge the run's difficulty — **easy / medium / hard** — using the rubric in `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §2. Track and difficulty are independent axes: a quick-track bugfix can be medium. This judgment happens **once**, here; the track skill inherits it (announced in Action 1) instead of re-judging, and it selects **producer** models (Codex builder, designer) and the conservatively tiered code-reviewer model for the whole run per `model-matrix.md` §3 (Final Wave gates and design review stay top-tier).

## Actions
1. Restate the task in one line and announce **the selected track, the run difficulty (easy/medium/hard), and why**.
2. Explain the override path: "To force a different track, use `/harnie:dev-quick` or `/harnie:dev-full`."
3. **Resolve the execution root (workspace entry).** If the current working directory is not itself a git repository — for example a parent workspace folder containing several repos (like `~/Tradlinx`) — the resolution depends on the selected track:
   - **plan track:** stay at the workspace directory and proceed — `dev-full` supports a **workspace run**: a single run spanning multiple repos, with a dedicated worktree created inside each involved repo (see "Run model" below). Do not `cd` into one repo and do not ask the user to pick one; the repos actually involved are determined during planning and registered with `execution.mjs repo-add`.
   - **quick track:** a quick run works inside one repo. List the immediate child directories (depth 1–2) that are git repositories, present them with `AskUserQuestion`, let the user pick exactly one, and `cd` into it before invoking the track skill in step 4.
   - If the directory is neither a git repo nor a workspace containing git repos, report that and stop (the bootstrap hook fails closed there as well).
   - If the working directory is already a git repository, skip this step.
4. Without waiting for a user response, immediately invoke the selected track skill:
   - quick → `dev-quick` skill
   - plan → `dev-full` skill
   Pass the task argument through unchanged so the skill can orchestrate it.

## Run model (worktree-per-run)
Every `dev-full` (plan track) run gets its own dedicated git worktree — this is what lets several runs proceed concurrently in the same repo. `dev-quick` does not use a dedicated worktree; the rest of this section applies to `dev-full` only.

**Workspace runs (multi-repo).** When `dev-full` starts from a non-git workspace directory, the bootstrap hook instead creates a **plain run-state directory** at `<workspace>/.harnie-wt/harnie-<slug>/` and reports it as the workroot, flagged as a WORKSPACE run. The workspace root itself never gets an `active.json`, so other sessions and other work in the workspace are never gated by this run. Each repo the task modifies is registered during planning with `node <scripts>/execution.mjs repo-add --root <workroot> --repo <absolute repo path>` — this creates that repo's dedicated worktree (`<repo>/.harnie-wt/harnie-<slug>`) and records it in the run state. Every manifest task then carries `"repo": "<key>"`, and that task's scope, verification, builder cwd, and capture/delta all use that repo's worktree. The hook's context message restates these rules.

When the `dev-full` bootstrap succeeds, the bootstrap hook reports the run's absolute **workroot** — a dedicated worktree path, not the directory you started in — through the hook's context message. From that point on:
- Use the reported workroot as `--root` for every `execution.mjs`/`loop.mjs` call in this run, and as `cwd` for every Codex builder call. During planning, writing source files at the directory you started in instead of the workroot is still denied by the pre-approval write guard, just like a misplaced write inside the workroot. Only a genuinely outside-the-repo absolute path, such as a scratchpad note, is ungated.
- If that message becomes unavailable later in the conversation, recover the path by reading the `workroot` field from `<repo>/.harnie/sessions/<this session's id>.json`.
- **One session = one run** (v1, fixed): this session stays bound to exactly one run's workroot for its lifetime. If this same session later asks to bootstrap a genuinely different task, bootstrap rejects it with guidance to start a new session — don't retry it in a loop.

## Working across repos
A task that is known upfront to span multiple repos should enter as a **workspace run**: start the session at the parent workspace directory and use the plan track (see step 3 and "Run model" above).

If, while working a **single-repo** run in repo A, it becomes clear that a *different* repo (B) also needs attention: do not try to start a second run in this session — one session is bound to one run, and this session is already bound to repo A's worktree. Instead:
1. Compose a short, self-contained prompt describing the task for repo B, including whatever context from this conversation is needed to act on it without further back-and-forth.
2. Present it to the user as a command they can run in a **new session** — either at repo B, or at the workspace directory if the follow-up itself spans repos — for example `/harnie:dev <task for repo B>`.
3. Continue this session's work in repo A unaffected; do not wait for the other session.
(A workspace run that discovers a new repo mid-run is different: register that repo with `repo-add` before the approval gate; after approval, adding a repo requires plan revision and re-approval.)
