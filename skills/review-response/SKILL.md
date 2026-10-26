---
name: review-response
description: For review threads other people left on a PR I authored, judge each finding against the original code as accept, reject, or ask, and draft the reply to post on every thread—a fix reply after the change is pushed, a rejection reason, or a question. The caller retrieves threads, shows the judgment table to the user for one approval, makes the fixes, commits, pushes, and posts the replies. Do NOT use to verify whether an author resolved a finding I raised (that is comment-resolve), to review a change (pr-review), or for review rounds inside the development chain (implementation-review and software-design-review handle their own findings).
---

# Review Response (Author-Side Judgment)

For review threads on a PR **I authored**, decide whether each finding should be reflected, and write the reply each thread will receive. Make **judgments and reply content only**—the caller (platform or session) retrieves threads, gets the user's approval, makes and pushes the fixes, and posts the replies. Remain company- and platform-neutral.

This is the author side of the **"review → author response → resolution"** pipeline. The reviewer verifies the response and resolves the thread with `comment-resolve`; this skill never resolves or closes a thread.

## Input (Provided by the Caller)

- The active threads on my PR whose root was written by someone else. Each item includes the root comment prefix (`issue`/`discuss`/`nit`) when present, its content, location, the full reply history with authors, and a way to access the code at that location.
- Whether the PR was implemented under a design or request contract, and where that contract is.

## Targets

- Only threads whose **latest message is from a reviewer**. A thread whose latest message is mine has already been answered; skip it (idempotency).

## Core Principles

- **Judge by necessity, not by prefix.** Check each finding against the original code before judging it. The prefix is recorded as severity only.
- **Nothing is posted or changed before the user approves the table.** The table carries every reply that will be posted.
- **Do not create new findings** about the PR; that belongs to `pr-review`.

## Decision (Per Thread)

- **`accept`** — leaving it unfixed causes a concrete failure, it names a real defect, or the fix is cheap with clear value. Write the fix direction in one or two lines.
- **`reject`** — it adds a mechanism with no named failure scenario, widens scope, or is a matter of taste. Give the reason with code or contract evidence.
- **`ask`** — the finding's intent or reproduction condition is unclear, so it cannot be judged. Write the question.
- **Contract change needed** — when the PR was built under a contract and the finding asks to change what that contract decided, do not accept or reject it. Mark it for the user to decide.

## Replies

- First output: the judgment table — thread, location, prefix, judgment, evidence, fix direction, and the **reply draft for every thread**.
  - `accept`: what will be changed and how, with a `{commit}` placeholder.
  - `reject`: the reason.
  - `ask`: the question.
  - Contract change needed: no reply; the user decides.
- After the user approves and the caller pushes the fixes, fill only `{commit}` with the actual commit. If the actual fix differs from the approved direction, do not post that thread's reply; return the changed draft for the user to see again.

## Output Language

- Write the judgment table, evidence, and replies **in Korean**.
- Preserve prefixes, code identifiers, file paths, commit identifiers, and quoted source text in their original form.

## Output

First, the judgment table with reply drafts. After the fixes are pushed, the final replies per thread with `{commit}` filled, plus any thread whose draft changed. The caller posts the replies and leaves thread status to the reviewer.

> Distinct from `comment-resolve`: that skill is the reviewer verifying my response; this one is me deciding the response. Fixing the code is the caller's work and follows the caller's development routing.
