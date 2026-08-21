---
name: dev-full
description: Orchestrate large work such as new features, modules, and structural changes through the full lifecycle—planning (grounding + routing) → design → cross-model design review before code → approval gate → orchestrated execution → cross-model code review → final wave (Coverage, Quality, Runtime, Scope). Use symmetric cross-model review where design = Claude production → Codex review and development = Codex production → Claude review. Invoked by `/harnie:dev-full` or the `/harnie:dev` router. (Internal track value stays `plan`.)
---

# plan Orchestrator (Class B: New or Large Changes)

You, the main agent, move from the planning phase to the execution phase. This is a phase transition within one session, not an agent switch. Enforce workflow discipline through this skill plus the minimal mandatory hooks used for P2 delivery.

## On Every User Message: Reclassify Intent (Do Not Inherit Execution Authority Blindly)

When a new user message arrives, do **not** automatically carry forward the current execution mode. Reclassify the message as `replace|add|status|question`. A **status, question, or simple add** does not revoke approved execution authority; continue the work. If the **scope or goal changes**, however—through `replace` or a scope-changing `add`—stop execution, recompute `execution.json`, the plan, and review scope, obtain any required reapproval, and then continue. This resets **message intent and scope**, not execution authority itself.

## Step 0 — Read the Driver Contract (Required and First)

**Read `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md` now** — the CLI/Codex wiring (R1–R5) you execute directly, in your own context. You do **not** need to preload the schema, review criteria, or authoring-profile documents here: `harnie-designer`, `harnie-reviewer`, and the Codex reviewer/builder each Read their own criteria and profile files directly from the paths you pass them (A3/A4, B2/B2′, B3/B3′/B5 — see the phase files below) — do not inline those files' contents into delegation prompts. For `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md`, you only need to act on `apply`'s output (`machineState`, `needsReRequest`, `needsReentry`, per `review-loop-driver.md` R4); you do not need to load its full state-machine derivation.

> **Model assignment** for every delegation in this run follows `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md`: the **run difficulty** (easy/medium/hard — announced by the `/harnie:dev` router, or judged at A0 on direct entry) tiers **producer** models (Codex builder, `harnie-designer` at the DETAIL altitude); reviewer models are fixed (design review = `gpt-5.6-sol`, code review = `harnie-reviewer` pinned to opus); A3 formal architecture design always uses **fable** (fallback opus). Phase files restate the concrete values at each call site.

> **Symmetric cross-model review** means each stage is reviewed by the opposite provider: **design** (A3/A4) = Claude (`harnie-designer`) produces → **Codex** reviews; **development** (B2/B3/Final Wave) = **Codex** builder (Codex MCP, `workspace-write`) produces → **Claude** reviews. Depending on installation, the Codex MCP tool is `mcp__plugin_harnie_codex__codex` or `mcp__codex__codex`; rebuilding and rereview use `*__codex-reply`. See `review-loop-driver.md` for wiring details.

## Phase Files — Read the Relevant One When Entering That Phase

This skill's steps live in per-phase files under `skills/dev-full/phases/`, not inline here, to keep this file small. **Read the relevant file when you reach that phase; do not preload all of them at Step 0.** Each phase file assumes you have already read this file's State Location, Delegation Reference Rule, Execution State/Mandatory Hooks, and Notepad Protocol sections below.

- **PHASE A (planning):** `phases/phase-a.md` — A0–A5 (grounding, questions, architecture/detailed design + review loops, the manifest block, and the approval gate).
- **PHASE B, serial + both paths:** `phases/phase-b.md` — B1 (choose the path), the serial path's B2–B3, and the steps common to both paths, B4–B6.
- **PHASE B, parallel path only:** `phases/phase-b-parallel.md` — B2′–B3′ (per-task worktrees, build, pre-merge review, sequential integration). Read this only when B1 selects the parallel path; return to `phase-b.md` for B4 once every task's B3′ step 4 has APPROVEd.

## State Location (Durable, File-Based)

`.harnie/plan/<slug>/`:

- `plan.md` — Design + work breakdown + verification strategy + Final Wave (Coverage, Quality, Runtime, Scope). This is the approval-gate artifact.
- `design/rev-N.md` — The **versioned design artifact of record**: one file per revision, monotonically numbered, never overwritten. This is the only path that may be handed to a subagent or reviewer for design content.
- `notepad.md` — Progress notes and the shared single source across providers.
- `review/design-arch/` and `review/design-detail/` — Independent architecture and detailed-design review-loop state, each with `ledger.json`, `state.json`, and `round-N.txt`.
- `review/<unit>/` — Code-review loop state for each task or wave.

> Use one path scheme: keep every review loop under `.harnie/plan/<slug>/review/<name>/`, symmetric with quick's `.harnie/quick/<slug>/`. `<name>` is `design-arch`, `design-detail`, or a code-review unit.

> **Parallel PHASE B task worktrees.** When the parallel path applies, each task gets its own isolated git worktree with its own `.harnie/`, separate from this state. See `phases/phase-b-parallel.md` for the full layout and the current known dependency on the guard/worktree engine layer.

## Delegation Reference Rule (Disk Artifacts of Record Only)

Every path you hand to a subagent or reviewer must be a **disk artifact of record** inside the repo — `.harnie/plan/<slug>/…` or a source file. **Never pass a tool-result blob path** such as `tool-results/*.json`, a transcript scratch file, or a temp capture. Those files are not written to be read: a single-line 55k-token JSON silently fails to load, and the delegate then reconstructs the design from whatever older revision it remembers, so generations mix across rounds and the mix is invisible downstream.

Therefore, **from the moment a design artifact exists**:

1. The current design lives at `.harnie/plan/<slug>/design/rev-N.md` — a **new file per revision**; never overwrite an earlier `N`. **The designer writes it there directly**: every authoring delegation names the exact destination path (`design/rev-<next N>.md`), the designer (whose tools include Write) writes the document to that path and returns only a short summary, and main verifies the file exists and is non-empty before any delegation that references it. Main never transcribes design text from an agent response into the file — that round-trip pushes ~100KB documents through main's context every revision and is exactly what this rule exists to avoid. The **first** authoring delegation (A3/A4 initial pass) has no artifact yet: the designer writes `rev-1` from the task and its grounding, and this rule binds every delegation after it.
2. Every later delegation that **references an existing design** names **that exact path and revision number**, and states which revision is under review (for example, "review `design/rev-4.md`; rev-3 is superseded").
3. Inlining the design content, which `review-loop-driver.md` R2 requires for the `DR` loop because design files are excluded from git deltas, does **not** replace this: the inlined content and the named `rev-N.md` must be the **same revision**.
4. **Builder exception (B2).** The Codex builder must not access `.harnie/`, so it never receives a `.harnie` path. Give it the approved design **inlined** in the prompt and **name the revision it came from** (`rev-N`) so its output stays attributable. The path-naming requirement binds delegates that may read `.harnie/` — the designer and the design reviewer.

If a delegate reports that it could not read a referenced path, treat its output as **void for that round** and re-delegate after fixing the reference. Never accept a result reconstructed from memory.

## Execution State and Mandatory Hooks (Plan-Only Harness: `scripts/execution.mjs`)

The plan track uses **durable execution state plus minimal mandatory hooks** to mechanize two invariants: **① no source writes before approval, and ② no declaration of done while unapproved or incomplete.** Authority comes from the planHash-bound `manifest.json` (immutable except through PHASE A's A5.2 user re-approval, which archives the prior version), each review unit's ledger and state, and verification receipts. `execution.json` is only an advisory cache and must not be trusted; hooks evaluate approval from manifest + planHash rather than an advisory phase. In the steps below, `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}` and `<repo>` = this run's absolute **workroot**: the dedicated git worktree path reported by the bootstrap hook in its context message (`hookSpecificOutput.additionalContext` or `permissionDecisionReason`) for `/harnie:dev-full`, not the directory where the session started. If that message is unavailable, recover `<repo>` from the `workroot` field in `<main repo>/.harnie/sessions/<this session's id>.json`. **Every `execution.mjs` subcommand and `loop.mjs apply` require `--root <repo>`** and exit immediately without it (`loop.mjs capture`/`delta` take `<repo>` as a positional argument instead). Manipulate state **only through `execution.mjs`**; hooks block direct Edit/Write/Bash writes. The Bash guard blanket-blocks any command whose text references `.harnie` — **reads included**, since read-only shell commands cannot be classified reliably. To take a `.harnie` artifact out (a design doc for a handoff, a receipt for a report), use the sanctioned read-only subcommand `node <ROOT>/scripts/loop.mjs export <repo> <path relative to .harnie/> [--out <dest outside .harnie>]` instead of `cp`/`grep`; for in-context reading, the Read tool works as always.

- **Active run is created by the bootstrap hook — never by this skill.** The `/harnie:dev-full` (or `/harnie:dev` router → `Skill(harnie:dev-full)`) invocation already ran the bootstrap hook, which created the sentinel (`<repo>/.harnie/active.json`) and `execution.json` inside the reported workroot. **Resolve `<repo>` from the bootstrap context message or session-binding file above, read `<repo>/.harnie/active.json`, confirm `track === "plan"`, and use its `slug` (`<slug>`) for every CLI below. Do NOT run `execution.mjs init`.** If that workroot's `active.json` is absent or malformed, STOP and report that the bootstrap hook failed — do not self-initialize (that would reopen the bootstrap-adherence gap; see `bootstrap-adherence.md`).
- **Workspace runs (multi-repo).** If the bootstrap context message is flagged `WORKSPACE run`, this run spans multiple repos: `<repo>` (the workroot) is a **plain run-state directory** under `<workspace>/.harnie-wt/`, not a git worktree, and the sentinel carries `workspaceRoot` and a `repos` registry. The differences from a single-repo run, everywhere in this skill:
  - **Register member repos during PHASE A, before the A5 gate:** for every repo the plan will modify, run `node <ROOT>/scripts/execution.mjs repo-add --root <repo> --repo <absolute repo path under the workspace>`. It validates the path (inside the workspace, a git toplevel), creates that repo's dedicated worktree at `<member repo>/.harnie-wt/harnie-<slug>`, and records `{key, workroot}` in the sentinel. `arm-approval`/approval binding fail closed if any manifest task names an unregistered repo, so register first.
  - **Every manifest task carries `"repo": "<key>"`** (all-or-none; keys come from `repo-add` output). A task's `scope` paths and `verification[].cwd` are relative to **that member repo's workroot**; `execution.mjs verify` and completion re-derivation resolve them there.
  - **Per-task capture/delta and the Codex builder run against the task's member workroot** (`loop.mjs capture/delta <member workroot>`, builder `cwd: <member workroot>`), never against `<repo>` itself — `<repo>` is not a git tree. `execution.mjs` subcommands and `loop.mjs apply` still take `--root <repo>` (run state lives there).
  - **Whole-run binding is composite:** `loop.mjs capture <repo>` returns a `ws:<sha256>` artifact composed from every registered member workroot's tree; Final Wave gate `apply` uses that as `--artifact`. Any member repo change invalidates it, exactly like the single-repo whole-tree SHA.
  - The workspace root itself never holds run state beyond the per-session binding pointer, so nothing in the workspace outside this run's directories is ever gated.
- **Bind approval (A5):** `plan.md` must contain a machine-parsable `harnie-manifest` block. Immediately before asking for approval, run `execution.mjs arm-approval --root <repo> --slug <slug> --approve-option "Approve"` to arm, then receive approval through the actual `AskUserQuestion` tool as the very next question asked — the **first** `AskUserQuestion` call observed after arming is the one-shot approval candidate (PreToolUse consumes the arm and records that tool_use_id as pending; do not ask any other question in between, or it consumes the slot instead). PostToolUse observes the response and binds only if the selected value exactly equals `Approve` and planHash is unchanged. **Approval and threadId registration are not exposed through the CLI**—hooks perform them only in process, preventing self-approval through sanctioned Bash.
- **Builder gate (B2):** Immediately before delegation, run `set-task --root <repo> --slug <slug> --task <id> --run-status building`, then `seal --root <repo> --slug <slug>` to snapshot authority. After the builder returns and before attributing its delta, run `seal-verify --root <repo> --slug <slug>`. If the builder altered authority files, fail closed with exit 3.
- **Verification (B4):** `verify --root <repo> --slug <slug> --task <id>` — Execute the manifest's `verification[]` argv without a shell and record a receipt bound to the reviewedPostSHA scopeHash.
- **Completion (B6):** Run `completion --root <repo> --slug <slug>` to rederive completion by traversing the manifest, including binding the current working tree to the reviewed tree. The Stop hook uses the same derivation to block an incomplete exit, so report honestly with an `HARNIE_STATUS` footer.

## Notepad Protocol (`notepad.md`, Append-Only, Single Writer)

`notepad.md` carries **reusable knowledge** between delegations. To avoid concurrent append conflicts, designate the orchestrator (main) as the only writer:

1. **Read before delegation:** Read the sections relevant to the current task.
2. **Inject only what is needed:** Include those sections in the producer prompt for the Codex builder or designer; do not dump the whole file.
3. **Collect results:** Have the producer/reviewer return discoveries, decisions, and verification results.
4. **Append after every delegation or review round:** Main appends results to the notepad immediately after each round, rather than waiting until the entire task completes.
5. **Never overwrite or delete:** Existing entries are immutable and append-only. Give each entry a short `<entry-id>`. Correct stale or incorrect knowledge by appending a new `supersedes <entry-id>` entry instead of modifying the original.

Record **only reusable knowledge**: newly discovered constraints, approved decisions, facts that affect later tasks, verification results and evidence paths, failure causes, and re-entry evidence. Do **not** record general progress logs; avoid AI slop.

## Context Budget (Run-Wide) — Session Split, Injection Discipline, Gate Notification

Measured full runs show the dominant token cost is the orchestrator's own accumulated context being re-read on **every** call: once the session context reaches several hundred thousand tokens, each individual tool step costs that much input again. Three standing rules:

1. **Session split at unit boundaries.** All run authority is durable on disk (manifest, ledgers, receipts, notepad), so a fresh session resumes losslessly — a long run is *expected* to span several sessions. At each completed review unit (a task's B3 confirmation APPROVE, or a Final Wave gate APPROVE), assess accumulated context; after roughly 3–4 completed units in one session, or earlier when large artifacts have passed through context, append a short handoff entry to `notepad.md` (current unit, next step, open blockers) and **propose a session split to the user** — the user decides. `loop.mjs apply` backstops this mechanically: an APPROVED output carries `completedUnits` and sets `sessionSplitRecommended: true` on every 4th completed unit — when it fires, make the proposal before starting the next unit; do not dismiss it because the session "feels fine". Never silently grind on in a bloated session instead of proposing.
2. **Injection discipline.** Keep bulk out of main context: read only the sections of `plan.md`/`design/rev-N.md` a decision actually needs (delegates read their own references from the paths you pass, per the Delegation Reference Rule); run large-output commands filtered at the source; never carry a delegate's full report where its verdict line suffices.
3. **Batch steps; notify before gates.** Put independent tool calls in one message — at a large context every extra orchestrator step re-reads the entire context. Before blocking on any user gate (A5 approval, an errata disposition, STALLED re-entry, a watchdog deny), send a short notification if the installation provides a notification tool (e.g., `PushNotification`); measured runs lost whole nights to gates the user never saw.

---

## Invariants

- **Every modification is reviewed.** Architecture design review (A3), detailed design review (A4), per-task design and code review in the parallel path (B2′), merge-conflict-resolution review (B3′), run-level code review (B3), and Final Wave (B5) all use the same `review-loop-driver.md` loop. Only the producer, reviewer provider, criteria, altitude lens, namespace, and `<dir>` differ. Preserve **symmetric cross-model review**: Claude producer → Codex review for design; Codex producer → Claude review for development, with reviewer opposite producer.
- **Non-overlapping scope is a precondition, enforced once at arm-approval (A5) by `validateManifest`, not a substitute for review.** A task worktree's pre-merge review (B2′) is a quality gate on isolated code; only the run-level review unit created at B3 is what `execution.mjs verify`/`completion` read. Merging a task never skips its B3 confirmation round.
- Use the loop CLI, **not manual judgment**, for ledger/verdict consistency and state transitions; this prevents false approval.
- Keep design and planning in durable files (`plan.md`, `design/rev-N.md`, and `notepad.md`) so Claude and Codex read the same source. **Only disk artifacts of record may be referenced in a delegation**; a tool-result blob path is never a reference.
- Answer "is this inside the threat model?" and "must this mechanism exist?" **before** writing how to satisfy a design-review finding. A mechanism added without a concrete mistake scenario is overengineering, not compliance.
- **No verification command enters the manifest without evidence that it exercises something.** A check that matches nothing, or collects no tests, passes forever.
- Do not write code before the A5 approval gate.
