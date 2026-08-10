---
name: comment-resolve
description: Verify whether an author's response to a review finding (a reply or a code change without a reply) actually resolves a thread I started, then recommend whether to resolve it and whether to revote. Follow pr-review for resolution criteria and unblocking conditions. The caller performs scanning, retrieval, resolution, voting, and platform API calls.
---

# Comment Resolution (Verification Judgment)

For **unresolved threads** among the review findings I started, verify whether the author's response **actually resolves** the finding and decide whether to resolve, keep open, or take no action. Make **judgments only**—the caller (platform or routine) handles target scanning, retrieval, resolution, voting, follow-up replies, platform APIs, and work-list management. Remain company- and platform-neutral.

This is not a new review. It is the resolution stage of the **"review → author response → resolution"** pipeline. **Do not create new review findings**; that belongs to `pr-review`.

## Resolution Criteria (`pr-review` Unblocking Conditions)

- **`issue:`** — Resolve through a fix or a rebuttal that can be verified in the code.
- **`discuss:`** — Resolve through an answer or conclusion; a code change is not required.
- **`nit:`** — Optional; implementation is not mandatory.

## Core Principles (Safety-Critical)

- **Resolve only after verification.** Do not close a thread merely because someone claims it was fixed or because a push occurred. Inspect the code, explanation, or follow-up action.
- Judge **only threads I started**. Do not touch other reviewers' threads.
- **Default to no action when uncertain.** If anything remains unclear, keep the thread open.
- **Be idempotent:** do not reprocess items that already received a resolution or keep-open response.

## Input (Provided by the Caller)

- My unresolved thread list. Each item includes the root comment prefix (`issue`/`discuss`/`nit`), content, location, latest response and responder, and a way to access the before/after diff.
- Context: **active** | **merged**.

## Decision Paths

### Path A — The Author Replied (Latest Response Is from the Author)

- **Claims a code fix** → Verify it in the latest changes.
- **Claims a documentation/explanation update** → Inspect the relevant artifact.
- **Provides an explanation only (no code needed)** → Decide whether the explanation adequately addresses the finding.
- **Merged context:** a claimed code fix usually points to separate follow-up work → Verify the explanation and follow-up handling.

Decision: confirmed resolution → **recommend resolve** / insufficient or inappropriate response → **keep open + recommend a follow-up question** / ambiguous → **keep open (request confirmation)**.

### Path B — Code Changed Without a Reply (Active Only)

The latest response may be absent because the author pushed code without text. Classify whether a decision is possible using the **prefix**; do not reinterpret the reviewer's stated intent.

- **Gate:** consider Path B only when a change after my last comment **actually touches the file named in my finding**. Otherwise skip it and wait for the author.
- **`issue:`** → A decision is possible. If the changed code **clearly** resolves the finding, record the evidence and **recommend resolve**. If unresolved, partial, or ambiguous, take **no action** and wait for another change.
- **`discuss:`** → A decision is not possible from code alone because intent, domain context, or runtime evidence is required. Take **no action**, wait for a reply, and do not add a new follow-up comment.

## Revote Recommendation (Active Only; Executed by the Caller)

Recommend a revote only when a thread state actually changed in this run:

- No unresolved `issue:` or `discuss:` remains → **recommend approval**.
- An unresolved `issue:` or `discuss:` remains → **hold; do not change the vote**.
- Only unresolved `nit:` threads remain → **recommend conditional approval**.

Do **not vote** in merged context; it has no effect.

## Output Language

- Write all human-readable judgments, reasons, evidence summaries, follow-up question recommendations, and revote recommendations **in Korean**.
- Preserve machine-readable status values, code identifiers, file paths, API names, and quoted source text in their original form.

## Output

For each thread, return `resolve` | `keep open (+ reason)` | `no action`, plus a revote recommendation when the context is active. The caller uses this judgment to perform the actual resolution, follow-up reply, vote, and platform calls.

> This is distinct from `pr-review`: `pr-review` evaluates new changes and identifies problems; `comment-resolve` verifies whether a response has resolved a reported problem. It is also distinct from in-loop development review (REJECT bias, `instructions/`).
