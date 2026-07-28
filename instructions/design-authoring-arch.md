# Design Authoring Profile — Architecture Altitude (Canonical, for Injection)

This is the **output contract** used when `harnie-designer` produces an **architecture design**. The orchestrator injects this file inline into the delegation prompt. The agent body owns only the persona, entry gates, and working principles, so do not restate them here.

**Altitude:** Focus on system boundaries and high-cost technical decisions. Do **not descend into implementation details** such as classes, functions, detailed SQL, or complete API schemas; those belong to the detailed-design profile.

**Mode switch:** The default is **lightweight** and uses only the Lightweight Output section. Use the complete Formal Output section only when the caller explicitly signals **"formal"**. Both modes apply the agent body's rules for proportional depth, no speculation, duplication control, and a single source of truth for contracts.

## Lightweight Output (Default)
1. **Executive Summary** — Explain the problem and proposal for non-technical stakeholders, the three to five key design decisions, and the three largest risks. Add optional `DEC-001` identifiers only when traceability is useful.
2. **Goals, Scope, Non-Goals, and Constraints** — Include success metrics.
3. **Key Requirements** — Assign `FR-001` and `NFR-001` identifiers only to important FRs and NFRs. Quantify NFRs where possible: SLO, latency, concurrency, data growth and retention, RTO/RPO, and cost limits.
4. **Architecture Alternatives** — Compare at least two alternatives in a table across structure, requirement coverage, complexity, operational burden, fault isolation, performance, cost, and vendor lock-in. State when each alternative fits. **Do not signal the conclusion before the comparison.**
5. **Recommended Architecture** — Give the rationale and a C4 Container-level Mermaid diagram. Label every arrow with its protocol, data, and purpose. Define each container's single responsibility, data ownership, and synchronous or asynchronous communication.
6. **Key Scenarios** — Provide one normal flow and one or two representative failure flows, such as an external integration failure, timeout, or partial outage, using Mermaid `sequenceDiagram`.
7. **Risks and Unresolved Decisions** — For each risk, state likelihood, impact, mitigation, and decision deadline. List unresolved items as `[UNRESOLVED]`.

For a small task, compress this contract into a few lines; do not force verbose sections.

## Formal Output (When Explicitly Requested)
Expand the lightweight output into the following complete structure while retaining proportional depth and duplication control.
1. Executive Summary
2. Goals and Scope — goals, success metrics, scope, explicit non-goals, constraints, and terminology
3. Requirements — FRs (`FR-001`); NFRs (`NFR-001`) quantified across availability/SLO, latency/throughput, concurrent users, data growth/retention, RTO/RPO, security/privacy, cost limits, and scale targets; priorities and conflicts
4. System Context — users, external systems, responsibilities, trust boundaries, and a C4 System Context Mermaid diagram
5. Architecture Alternatives — table comparison across structure, requirement coverage, complexity, operational burden, fault isolation, performance/scalability, security, cost, vendor lock-in, strengths, weaknesses, and fit conditions
6. Recommended Architecture — rationale; C4 Container Mermaid diagram; single responsibility per container; synchronous/asynchronous communication; data stores and ownership; external integrations; technology and version principles; prohibited cyclic dependencies
7. Key Scenarios — normal and failure flows for external integration failures, duplicate requests, partial outages, timeouts, and retries, using Mermaid `sequenceDiagram`
8. Data Architecture — data classification and ownership; storage, retrieval, retention, and deletion; consistency model; transaction boundaries; cache strategy; backup and recovery; privacy. **Do not include detailed table definitions or complete DDL.**
9. Quality Attribute Review — for operational excellence, security/privacy/compliance, reliability/recovery, performance, cost, and sustainability, document "design choice → rationale → verification method → residual risk" using cloud-agnostic principles
10. Reliability and Operations — SLI/SLO candidates, failure modes, timeout/retry/backoff/circuit-breaker policy, capacity assumptions and peak handling, logs/metrics/traces, alert thresholds, deployment/rollback/DR, and operator intervention points
11. Security and Threats — critical assets, authentication and authorization, trust boundaries, least privilege, encryption and key management, audit logs, major threats and mitigations, and abuse cases
12. Deployment and Migration — deployment topology, progressive rollout, backward compatibility, data migration, rollback conditions, and coexistence with the current system
13. Verification Plan — FR/NFR-to-test, load-test, fault-injection, security-review, and operational-rehearsal mapping
14. Risks and Unresolved Decisions — likelihood, impact, mitigation, owner, decision deadline, and `[UNRESOLVED]` items
15. ADRs — for each important decision: title, status, context, alternatives considered, decision, tradeoffs, and reconsideration conditions
16. Detailed-Design Handoff — APIs, data, state, errors, concurrency, and tests that each component's detailed design must define
