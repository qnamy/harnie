# Design Authoring Profile — Detailed-Design Altitude (Canonical, for Injection)

This is the **output contract** used when `harnie-designer` produces a **detailed design**. The orchestrator passes this file's **absolute path** in the delegation prompt; the designer **MUST Read it** before writing, rather than receiving its contents inline. The agent body owns only the persona, entry gates, and working principles, so do not restate them here.

**Altitude:** Translate architecture decisions into implementable code-level decisions. Make the design specific enough that a developer can **begin implementation without making additional core decisions**, while avoiding unnecessary classes and patterns.

**Respect the parent architecture:** When a parent architecture exists, preserve its requirement IDs, component names, and data ownership exactly. **Do not silently change architecture decisions.** If a change is necessary, separate it as an "Architecture Change Request" and state its rationale and impact. If no parent architecture exists, do not invent one; mark the dependency `[UNRESOLVED]`.

**Component-size gate:** If the target is too large for one document—for example, more than ten APIs or several independent use cases—do not write the whole design. First propose a decomposition and ask which unit to design first.

**Mode switch:** The default is **lightweight** and uses only the Lightweight Output section. Use the complete Formal Output section only when the caller explicitly signals **"formal"**. Both modes apply the agent body's rules for proportional depth, no speculation, duplication control, and a single source of truth for contracts.

## Environment Fact Sheet (Both Modes)
When the design depends on or constrains the runtime environment, open the design with an **Environment Fact Sheet**: the facts its decisions rest on, **each verified in the actual repo and cited with its source path** — never assumed. Wrong environment premises are the top source of wasted design-review rounds. Minimum categories, ecosystem-neutral (skip a category only when genuinely irrelevant):
- **Schema-migration state** — the tool and its current head (e.g., the latest migration version identifier).
- **Test infrastructure** — available runners, containers/fixtures, and the known baseline of already-failing tests.
- **Runtime configuration that constrains the design** — timeouts, pools, and framework settings that bound what the design may assume.
- **Framework/build-tool behavior the design assumes** — proxy/AOP semantics, whether the build's test task forwards required properties.
Consult the target repo's own guidance first — committed (`AGENTS.md`/`CLAUDE.md`) or personal/untracked (`CLAUDE.local.md`, for facts that must not be committed to a shared repo); it may already record tool-specific facts. When the caller provides a fact sheet (e.g., from plan grounding), verify and reuse it instead of re-deriving. A decision resting on a fact you could not verify is `[UNRESOLVED]`, not a guess.

## Lightweight Output (Default)
1. **Design Summary** — Target and responsibility; related FR/NFR IDs; position within the parent architecture; inputs, outputs, and dependencies; scope and non-scope. Reference the parent ADR when one exists; otherwise state `N/A`.
2. **Requirement Traceability Matrix** — Columns: requirement ID, implementation module, API/event/data, validation rule, test, and monitoring metric. **Identify uncovered requirement IDs and elements without supporting requirements.**
3. **Core Processing Logic** — Only for non-obvious use cases: preconditions → processing steps, with pseudocode when helpful → state after success → state and compensation after each failure → behavior under concurrency and duplicate requests.
4. **Contracts** — Only for non-obvious APIs or events: purpose, authentication/authorization, request and response intent, error contract, idempotency, and version/compatibility. When a machine-readable schema exists, reference its file and operation ID; do not transcribe fields.
5. **Data and State** — Changed tables or entities, transaction boundaries, concurrency control with optimistic/pessimistic rationale, and critical state transitions, using Mermaid `stateDiagram` when useful.
6. **Work Breakdown** — For each task: name, artifact, prerequisite, completion condition, test, risk, and size (S/M/L). Each task should be an independently reviewable change unit.
7. **Unresolved Decisions and Architecture Change Requests** — `[UNRESOLVED]` items, decisions requiring architect approval, necessary PoCs, and decision deadlines.

For a small task, compress this contract into a few lines; do not force verbose sections.

## Formal Output (When Explicitly Requested)
Expand the lightweight output into the following complete structure while retaining proportional depth, duplication control, and contract single-source rules.
1. Design Summary
2. Requirement Traceability Matrix — mark omissions and elements without requirements
3. Internal Component Structure — module/package structure, module responsibilities, public interfaces, dependency direction, likely change points, and C4 Component or UML Mermaid; identify cyclic dependencies and modules with multiple responsibilities
4. Domain and State Model — entities, value objects, invariants, allowed and prohibited states and transitions, transition-failure handling, and Mermaid `stateDiagram`
5. API Contracts — fully expand only non-obvious APIs: purpose, method/path or RPC, authentication/authorization, error codes and bodies, idempotency, pagination/sorting/filtering, timeouts/cancellation, versioning/backward compatibility, rate limits, and privacy exposure. Inline fields, types, constraints, and examples only when no separate machine-readable schema exists; otherwise reference the file and operation ID.
6. Event and Message Contracts — event name and version, producer and consumers, publication condition, delivery and ordering guarantees, deduplication, retry/backoff, DLQ, schema evolution, replay, and sensitive data. Inline schemas only when no machine-readable schema exists; otherwise reference the message ID.
7. Database Detail — tables/collections, fields/types/NULL/defaults, PK/FK/Unique/Check constraints, indexes **grounded in access patterns**, transaction boundaries, locking and concurrency with optimistic/pessimistic rationale, consistency level, retention/deletion, audit data, expected growth, migration, and rollback. Include ER or DDL drafts only when no separate migration artifact exists; otherwise reference its path and migration ID.
8. Core Processing Logic — per use case: preconditions, steps, pseudocode, complexity/performance, state after success or failure, compensation, concurrent execution, and duplicate-request behavior
9. Sequences and Failure Handling — normal and failure flows covering validation failures, insufficient permissions, data conflicts, dependency timeouts, partial success, duplicate messages, retry exhaustion, and old/new versions serving traffic during deployment, using Mermaid `sequenceDiagram`
10. Error-Handling Convention — domain/input/infrastructure/external errors, user-facing messages versus internal logs, retryability, HTTP/RPC mapping, trace IDs, and sensitive-data masking
11. Security Detail — authentication flow, authorization-check locations, object-level access control, input validation and output encoding, secret management, encryption, audit events, rate limiting, attack scenarios and defenses, and data prohibited from logs
12. Observability and Operations — structured log fields, metric names and units, trace spans, dashboards, SLI calculation, alert conditions, diagnostics, feature flags and kill switches, and runbook items
13. Performance and Capacity — latency budget, expected QPS and concurrency, query and external-call counts, cache keys/TTL/invalidation, batch size, memory and storage estimates, and load-test scenarios with acceptance thresholds
14. Test Design — unit, contract, integration, E2E, migration, concurrency/idempotency, performance, fault-injection, and security tests, each mapped to requirement IDs and failure scenarios
15. Deployment and Compatibility — rollout order; DB/API/event change order; old/new version coexistence; progressive rollout; feature flags; rollback conditions and procedure; data recovery
16. Implementation Work Breakdown — task name, artifact, prerequisite, completion condition, test, risk, and size (S/M/L), divided into independently reviewable change units
17. Unresolved Decisions and Architecture Change Requests — decisions allowed at detailed-design level, decisions requiring architect approval, required experiments or PoCs, and decision deadlines
