---
name: harness-digest
description: Analyze a finished harnie:dev run's execution state, review ledgers, and archived unit reviews to propose harness improvements — instruction prunes, granularity fixes, tier changes — with measured evidence. Propose only; the user chooses what to adopt, and incident-derived invariants are never auto-removed.
---

# Harness Digest (Run Telemetry → Harness-Improvement Proposals)

Apply the quality-digest principle — cluster recurring evidence, propose promotions, never change anything automatically — to **the harness itself**. Input is one or more finished harnie:dev runs; output is a ranked proposal list the user accepts or rejects. This is the mechanism that turns each run's measured waste into the next version's contract, without self-modifying-harness risk: **this skill writes no files and changes no configuration.**

## Input (all existing artifacts; no new instrumentation)

Read via sanctioned paths only (the Read tool; `loop.mjs export` for anything a shell would need):

- `execution.json` — per-task timestamps, `codexCalls`, `watchdogExtensions`, `threadRebindings`.
- Review-unit state — each `review/<unit>/ledger.json` + `state.json` (round counts, blocking-issue trajectory), and each task's `review-archive/t<id>/` (unit reviews archived at integration).
- Delta sidecars (`*.json` next to each `delta.patch`) — `changedCount` per round: the unit's real size.
- `design/errata.md` (`errata-list` output) — where the approved design was wrong.
- `notepad.md` — recorded path choices (serial-path rationales), handoffs, incident notes.
- Optional: session JSONL token stats when the caller provides them (per-call input sizes, cache reads).

## Procedure

1. **Unit cost profile.** For every review unit: rounds × changedCount × model tier (+ watchdog extensions, rebindings). Flag the distribution's outliers, not the mean.
2. **Cluster anomalies.** Known waste shapes to look for: a tiny unit (few files, low changedCount) that paid the full loop; the same finding class recurring across units (a criteria gap); 3+ rounds on one unit (a design-section or brief defect); repeated watchdog extensions (budget mis-tiered); an instruction or gate that never fired in any run (candidate to prune); serial path chosen with parallel-eligible tasks and no recorded rationale.
3. **Proposals.** For each cluster: `{ evidence (run/unit/numbers) · proposed change (instruction wording / manifest rule / model tier / granularity guidance) · expected saving · risk — including an explicit "invariant conflict" label }`. Rule of three applies across runs for anything that prunes or weakens a rule; one severe incident suffices for anything that adds a fail-fast.
4. **Human gate.** Present the list; the user picks. Adopted changes go through the normal dev flow (they are harness code/doc changes like any other) — never applied by this skill.

## Hard guards

- A proposal that would remove or weaken an incident-derived invariant (the "문서만 있는 규범" list in `docs/enforcement-map.md`, and NFR4's invariants in the 0.10 design) is **still shown** but must carry the `불변식 저촉` label — the human decides; the skill never silently drops or adopts it.
- Report enforcement cost honestly: a proposal that saves tokens but adds a user gate or an engine surface must say so.
- No file writes, no configuration changes, no state mutation — analysis and proposals only.

## Output

A ranked proposal list (most saving-per-risk first), each item self-contained with its evidence, plus a one-table run summary (units, rounds, outliers) so the numbers are checkable. When comparing two runs (e.g. pre/post a harness version), lead with the regression check: per-call input p50, wall time vs critical path, user-gate count.
