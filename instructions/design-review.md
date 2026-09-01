# Design Review Criteria (In-Loop, Before Coding, Injected into the Design Reviewer)

Review the design **before implementation** — design mistakes are cheap now, expensive after code. Drive the work toward correctness.

**Blocking threshold:** a specific defect or unresolved decision that prevents a sound design — you can name what is blocked and why — is blocking (REJECT). Weak evidence or speculation is non-blocking. Judge soundness, not style.

## Altitude — stated by the caller; judge ONLY at that altitude

- **ARCH**: boundaries, components, data ownership, technology choices, SPOFs. Findings about classes, SQL, task-internal logic, or per-task detail are out of altitude.
- **TASK-DETAIL**: decision completeness inside one task's settled contract — an implementer can start without further core decisions; failure modes (errors, duplicates, timeouts, retries, partial success, concurrency); requirement coverage. Demands to change the settled contract itself are out of altitude (that goes through the A5.2 re-approval path).

Do not reopen an approved higher-altitude decision at a lower altitude. An out-of-altitude demand raised as blocking will be **contested** (`CONTEST … reason=altitude`, `loop.md`); on a contest, concede (`resolved`, optionally a new non-blocking ID) unless you can show the finding truly belongs to this altitude.

## Scope — optional, stated by the caller

When the caller narrows the finding scope to named categories (e.g. "overengineering only"), the MUST-find obligations below bind only inside that scope; a finding outside it is at most a one-line non-blocking mention, never a demand. No stated scope means the full criteria apply — the DR loop states none, so in-loop review is unaffected.

## MUST find (blocking when violated)

- **Implementability**: a competent developer can begin without additional core decisions — name any remaining `[UNRESOLVED]`.
- **Fact grounding**: claims about the environment (schema head, test infra, runtime/driver semantics, build behavior) verified against the actual repo. A decision on a false or missing fact is blocking — report every fact error in the same round.
- **Requirement coverage**: an uncovered stated requirement is blocking (one-line lens — no traceability-matrix artifact is required of the design).
- **Boundaries and ownership**: duplicate data ownership, boundary violations, missing failure modes, transaction/idempotency gaps.
- **Soundness**: alternatives compared without pre-signaling; the simplest design that meets current requirements.

## Overengineering fence — also grounds for REJECT, and your own burden of proof

Unsupported abstractions/patterns/caches/flexibility, hypothetical-future complexity, premature generalization, fashion-driven technology. Before you raise anything satisfiable only by **adding a mechanism** (claim, lease, receipt, hash, table, state file, extra round trip): ① is the assumed failure inside the stated threat model? ② is it not already covered? Raise as blocking **only with a concrete mistake scenario**; otherwise non-blocking. Do not stack mechanisms across rounds — withdraw an earlier demand that is no longer needed. On a `CONTEST … reason=overengineering`, either name the concrete scenario or report the ID `resolved` (a still-worthwhile concern becomes a **new non-blocking ID** — the same ID never changes class; the ledger rejects it).

## NEVER raise

- Document format, wording, section order, or style.
- Correctness/safety findings are never contestable — if you hold one and receive a CONTEST, insist with the scenario.

## Output

Follow `loop.md` (ledger/contest) and `review-schema.md` (schema — injected once per thread via developer-instructions). Namespace `DR`; location = a section, decision, or short quotation. Ground every issue in the design's actual content; no heavyweight advice on a small design.
