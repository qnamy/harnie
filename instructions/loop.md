# Harnie Review Loop State Machine (Canonical) — Shared by Quick and Plan

This file is the **single definition** of the review loop and anti-stagnation behavior, and it **owns the review output schema**. Both track skills instruct the model that will use this file — orchestrator, designer, or reviewer — to **Read it directly from its canonical path**, not to have its contents pasted into a delegation prompt. A path reference alone does not guarantee that the model reads it, so each consumer's own entry gate (agent body) or Step 0 (orchestrator) carries the Read instruction, and the consumer names what it read before acting. Agent bodies define stable, single-turn role rules; this file defines multi-step coordination.

## Role Binding: Producer-Neutral
- **Producer:** The author of the artifact, independent of role. The quick and plan skills bind it at each stage:
  - Code review loop → producer = **builder**
  - Design review loop → producer = **designer**
- **Reviewer:** The producer's **opposite provider** (cross-model blind spot). Caller binding: **design loop = Claude producer → Codex reviewer**; **code loop = Codex producer → Claude reviewer**. The reviewer is always read-only.

## Review Output Schema: Owned Here
The reviewer returns one **global VERDICT** and an **issue list**. When there are no issues, return `ISSUES: []`.
```
VERDICT: APPROVE | REJECT
ISSUES:
- [ID] (blocking|non-blocking) (open|resolved) [location] what is wrong → why it matters → fix direction
```
- **ID:** Reuse the same stable ID for the same issue across rounds. Each review-criteria file defines its namespace.
- **Location:** Each review-criteria file defines its location format.
- **Status:** Report `open` or `resolved` as verified in the current response.
- **Severity is fixed for the lifetime of an ID.** Emit the original severity even when reporting the issue as `resolved` — an ID that switches between `blocking` and `non-blocking` is rejected on merge. If the severity assessment itself changed, close the ID as `resolved` and open a new ID at the new severity.
- `code-review.md` and `design-review.md` do not duplicate this schema; they define only their ID namespace and location format.

## Aggregate Issue Ledger: Evidence for the Approval Gate
Approval is computed from the **aggregate issue ledger across all receipts**, not from one response. The **orchestrator skill owns the ledger**.
- A receipt is an aggregate ledger keyed by stable issue ID.
- Every re-review must report `open` or `resolved` for **every previously open issue in the re-review scope**.
- **Omission policy:** A previously open issue omitted from the response remains **open defensively**. Omission does not mean resolution. Record the omission as a **protocol violation** in the receipt.
  - If a **blocking issue** is omitted, or verdict consistency is broken, **request the review again**.
  - If only non-blocking issues are omitted, keep them open in the ledger and continue.
- Add newly discovered issues under new stable IDs.
- After applying the response to the ledger, the orchestrator verifies the verdict from the **number of open blocking issues**.
- **Consistency invariant:** `APPROVE ↔ open blocking = 0`; `REJECT ↔ open blocking ≥ 1`. A response that violates this invariant is invalid and must be requested again.
- **Resolved means verified:** Under the current scope and decisions, the blocking or non-blocking risk no longer applies. Omission or the producer's completion claim is not resolution. If a later delta reintroduces the risk, reopen the **same ID**.

## State Transitions
Determine **progress only after a review result arrives in REVIEWING**. **Every modification must be reviewed.** Guards are mutually exclusive. Compare stagnation against the limit **after incrementing it**; the default limit is 3.
```
REVIEWING ─APPROVE→ APPROVED
REVIEWING ─REJECT (first review)→ REVISING
REVISING  ─submit fix delta→ REVIEWING
REVIEWING ─REJECT + progress→ REVISING (stagnation = 0)
REVIEWING ─REJECT + no progress + (stagnation+1 < limit)→ REVISING (stagnation += 1)
REVIEWING ─REJECT + no progress + (stagnation+1 ≥ limit)→ STALLED (stagnation += 1)
STALLED   ─explicit re-entry assertion→ REVISING (stagnation = 0)
```
- A **round** is one modification followed by its review. **Stagnation** is the number of consecutive no-progress rounds and resets on progress or valid re-entry.
- **Progress** is any one of the following. The orchestrator records the recognized type and supporting evidence in the receipt:
  - ① **New evidence:** Narrows the cause or changes the next decision, including discovery that narrows a previously unknown risk.
  - ② **Artifact improvement:** A measurable improvement against an acceptance criterion or failure gate.
  - ③ **Verification-gate advancement:** After applying the ledger, the **open blocking count decreases**. The parser computes this count; the schema has no severity field. Closing one blocker while creating another leaves the count unchanged and is not gate progress. If the new blocker is not a regression but newly discovered evidence that narrows an unknown risk, the orchestrator may recognize type ① instead and must record its rationale.
  - **Not progress:** Merely changing code, adding logs, changing approaches, rerunning the same check with the same result, or swapping one blocker for another while the count remains unchanged.
- **STALLED latches.** Stop with the evidence, blockers, and unverified scope preserved, then report them to the user. The machine does **not** resume merely because a later review happens to show progress — in particular **③ gate progress does not auto-unlatch STALLED**. Re-entry must be **asserted first**, before any new fix is reviewed.
- **Valid re-entry** is an **explicit, recorded assertion** by the orchestrator (after surfacing to the user), naming exactly one reason: `new-evidence`, `external-state`, `user-decision`, or `scope-change`. `scope-change` may be asserted only after the user approves it. The assertion resets stagnation to 0 and is recorded in the receipt. It is not derived automatically from a subsequent review's outcome. (Mechanism: `review-loop-driver.md` `apply --reentry <reason>`; without it, a STALLED loop returns `needsReentry` and leaves ledger and state unchanged.)

## Re-Review Scope, Diff Attribution, and Read Discipline
- **Re-review scope = open issues + the new fix delta + previously approved areas touched by the new delta.**
- The **orchestrator independently generates the fix delta**; do not rely on the producer's self-report. Capture the real increment from immediately before to immediately after the fix, including new untracked files, deletions, renames, and binaries.
- **Attribution invariant:** The fix delta compares the **whole working tree** (baseline → post), not just the scoped paths, so a **single writer must own the entire capture window** — non-overlapping paths alone are not enough in a shared tree, because a concurrent task's in-flight edits land in the tree snapshot and contaminate this delta (and trip `outOfScope`). Therefore: **truly concurrent producers → isolated worktrees** (each task its own tree); **shared worktree → serialize the producer write-and-capture windows** (task A writes and its delta is captured before task B begins). If an external or concurrent change is detected (`outOfScope` non-empty), do not attribute it to the producer; stop and coordinate.
- Preserve original context in a stateful reviewer session through `codex-reply` or Claude resume. Provide only the incremental fix diff and the surrounding context required for verification.
- **"Do not re-read" means do not re-explore the entire codebase.** The reviewer must still read the changed diff and any necessary surrounding context.
- Never rerun stateless `codex review` inside the iterative loop; repeated full-context reads cause unbounded cost. Use a stateless review only once for optional final sign-off.

## Example: Two Ledger Rounds
Initial review:
```
VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (open) [auth.ts:42] Token expiry is unverified → the expired-token path has no result → add an expiry check
- [CR-002] (non-blocking) (open) [auth.ts:60] Expiry and refresh failures share one metric → operators cannot distinguish causes → use an existing metric dimension if available
```
Ledger: `{CR-001: open/blocking, CR-002: open/non-blocking}`. Open blocking = 1, so REJECT is consistent.

Re-review after fixing only CR-001:
```
VERDICT: REJECT
ISSUES:
- [CR-001] (blocking) (resolved) [auth.ts:42] The expiry check is present
- [CR-003] (blocking) (open) [auth.ts:45] The expiry check does not cover refresh tokens
```
The orchestrator applies the response: CR-001 becomes resolved; CR-002 is omitted, so it remains open and is recorded as a non-blocking protocol violation; CR-003 is added as open and blocking. The open blocking set is `{CR-003}`, still count 1. Because the count is unchanged, this is not type ③ gate progress. The orchestrator must record whether CR-003 is a regression introduced by the CR-001 fix, which means no progress and increments stagnation, or new evidence about a pre-existing refresh path, which may qualify as type ① progress and reset stagnation.

## Invariants
- Preserve a review receipt containing the session, verdict, ledger, progress rationale, and fix summary. The work is not done while any blocking issue remains open.
- The reviewer is the producer's opposite provider to reduce cross-model blind spots.
