# Review Loop Driver (Canonical) — CLI/Codex Wiring for Every Loop

`loop.md` owns the contract (ledger, transitions, progress, contest); this file owns how to run it deterministically. Never merge ledgers or judge state transitions by hand — `scripts/loop.mjs` prevents false approval.

**Reviewer = producer's opposite provider.** Design loops (`DR`): producer Claude designer → reviewer Codex (`sandbox:"read-only"`). Code loops (`CR`): producer Codex builder → reviewer Claude (`harnie-reviewer` subagent — or the task's `harnie-task-runner` inline on the L runner path, legitimate because it writes no source).

`<ROOT>` = `${CLAUDE_PLUGIN_ROOT}`. `<dir>` = the review-unit directory (`.harnie/plan/<slug>/review/<unit>/`, or `.harnie/review/<design|code>/` inside a task worktree). `<repo>` = the root this loop concerns — the run workroot, or the task's isolated worktree / member repo workroot on the L path.

## Builder delegation (code loops)

Delegate via Codex MCP `codex` (`sandbox:"workspace-write"`, `approval-policy:"never"`, cwd = the builder's tree, model per `model-matrix.md`); fixes via `codex-reply` on the registered thread. The first prompt MUST include: the task content (brief/design inlined — never a `.harnie` path), the scope-test set, any preassigned cache path, and **the absolute path to `<ROOT>/instructions/builder-contract.md` with an instruction to Read it first** (path-referenced standing rules — verified deliverable; do not inline them).

**Stalled dispatch**: on MCP idle timeout / `AbortError`, check the tree against the pre-call baseline. Unchanged → one retry as a fresh `codex` call (re-inline the prompt, note the stall). Changed → one retry via `codex-reply`. A second identical stall is infrastructure — stop and surface. A provider-terminal error (`Session not found`류) on a bound thread → the **user-approved release path** (never a silent new thread): ① `node <ROOT>/scripts/execution.mjs rebind-arm --root <runRoot> --slug <slug> --task <id> --old-thread <boundThreadId> --evidence "<the provider's terminal response verbatim|@file>"` (**--root is always the run workroot** — binder/arm state lives there, never a task worktree or member root) — the evidence must contain a terminal marker (idle timeouts are rejected), the old-thread must match the current binding, and no other arm/pending may exist (run-wide one-shot exclusivity); ② the **very next AskUserQuestion** must present the sealed evidence verbatim plus the task id and old threadId in its body (the hook compares — a summary does not bind); ③ only an exact approve selection atomically releases the thread and arms the run-root bootstrap marker; counters/anchors are never reset.

## R1. Capture the fix delta (orchestrator-generated, code loops only)

```
node <ROOT>/scripts/loop.mjs delta <repo> <baselineSHA> --scope <paths> --out <dir>/delta.patch
```
Baseline is captured immediately before each producer window (`loop.mjs capture <repo> [--record <dir>]`). Non-empty `outOfScope` → stop per the attribution invariant. The `<out>.json` sidecar records actual changed paths per round. Design loops have no delta: `.harnie` docs are excluded — pass the artifact **path** instead (below).

## R2. Invoke the reviewer

Criteria are files the reviewer Reads itself — never inlined by you.

- **Codex reviewer (design)**: first review = `codex` with `sandbox:"read-only"`, `model:"gpt-5.6-sol"`, `developer-instructions` = the applicable criteria (`design-review.md` + `review-schema.md`, injected once per thread), prompt = intent + constraints + the design file's absolute path with an instruction to read it, **stating the altitude (ARCH / CONTRACT / TASK-DETAIL)**. Re-review = `codex-reply` with the revised path + changed section names only. Record the threadId.
- **Claude reviewer (code)**: delegate to `harnie-reviewer` (model = the tier for this review kind, `model-matrix.md`) with paths only: `<dir>/delta.patch`, the prior ledger, a short scope/intent summary, the design/brief reference **with section names**, and the errata path when one exists. A fresh unit (no prior ledger) must emit every issue `(open)`. Re-review rounds name the still-open IDs and judge them from the delta — later rounds must cost less than round 1.
- **Contests** (loop.md contest gate): pass the `CONTEST` block(s) in this call; write the sidecar `<dir>/contest-N.txt` after the response.

## R3. Save the receipt

Save the raw response unchanged as `<dir>/round-N.txt`.

## R4. Apply deterministically

```
node <ROOT>/scripts/loop.mjs apply --root <repo> --ledger <dir>/ledger.json \
  --review <dir>/round-N.txt --ns <CR|DR> --state <dir>/state.json --artifact <artifact> \
  [--limit 3] [--progress auto|yes|no] [--reentry <reason>]
```
- `--artifact`: **CR** = this round's `postSHA` (or the `ws:` composite for whole-run gates) — mandatory, binds verification to the reviewed tree. **DR** = `dr:<sha256(…)>` with altitude-specific inputs: **pre-approval central loops (ARCH, CONTRACT)** hash the design file content alone — no authority exists yet, each revision is a new file, so content identity suffices; **post-approval TASK-DETAIL loops (each L task's design; M's single design — M has no pre-approval design review)** hash `design content ‖ planHash ‖ edition token ‖ last approved errata ID for the cited sections ("none" if absent)`, where the edition token is: L runner = the brief edition (`t<id>-brief.vN`); M = literal `m-plan`; dev-solo L (no briefs) = `solo:contract-rev-N` (the contract revision the task design read) — recompute from current authority on every resume and compare with the stored value (mismatch = stale approval → redesign).
- Outputs: `needsReRequest` → re-prompt the reviewer naming the schema error (not a producer call). `needsReentry` → STALLED latch; surface to the user first. `machineState` REVISING → producer fixes (code: recapture baseline first); APPROVED → done (`sessionSplitRecommended` fires the session-split proposal); STALLED → stop and report.
- **Ordering hard rule**: `apply` round N with `committed: true` **before any next producer call** — a skipped apply is unrecoverable (stale artifact, unknown IDs); re-run that review as a new round instead of reconstructing.
- **Seal interleaving (shared run root)**: `seal` is whole-run-scoped — finish one unit's round completely (build → seal-verify → apply → verify) before starting another unit's builder call; another unit's legitimate `apply`/`verify` invalidates a pending seal.

## R5. Optional final sign-off

For substantial changes: one fresh cross-model sign-off (code → fresh Claude review of the uncommitted diff; design → fresh Codex review). Never stateless re-review inside the loop.

> Invariant: every modification is reviewed; keep receipts (verdict, ledger, progress rationale, contest sidecars, fix summary). Not done while any blocking issue is open.
