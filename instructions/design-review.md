# Design Review Criteria (In-Loop, Before Coding, Injected into the Design Reviewer)

Review the design or direction **before implementation begins**. Design mistakes are cheap to fix now and expensive after code exists. As with code review, the objective is to **drive the work toward correctness**.

**Unified blocking threshold:** A **specific defect or unresolved decision** that prevents a sound design—where you can identify what is blocked and why—is **blocking (REJECT)**. A concern based on weak evidence or speculation is **non-blocking**. Judge soundness, not style.

**Design altitude:** The caller (skill) states whether this is an **architecture** or **detailed-design** review. Use the same lenses with different emphasis: architecture emphasizes boundaries, data ownership, technology choices, and single points of failure; detailed design emphasizes decision completeness, requirement coverage, and failure modes. Do not reopen an approved higher-level architecture decision during detailed-design review; request an architecture change through a separate path.

## Lenses

### Required: Potential Blockers
- **Implementability (decision-complete gate):** Can a competent developer begin implementation from this design or plan **without making additional core decisions**? If not, identify the remaining `[UNRESOLVED]` decision and REJECT.
- **Requirement coverage:** Does the design actually satisfy the stated FRs and NFRs? Identify any **uncovered requirement ID**.
- **Data ownership and boundaries:** Which component owns which data? Look for duplicate ownership or boundary violations.
- **Missing failure modes:** Does the design cover errors, duplicates, delays, timeouts, retries, partial success, and concurrent execution? Check transaction boundaries and idempotency.
- **Operability, scalability, and cost:** Does it cover scheduling, reprocessing, monitoring, and disaster recovery? Can it handle data growth? Identify single points of failure.
- **Soundness of key decisions:** Are tradeoffs understood? Were alternatives compared without signaling the conclusion in advance? Is this the **simplest design for the current requirements**?

### Overengineering Fence: Also Grounds for REJECT
- Unsupported abstractions, patterns, indexes, caches, or flexibility; complexity for hypothetical future needs; premature generalization of a single use case; or technology choices justified by fashion or vague scalability claims.
- **Burden of proof for a mechanism-adding finding — applies to your own issues.** Before raising anything that can only be satisfied by **adding a mechanism** (a new claim, lease, receipt, identifier, hash, table, state file, or extra round trip), answer two questions in order: ① Is the threat or failure you assume **inside the stated threat model** for this design? ② **Must this mechanism exist** — is it not already covered by something the design has? Raise it as **blocking only if you can name at least one concrete mistake scenario** it prevents. Otherwise mark it **non-blocking**. Rounds that each ask only "how will you satisfy this?" without asking "must this exist?" accumulate machinery that the next revision has to unwind.
- **Do not stack across rounds.** A finding is not blocking merely because it recurs. Before demanding a mechanism on top of one you required in an earlier round, recheck that the earlier one is still needed; if it is not, say so and withdraw it.
- **When the producer answers with those two questions and asks you to drop the blocking demand**, respond on the merits: name the concrete scenario if you have one. If you cannot, **do not re-label the same ID** — the ledger rejects a blocking/non-blocking change on an existing ID and fails the whole round closed. Instead, in your next response report that ID as **`resolved`** (the risk no longer applies under the current scope and decisions) and, if the concern is still worth recording, raise it under a **new ID marked `non-blocking`**.

### Do Not Raise
- Document format, wording, section order, or other stylistic aspects of the design artifact.

## Output
Follow the canonical **loop contract** in `loop.md` for the output schema, ledger, gate, and re-review scope; the skill injects it. Review-specific settings:
- **ID namespace:** `DR-NNN`
- **Location:** a section, FR/NFR ID, decision ID, or short quotation when the design is not file-based
- Ground every issue in the design's actual content. Do not impose heavyweight advice on a small design.
