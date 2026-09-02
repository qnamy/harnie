# Harnie Review Loop State Machine (Canonical)

Single definition of the review loop: ledger rules, state transitions, progress, the contest gate, and re-review scope. The output schema lives in `review-schema.md` (reviewers read only that). The orchestrator enacts this contract through `scripts/loop.mjs` — never by hand.

## Roles

- **Producer** = the artifact's author: designer (Claude) in design loops, builder (Codex) in code loops.
- **Reviewer** = the producer's **opposite provider**, always read-only, in `harnie:dev`. Design = Codex reviews; code = Claude reviews. **dev-solo is the exception**: producer and reviewer are both Codex — a native Codex subagent spawned with `fork_turns: "none"` substitutes for the cross-provider reviewer (see `skills/dev-solo/SKILL.md`).

## Ledger (approval evidence)

Approval is computed from the aggregate issue ledger across all receipts, never from one response.

- Every re-review reports `open` or `resolved` for **every previously open issue in scope**. Omission ≠ resolution: omitted issues stay open defensively (omitted **blocking** issue or broken verdict consistency → re-request the review; omitted non-blocking → record a protocol violation and continue).
- **Consistency invariant**: `APPROVE ↔ open blocking = 0`; `REJECT ↔ open blocking ≥ 1`. Violations void the response.
- **Resolved means verified** under current scope and decisions — not claimed, not omitted. A later delta that reintroduces the risk reopens the **same ID**.
- **An ID is scoped to the ledger it was opened in.** A Final-gate ID is never a task-unit ID and vice versa; a finding "carried to unit X" is opened fresh in X's own ledger, never assumed to exist there.

## State transitions (limit default 3)

```
REVIEWING ─APPROVE→ APPROVED
REVIEWING ─REJECT(first review)→ REVISING
REVISING  ─submit fix delta→ REVIEWING
REVIEWING ─REJECT+progress→ REVISING (stagnation=0)
REVIEWING ─REJECT+no progress+(stagnation+1<limit)→ REVISING (stagnation+=1)
REVIEWING ─REJECT+no progress+(stagnation+1≥limit)→ STALLED
STALLED   ─explicit re-entry assertion→ REVISING (stagnation=0)
```

**Progress** (recorded with evidence in the receipt): ① new evidence that narrows the cause or changes the next decision; ② measurable artifact improvement; ③ open-blocking count decreases (computed by the parser). Merely changing code, re-running an unchanged check, or swapping one blocker for another is not progress.

**STALLED latches.** Report evidence, blockers, and unverified scope to the user; resume only via `apply --reentry <new-evidence|external-state|user-decision|scope-change>` asserted after surfacing (scope-change needs user approval). Later gate progress never auto-unlatches.

## Contest gate (0.11) — rejecting a finding without implementing it

For an open **blocking** finding the producer side believes is wrong, the orchestrator may **contest instead of fix**, on exactly two grounds:

- `altitude` — the demand is outside the current review altitude (ARCH / TASK-DETAIL / code).
- `overengineering` — it can only be satisfied by adding a mechanism, and the reviewer named no concrete mistake scenario it prevents.

Contract:

1. Pass a `CONTEST [ID] reason=<altitude|overengineering> : <2–3 sentence grounds>` block in the next reviewer call — no artifact change for that ID. Multiple IDs may be contested in one round.
2. **The reviewer's next response settles it**: concede → report the ID `resolved` (optionally opening a new non-blocking ID); insist → keep it `open` and state the concrete mistake scenario.
3. On insistence: no re-arguing, no stagnation burning — **escalate to the user immediately** (ID, the reviewer's scenario, your grounds, cost of each path). User accepts the risk → the existing `user-decision` release path; user sides with the reviewer → normal REVISING.
4. **Not contestable**: correctness, safety, and unverified-risk findings. A reviewer receiving a CONTEST on those insists.
5. **Closure authority never moves**: only the reviewer's response or a user decision closes an ID. Record each contest round in a `<dir>/contest-N.txt` sidecar (verbatim CONTEST, the verdict, the `--progress yes` rationale `contest-adjudication`, any escalation) — the run's own record of how the contest was settled.
6. An adjudication round legitimately leaves the blocking count unchanged — pass `--progress yes` with the sidecar rationale so it doesn't burn stagnation.

## Finding acceptance — necessity, not severity

Accept or reject each finding by whether fixing it is *necessary*, not by its severity label. Accept: it prevents a concrete failure or misreading, it names a real defect (factual error, broken reference), or it's low-cost with clear value. Reject: it adds a mechanism with no concrete mistake scenario, expands scope, or is a taste-only polish. Never accept everything wholesale, and never leave everything unfixed wholesale.

A non-blocking finding's default is **unfixed**: it stays open in the ledger and is reported open at completion — fix it only when the necessity test above says fixing is necessary.

Accepted non-blocking fixes ride in the same round as blocking fixes — no separate non-blocking-only re-review round.

Rejected findings are passed to the next reviewer call with the rejection reason so they're excluded from re-review scope (no reappearing). Blocking rejections follow the contest gate above (altitude/overengineering grounds, reviewer settles it); non-blocking rejections need only be passed along. Completion is unchanged: blocking count zero.

## Human-gated blocking issues: escalate, do not loop

If resolving an issue requires an out-of-run action (real external systems, credentials, manual QA), classify it human-gated in the receipt and **escalate immediately** — never iterate on it. Only the user releases it: they act or explicitly accept the risk (`user-decision`; the reviewer closes the ID next round and the final report lists it under needs-human-action), or the run ends honestly as `HARNIE_STATUS: INCOMPLETE`.

## Re-review scope and diff attribution

- Re-review scope = open issues + the new fix delta + previously approved areas the delta touches. Later rounds must cost less than round 1 — a fresh full scan is out of contract.
- The **orchestrator independently captures the fix delta** (whole working tree, baseline → post). Harnie does not create isolated trees, so the shared run tree has one supported path: serialize every producer write-and-capture window, with one writer from baseline through post capture. Non-empty `outOfScope` → do not attribute to the producer; stop and coordinate.
- Keep the reviewer stateful (`codex-reply` / prior-ledger path); never re-run a stateless full review inside the loop.

## Invariants

- Every modification is reviewed; work is not done while any blocking issue is open.
- Preserve a receipt per round: verdict, ledger, progress rationale, fix summary (and contest sidecars).
- The reviewer is never the producer's provider, and never writes — in `harnie:dev`. dev-solo is the exception (see "Roles" above): its reviewer is a native Codex subagent spawned with `fork_turns: "none"`; its read-only property is advisory because the parent sandbox is inherited.
