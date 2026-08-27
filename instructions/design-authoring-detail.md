# Design Authoring Profile — TASK-DETAIL Altitude (Canonical, for Injection)

Output contract for a **detailed design inside settled boundaries**: one task of an L run (written by its runner), the single unit of an M run, or any standalone detailed design. The caller passes this file's absolute path; the author Reads it before writing.

**Altitude:** translate the settled contract into implementable code-level decisions — specific enough that an implementer begins **without additional core decisions**, without unnecessary classes or patterns.

**Respect the parent.** Preserve the parent architecture's names, ownership, and interfaces exactly; never change them silently — a needed change is escalated through the A5.2 re-approval path, not designed around. If the target is too large for one document, propose a decomposition first.

## Environment facts first

Open with the facts your decisions rest on, **each verified in the actual repo and cited with its source path** — wrong premises are the top source of wasted review rounds. Reuse and verify the fact sheet the caller provides (CONTRACT per-task sheet / grounding output) instead of re-deriving; your own pass is **incremental** — verify the given facts, fill only gaps. Cover, when relevant: schema-migration head; test infrastructure and baseline failures; runtime configuration limits; framework/build behavior; **driver·session semantics** (batch-scoped SET options, datetime precision truncation, rowcount reliability under batches, and similar gotchas of the concrete driver in scope). A decision resting on an unverifiable fact is `[UNRESOLVED]`, not a guess.

## Sections (lightweight — compress to a few lines for small work)

1. **Design summary** — target, responsibility, position in the parent contract, inputs/outputs/dependencies, scope and non-scope.
2. **Core processing logic** — non-obvious cases only: preconditions → steps (pseudocode when helpful) → state after success → state and compensation per failure → duplicates/concurrency.
3. **Contracts** — non-obvious APIs/events only: purpose, auth, request/response intent, error contract, idempotency. Reference machine-readable schemas by file and ID.
4. **Data and state** — changed entities, transaction boundaries, concurrency control with rationale, critical transitions.
5. **Tests** — what proves this design, mapped to its risks; name the scope-test set additions.
6. **Unresolved / escalations** — `[UNRESOLVED]` items and anything requiring a contract or architecture change.

Requirement coverage is judged by the reviewer as a lens; a traceability matrix or forced FR/NFR ID scheme is **not** required — use identifiers only where they genuinely help.

## NEVER

- Speculative elements: unsupported indexes, caches, abstractions, generalization of a single use case.
- Verbose sections for their own sake; restating the parent contract or this profile.
- Designing only the happy path — errors, duplicates, delays, retries, cancellation, and concurrency are part of the design.
