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

### Do Not Raise
- Document format, wording, section order, or other stylistic aspects of the design artifact.

## Output
Follow the canonical **loop contract** in `loop.md` for the output schema, ledger, gate, and re-review scope; the skill injects it. Review-specific settings:
- **ID namespace:** `DR-NNN`
- **Location:** a section, FR/NFR ID, decision ID, or short quotation when the design is not file-based
- Ground every issue in the design's actual content. Do not impose heavyweight advice on a small design.
