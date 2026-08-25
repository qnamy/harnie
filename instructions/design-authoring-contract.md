# Design Authoring Profile — CONTRACT Altitude (Canonical, for Injection)

Output contract for the **CONTRACT document** in an L run: the inter-task boundary layer between the (optional) architecture design and per-task detailed designs. The orchestrator passes this file's absolute path; the designer Reads it before writing. This document is the **approval-gate artifact's core** — task scopes and verification are fixed here, on evidence.

**Altitude:** only what crosses task boundaries. Task-internal logic, classes, and SQL belong to TASK-DETAIL (written later by each runner); do not include them.

## Sections (single lightweight mode)

1. **Key decisions** — the 3–5 decisions about task boundaries, with rationale.
2. **Task decomposition table** — per task: id / one-line purpose / **independent-review-value rationale (mandatory — the necessary condition: the change's own size·risk justifies one review unit's fixed cost; deps and parallelism are only secondary grounds; expected diff <100 lines or 1–2 files defaults to merging into the most related task)** / scope paths / deps / scope-test set / human-verification items ("none" explicitly when none).
3. **Inter-task contracts** — interfaces, data, and events between tasks only. Reference machine-readable schemas by file and ID; never transcribe fields.
4. **Per-task Environment Fact Sheets** — the pre-approval task-scoped grounding output; every fact cites its source path. Categories: code paths, existing tests, runtime/driver·session semantics (e.g. batch-scoped SET options, datetime truncation, rowcount reliability), schema state.
5. **Verification strategy** — two columns: automated (per-task scope tests; run-level `integrationVerification` for the full suite) / human (item, how to check, risk — handed over as a checklist at completion).
6. **Non-goals** — at least one line.

Compress ruthlessly for a small decomposition; do not force verbose sections. FR/NFR identifiers are optional — use them only where traceability genuinely helps.

## Manifest block

The plan document carries the ` ```harnie-manifest ` block: `{difficulty?, tasks:[{id, deps, reviewUnit, scope, setup?, verification}], gates:[{name:"final-review", reviewUnit:"final-review"}], integrationVerification:[…]}` (mode M: `gates: []`, single task). `integrationVerification` is required for M/L; in workspace runs every entry carries a registered `repo` key; reviewUnit `integration` is reserved.
