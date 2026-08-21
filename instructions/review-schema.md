# Review Output Schema (Canonical Text)

This file holds the **schema text** of the review output contract, extracted from `loop.md` so that reviewers can read exactly this per invocation instead of the full loop state machine (which the orchestrator enacts through `scripts/loop.mjs`, not the reviewer). `loop.md` remains the loop contract — ledger rules, state transitions, progress, re-review scope — and points here for the schema.

The reviewer returns one **global VERDICT** and an **issue list**. When there are no issues, return `ISSUES: []`.

```
VERDICT: APPROVE | REJECT
ISSUES:
- [ID] (blocking|non-blocking) (open|resolved) [location] what is wrong → why it matters → fix direction
```

- **ID:** Reuse the same stable ID for the same issue across rounds. Each review-criteria file defines its namespace (`CR` for code review, `DR` for design review).
- **Location:** Each review-criteria file defines its location format.
- **Status:** Report `open` or `resolved` as verified in the current response.
- **Severity is fixed for the lifetime of an ID.** Emit the original severity even when reporting the issue as `resolved` — an ID that switches between `blocking` and `non-blocking` is rejected on merge. If the severity assessment itself changed, close the ID as `resolved` and open a new ID at the new severity.
- **Consistency invariant:** `APPROVE ↔ open blocking = 0`; `REJECT ↔ open blocking ≥ 1`. The parser enforces this; an inconsistent response is void and wastes a round.
- `code-review.md` and `design-review.md` do not duplicate this schema; they define only their ID namespace and location format.
