# M Pipeline Kill Criteria (0.14, comparison axis decided 2026-08-28)

**Proposition under test.** After the 0.14 user-tree handoff change, compare dispatched development units that run through `dev` with dispatched units that run plain. If the M pipeline shows no advantage over **a plain session + the `cross-review` skill**, the M pipeline is dismantled and only the skill is kept.

This document records the criteria. It does not dismantle anything, and nothing in 0.14 acts on it.

## What is compared

| | Path A | Path B |
|---|---|---|
| Execution | dispatched unit running `/harnie:dev` M | dispatched unit running plain + `skills/cross-review/SKILL.md` |
| Review contract | identical (`cross-review`) | identical (`cross-review`) |
| Difference under test | the pipeline machinery **around** the review loop: mode/size state, the plan manifest and approval gate, seal windows, `verify` receipts, completion authority, the watchdog | none of it |

The review ledger and `loop.mjs` capture/delta/apply are **not** part of the difference — both paths run them, because both run the same review contract. Path B is a plain session that still keeps a ledger; it is not "review without a ledger". Counting shared review-loop cost as pipeline cost would compare two different contracts and invalidate the result.

Because both paths now run the *same* review contract, what is being measured is exactly the cost of the machinery — not the value of cross-model review, which is out of scope of this decision and is not up for removal.

## Sample

- **3 real dispatched development units.** Real work only. Each sample compares a unit that ran `dev` with an adjacent dispatched unit that ran plain. Synthetic exercises, including the 0.14 U1c and U7 canaries, do not count because they do not reproduce the real cost structure (grounding, user gates, rework).
- Path B comparisons come from **adjacent work of similar character and size**, not from re-running the same task.

## Measures (record all four per sample)

1. **Total tokens** — record the cache-read-inclusive figure and the effective (non-cache-read) figure separately.
2. **Wall clock.**
3. **User interventions** — how many times the run stopped for the human.
4. **Rework rounds** — review rounds after the first.

## Verdict rule

Dismantle the M pipeline (keeping `cross-review`) if, in **at least 2 of the 3 samples**, either:

- (a) the run's total tokens are **≥ 2×** the plain path's, or
- (b) wall clock is worse than the plain path's.

**Ties go to dismantling.** Keeping the pipeline has a real standing cost (docs, tests, hook wiring, the state machine's failure modes), so the burden of proof lies with keeping it, not with removing it.

**Non-use clause.** If 3 real M samples have not accumulated within 3 months of the 0.13 release — i.e. by **2026-11-27** — that itself counts as evidence the pipeline is not used, and the verdict is dismantle. Without this clause the sample would never fill and the criteria would never fire.

## Limits of this comparison — stated plainly

- The same task cannot be done twice by two methods. This is an **adjacent-task comparison, not a measurement**. Confounds (task difficulty, the day's context, model version) are not controlled.
- **The numbers — 2×, 3 samples, 2 of 3 — have no precise basis.** They were chosen to force a decision at a defined moment, not derived from data. Do not present them as a measured threshold; this is a device for making a judgment happen, and it should be read that way.
- What is *not* in question either way: the cross-model review loop itself (different providers for producer and reviewer, a read-only reviewer, ledger-based approval). That value survives any outcome here, because `cross-review` holds it independently of the pipeline.
