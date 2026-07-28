---
name: deploy-approval
description: Review the changes targeted by a deployment approval request, decide whether to approve or hold based on deployment-blocking problems, and recommend advancing workflow state when the approval quorum is met. Use pr-review criteria (blocking means issue-level). The caller records approval signals, counts the quorum, and performs state transitions.
---

# Deployment Approval (Gate Judgment)

For a deployment approval request, **review the targeted changes** and decide whether to approve or hold based on **whether any problem should block deployment**. Make **judgments only**—the caller (platform or routine) records approval signals such as reactions or votes, counts the quorum, and transitions workflow state such as a ticket. Remain company- and platform-neutral.

## Review Criteria (`pr-review`)

The deployment gate considers **blocking problems only**: concerns at the **`issue:` level** in `pr-review`, including correctness, safety, logic errors, and breaking changes. `discuss:` and `nit:` concerns do not block deployment; handle them in a separate review track.

## Core Principles (Safety-Critical)

- **Hold when confidence is low.** An incorrect deployment approval is much worse than a delay.
- **Approve only after review.** Do not approve merely because a request exists.
- **If the target changes cannot be identified, do not approve; hold for manual verification.**
- **Be idempotent:** do not reprocess a request that already has an approval signal or a recorded hold reason.

## Input (Provided by the Caller)

- Approval request plus a way to access the target changes (PR/diff).
- Optional current approval count, quorum threshold, and linked workflow state such as a ticket.

## Decision

1. **Identify the target changes.** If they cannot be identified, **hold** with the reason "target not identified; manual verification required."
2. Review for **`issue:`-level problems** using `pr-review` criteria:
   - Any found → **hold** and summarize the issues.
   - None found → **approve**; the caller records the approval signal.
3. **Check the quorum** using the count supplied by the caller. When approvals ≥ threshold, **recommend advancing workflow state**. Otherwise do not advance and wait for the next approver.
   - If the item is already at or beyond the target state, skip advancement for idempotency. If a direct transition to the target state is unavailable, hold advancement for manual verification.

## Output

For each request, return `approve` (plus a workflow-advancement recommendation when quorum is met) | `hold (+ reason)`. The caller uses this judgment to record the approval signal, count the quorum, transition state, and send any manual-verification notification.

> Apply a narrowed version of `pr-review` judgment for the deployment gate: blocking problems only. This is separate from in-loop development review (`instructions/`).
