---
name: dev-full
description: Orchestrate large work such as new features, modules, and structural changes through the full lifecycle—planning (grounding + routing) → design → cross-model design review before code → approval gate → orchestrated execution → cross-model code review → final wave (Coverage, Quality, Runtime, Scope). Use symmetric cross-model review where design = Claude production → Codex review and development = Codex production → Claude review. Invoked by `/harnie:dev-full` or the `/harnie:dev` router. (Internal track value stays `plan`.)
---

# plan Orchestrator (Class B: New or Large Changes)

You, the main agent, move from the planning phase to the execution phase. This is a phase transition within one session, not an agent switch. Enforce workflow discipline through this skill plus the minimal mandatory hooks used for P2 delivery.

## On Every User Message: Reclassify Intent (Do Not Inherit Execution Authority Blindly)

When a new user message arrives, do **not** automatically carry forward the current execution mode. Reclassify the message as `replace|add|status|question`. A **status, question, or simple add** does not revoke approved execution authority; continue the work. If the **scope or goal changes**, however—through `replace` or a scope-changing `add`—stop execution, recompute `execution.json`, the plan, and review scope, obtain any required reapproval, and then continue. This resets **message intent and scope**, not execution authority itself.

## Step 0 — Inject Runtime Contracts (Required and First)

**Read the canonical files below now.** A path reference is insufficient; load their actual contents into this session. Do not restate them; only orchestrate them.

- `${CLAUDE_PLUGIN_ROOT}/instructions/loop.md` — Review-loop state machine, output schema, and ledger rules
- `${CLAUDE_PLUGIN_ROOT}/instructions/review-loop-driver.md` — Loop CLI and Codex wiring (R1–R5)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-arch.md` — Architecture-authoring profile (lightweight/formal branches)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md` — Detailed-design authoring profile (lightweight/formal branches)
- `${CLAUDE_PLUGIN_ROOT}/instructions/design-review.md` — Design-review criteria (before code, namespace `DR`, applied at both architecture and detailed altitudes)
- `${CLAUDE_PLUGIN_ROOT}/instructions/code-review.md` — Code-review criteria (REJECT bias, namespace `CR`)
- `${CLAUDE_PLUGIN_ROOT}/instructions/verification-tiers.md` — Verification tiers

> **Symmetric cross-model review** means each stage is reviewed by the opposite provider: **design** (A3/A4) = Claude (`harnie-designer`) produces → **Codex** reviews; **development** (B2/B3/Final Wave) = **Codex** builder (Codex MCP, `workspace-write`) produces → **Claude** reviews. Depending on installation, the Codex MCP tool is `mcp__plugin_harnie_codex__codex` or `mcp__codex__codex`; rebuilding and rereview use `*__codex-reply`. See `review-loop-driver.md` for wiring details.

## State Location (Durable, File-Based)

`.harnie/plan/<slug>/`:

- `plan.md` — Design + work breakdown + verification strategy + Final Wave (Coverage, Quality, Runtime, Scope). This is the approval-gate artifact.
- `design/rev-N.md` — The **versioned design artifact of record**: one file per revision, monotonically numbered, never overwritten. This is the only path that may be handed to a subagent or reviewer for design content.
- `notepad.md` — Progress notes and the shared single source across providers.
- `review/design-arch/` and `review/design-detail/` — Independent architecture and detailed-design review-loop state, each with `ledger.json`, `state.json`, and `round-N.txt`.
- `review/<unit>/` — Code-review loop state for each task or wave.

> Use one path scheme: keep every review loop under `.harnie/plan/<slug>/review/<name>/`, symmetric with quick's `.harnie/quick/<slug>/`. `<name>` is `design-arch`, `design-detail`, or a code-review unit.

## Delegation Reference Rule (Disk Artifacts of Record Only)

Every path you hand to a subagent or reviewer must be a **disk artifact of record** inside the repo — `.harnie/plan/<slug>/…` or a source file. **Never pass a tool-result blob path** such as `tool-results/*.json`, a transcript scratch file, or a temp capture. Those files are not written to be read: a single-line 55k-token JSON silently fails to load, and the delegate then reconstructs the design from whatever older revision it remembers, so generations mix across rounds and the mix is invisible downstream.

Therefore, **from the moment a design artifact exists**:

1. Main writes the current design to `.harnie/plan/<slug>/design/rev-N.md` — a **new file per revision**; never overwrite an earlier `N`. The **first** authoring delegation (A3/A4 initial pass) has no artifact yet: the designer produces `rev-1` from the task and its grounding, and this rule binds every delegation after it.
2. Every later delegation that **references an existing design** names **that exact path and revision number**, and states which revision is under review (for example, "review `design/rev-4.md`; rev-3 is superseded").
3. Inlining the design content, which `review-loop-driver.md` R2 requires for the `DR` loop because design files are excluded from git deltas, does **not** replace this: the inlined content and the named `rev-N.md` must be the **same revision**.
4. **Builder exception (B2).** The Codex builder must not access `.harnie/`, so it never receives a `.harnie` path. Give it the approved design **inlined** in the prompt and **name the revision it came from** (`rev-N`) so its output stays attributable. The path-naming requirement binds delegates that may read `.harnie/` — the designer and the design reviewer.

If a delegate reports that it could not read a referenced path, treat its output as **void for that round** and re-delegate after fixing the reference. Never accept a result reconstructed from memory.

## Execution State and Mandatory Hooks (Plan-Only Harness: `scripts/execution.mjs`)

The plan track uses **durable execution state plus minimal mandatory hooks** to mechanize two invariants: **① no source writes before approval, and ② no declaration of done while unapproved or incomplete.** Authority comes from the immutable, planHash-bound `manifest.json`, each review unit's ledger and state, and verification receipts. `execution.json` is only an advisory cache and must not be trusted; hooks evaluate approval from manifest + planHash rather than an advisory phase. In the steps below, `<ROOT>` = `${CLAUDE_PLUGIN_ROOT}` and `<repo>` = the absolute path of the working repository. **Every `execution.mjs` and `loop.mjs` invocation requires `--root <repo>`** and exits immediately without it. Manipulate state **only through `execution.mjs`**; hooks block direct Edit/Write/Bash writes.

- **Active run is created by the bootstrap hook — never by this skill.** The `/harnie:dev-full` (or `/harnie:dev` router → `Skill(harnie:dev-full)`) invocation already ran the bootstrap hook, which created the sentinel (`.harnie/active.json`) and `execution.json`. **Read `.harnie/active.json`, confirm `track === "plan"`, and use its `slug` (`<slug>`) for every CLI below. Do NOT run `execution.mjs init`.** If `active.json` is absent or malformed, STOP and report that the bootstrap hook failed — do not self-initialize (that would reopen the bootstrap-adherence gap; see `bootstrap-adherence.md`).
- **Bind approval (A5):** `plan.md` must contain a machine-parsable `harnie-manifest` block. Immediately before asking for approval, run `execution.mjs arm-approval --root <repo> --slug <slug> --question "<question>" --approve-option "Approve"` to arm only that question and option, then receive approval through the actual `AskUserQuestion` tool. PreToolUse matches the question/options and records the tool_use_id and current planHash as pending; PostToolUse observes an exact selection match. **Approval and threadId registration are not exposed through the CLI**—hooks perform them only in process, preventing self-approval through sanctioned Bash.
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

---

## PHASE A — PLAN (Planning Phase)

**A0. Adopt the active run (do not self-init).** The bootstrap hook already created the sentinel and `execution.json` for this invocation (phase `planning`). Read `.harnie/active.json`, confirm `track === "plan"`, and use its `slug` throughout. If it is absent or malformed, STOP and report the bootstrap failure — never run `execution.mjs init` to recover. With the sentinel present, mandatory hooks block pre-approval source writes, write-capable subagents, and `workspace-write` Codex calls.

**A1. Ground with a scope-proportional investigation.** Spawn `harnie-scout` (haiku) **in parallel** to investigate. For each dimension below, first confirm whether it **exists and is relevant** to this task, then trace only the relevant ones deeply — forcing deep investigation of unrelated areas is scope inflation:

- the affected code and its **call paths** (callers and callees),
- existing **tests** covering the area,
- **configuration and environment variables**,
- **data/schema and migrations**,
- **external integrations and APIs**,
- relevant **docs/ADRs and repo guidance** (`AGENTS.md`, `CLAUDE.md`, `README`, and team conventions),
- **similar existing implementations** whose conventions to mirror.

Ground every decision in actual files, interfaces, dependencies, and conventions before assuming.

**A2. Decide questions by evidence — not by a CLEAR/UNCLEAR label.**

- **Do not ask** what you can confirm or reasonably infer from code, tests, config, or docs. Investigate first (A1).
- **Ask only** when the answer is not derivable and a wrong guess is costly, limited to: (a) **product or policy intent that only the user can decide** (behavior, UX, or tradeoffs encoded nowhere); (b) an ambiguous requirement with **materially different valid interpretations**; (c) a decision that would cause **significant rework or a compatibility break** if guessed wrong; (d) **external context you cannot infer** — a credential **source/configuration**, target, or account (ask for the source/config only; never request secret values).
- **Before asking**, present the evidence you gathered, **the parts you could not confirm**, the options with **each option's impact**, and your **recommended default with the WHY**.
- **Batch limit**: at most **3 questions in a single design-discovery round**; no omnibus/compound questions. (The A5 approval question is separate and not counted here.)
- For each **unresolved but non-blocking** uncertainty (not every non-asked detail), adopt a best-practice default and **record it in a `## Assumptions` section of `plan.md`** — not just announce it — so the design review and approval gate can see it.

**A3. Formal architecture design + review loop (conditional).** Ask `harnie-designer` (opus/max) for a **formal architecture design**. Inline the **formal section contract** from `design-authoring-arch.md` into the delegation prompt and signal `architecture, formal`, because subagents do not automatically load the profile. Focus on system boundaries, data ownership, technology choices, and SPOFs; do not descend into classes or SQL. Main writes the returned design to `.harnie/plan/<slug>/design/rev-N.md` **before any delegation that references it** (see the Delegation Reference Rule) and records the same revision in the architecture section of `plan.md`.

- Run this stage **only when boundaries, data ownership, or technology choices actually change**. If the existing architecture remains intact and the work is a large detailed change within it, skip to A4. An unsupported formal architecture stage is scope inflation.
- When run, continue through the **architecture design review loop** to APPROVE using `review-loop-driver.md`: producer = designer; criteria = the **architecture-altitude lens** in `design-review.md` (boundaries, ownership, technology choices, SPOFs); namespace `DR`; `<dir>` = `.harnie/plan/<slug>/review/design-arch/`. Instead of the R1 delta, place the architecture design in the Codex `prompt` **and name the `design/rev-N.md` path that holds that same revision**; R2–R5 remain unchanged.
- Each revision that answers a review round is a **new `rev-N.md`**, written before the re-review is delegated. Never re-review a revision by pointing at the previous file or at a tool-result blob.

**A4. Formal detailed design + review loop.** On top of the approved architecture or existing architecture, ask `harnie-designer` (opus/max) for a **formal detailed design**. Inline the **formal section contract** from `design-authoring-detail.md` into the prompt and signal `detailed design, formal`. Require a requirements traceability table, key processing logic, contracts, data/state, and work breakdown at a decision-complete level. Do not silently change architecture decisions; if one must change, return to A3 and request an architecture revision. Main writes the returned design to the next `.harnie/plan/<slug>/design/rev-N.md` before delegating anything that references it, and records the same revision in the detailed section of `plan.md`.

- Run a **detailed-design review loop** independent of A3, with a separate ledger/state: producer = designer; criteria = the **detailed-altitude lens** in `design-review.md` (decision completeness, requirements coverage, failure modes); namespace `DR`; `<dir>` = `.harnie/plan/<slug>/review/design-detail/`. As in A3, put the detailed design in the reviewer prompt, naming its `design/rev-N.md` path, instead of using an R1 git delta because design files live under `.harnie/` and are excluded from delta handling.
- Both loops exist to catch design errors **before implementation**. Report STALLED to the user. Architecture and detailed design are reviewed independently, in that order.
- **Order of reflection on a review finding — answer two questions before writing any fix (both loops).** For each REJECT issue, in this order: ① Is the threat or failure it assumes **inside the threat model** (`§0.1`: a fallible, over-eager orchestrator or builder making mistakes — a session-adversarial main agent is a non-goal)? ② **Must a new mechanism exist for it**, or is it already covered by something the design already has? Only after both answers do you write how to satisfy the issue. Taking each REJECT as "how do I satisfy this?" alone is what accumulates claims, leases, receipts, and hash identifiers across revisions and costs several rounds to unwind.
- **A fix that adds a mechanism must carry its justification:** at least one **concrete mistake scenario** it prevents, recorded in a `## Revision Notes` section of the new `design/rev-N.md`. If you cannot state one, do not add the mechanism — instead answer the reviewer in the next round with both answers above and ask it to **drop the blocking demand**. The ledger moves only through the reviewer's next response, and only in the shape `mergeLedger` accepts: it **closes the original ID as `resolved`** (the risk no longer applies under the current scope and decisions) and, if the concern is still worth recording, **opens a new `non-blocking` ID**. Re-labeling the same ID from blocking to non-blocking fails closed in `scripts/ledger.mjs`, so never ask for it and never hand-edit `ledger.json` or the verdict.
- **Machine-parsable manifest block (approval artifact):** After the detailed design's work breakdown is final, add a JSON block fenced with ` ```harnie-manifest ` to `plan.md`: `{tasks:[{id, deps, reviewUnit, scope:[<paths>], verification:[{executable, args, cwd, timeout}]}], gates:[{name, reviewUnit}]}`. Every task and gate `reviewUnit` must be unique and becomes its review-directory name. `scope` lists paths the task may touch. `verification` contains shell-free argv for mandatory runtime evidence; **every entry must survive the A5.0 evidence check below before it is registered**. Gates are the four Final Wave units—`coverage`, `quality`, `runtime`, and `scope`—with `reviewUnit` values `final-<name>`. At A5 approval, this block is frozen as immutable `manifest.json` and sealed by planHash as the authority set.

**A5. Approval gate (once, bound to the real approval tool).**

**A5.0 — Prove every verification command actually exercises something, before registering it (required, before arming approval).** The manifest's `verification[]` entries are the only runtime evidence `verify` will ever produce, so an entry that exercises nothing passes forever while verifying nothing. Pre-approval Bash is restricted to read-only commands by H1, so prove each entry the strongest way that gate allows and record the result next to the manifest block in `plan.md`:

- **Read-only query entries** (`rg`, `grep`, `git ls-files`, `jq`, …): run the argv **exactly as written**, once. Record `exitCode` and the **match count**. 0 matches → do not register it.
- **Entries needing an interpreter or test runner** (`node --test`, `npm test`, `tsc --noEmit`, …): these **cannot** run before approval, and **do not loosen the gate to make them run** — executing repo code pre-approval is precisely the write primitive H1 blocks. Instead prove the **input set** with a read-only discovery command (list the files the runner's own pattern would collect) and record the count; 0 means the entry verifies nothing. The silent case is a **pattern argument that matches nothing**: `node --test 'scripts/*.test.mjs'` with no matching file reports `# tests 0` and **exits 0** (verified on Node v21.6.2). Since manifest argv is shell-free, such a pattern reaches the runner literally — so list the matches first, and prefer an argv whose inputs you have enumerated.
- **Empty is not the same as silent.** `tsc --noEmit`, quiet linters, and schema validators print nothing on success; that is a pass, not empty evidence. **Empty means the command exercised nothing**: 0 matches, 0 tests collected, 0 files checked. For a silent-success tool, take the exercised count from the tool itself (its file-list or verbose flag, or a reported input count) rather than from output size.
- **There is no downstream backstop — this gate is the only one.** `verify` runs the argv with `stdio: "ignore"` and its receipt records only `{executable, args, exitCode}` ([execution.mjs:734](scripts/execution.mjs:734)), so nothing later can tell "ran 200 tests" from "collected 0". And after approval the manifest is immutable and `set-phase` refuses to revert to `planning` ([execution.mjs:775](scripts/execution.mjs:775)), so a vacuous entry **cannot be repaired inside the run**: the only honest outcome is to report `HARNIE_STATUS: INCOMPLETE` naming that entry and hand the decision back to the user. Get it right here.

Traps worth a few seconds each: `rg -e A -e B` is **OR**, not AND; `rg --files-without-match` inverts the polarity you probably meant. A command that cannot fail is not verification.

> Mechanizing this step properly takes two engine-side changes in `scripts/execution.mjs`, **not** a wider Bash allowlist: a `dry-run` subcommand (a sanctioned CLI, therefore runnable before approval) and an execution-volume field in the verify receipt (captured output or an exercised count) so completion can reject a vacuous pass. Until they exist, the checks above are the contract.

**A5.1 — Ask for approval.** Present the review-approved `plan.md`, including architecture and detailed design, work breakdown, verification strategy with its A5.0 evidence, Final Wave, and `harnie-manifest` block. Then ① run `execution.mjs arm-approval --root <repo> --slug <slug> --question "<exact question text>" --approve-option "Approve"` so only this approval question can bind, and ② immediately ask the exact same question with `AskUserQuestion`. The question must exactly match `--question`, and option labels must make approval and rejection distinguishable by selected value alone, such as `Approve` / `Reject or revise`. Hooks compare the armed and actual question/options, and treat **only the exact `Approve` value** as approval; the presence of the word "approve" in the question cannot cause a false positive. PreToolUse binds the armed tool_use_id and current planHash as pending; PostToolUse opens `phase=executing` only if the selected value is `Approve` and planHash is unchanged. This prevents an over-eager main agent from self-approving or changing the plan after asking. `set-phase` cannot enter executing. Rejection or a planHash mismatch fails closed and remains `awaiting-approval`. After approval is confirmed, enter PHASE B. A3 and A4 already provide design-soundness gates, so approval occurs once.

---

## PHASE B — EXECUTE (Execution Phase)

**B1. Parse the plan into tasks and a dependency map.** Fan out when no named dependency exists. Because the **delta compares the entire tree**, non-overlapping paths alone do not preserve the attribution invariant in `loop.md`: use an **isolated worktree per task for true concurrency**, or **serialize each task's write + delta-capture window in a shared worktree**, finishing task A's build and capture before task B begins.

**B2. Delegate each task to a Codex builder (development producer = Codex).** Immediately before delegation, in order: ① run `execution.mjs set-task --root <repo> --slug <slug> --task <id> --run-status building` so hooks allow builder bootstrap; ② run `loop.mjs capture <repo>` to capture that task's baseline for the B3 R1 fix delta; ③ run `execution.mjs seal --root <repo> --slug <slug>` to snapshot authority. Parallel work requires an independent baseline per task, so use isolated worktrees for concurrent tasks or serialize writes and capture in a shared worktree as described in B1. Then delegate to the **Codex builder** through Codex MCP with `sandbox:"workspace-write"` and `cwd:<repo>`. Include the task instructions and **the relevant approved design section from `plan.md`** so the builder implements the reviewed design. Require the six-section contract: requirements, brief design, implementation, robustness, tests, verification. Keep scope surgical. **The builder must not access `.harnie/`**; authority state belongs to the orchestrator and CLI. The PostToolUse hook observes a successful Codex call and registers its threadId; use `codex-reply` for revisions.

**B3. ★ Code review loop per task/wave (cross-model).** Immediately after builder output and before delta attribution, run **`execution.mjs seal-verify --root <repo> --slug <slug>`**. If the builder accidentally altered authority files, fail closed, invalidate that round, and report it. If it passes, run R1–R5 from `review-loop-driver.md`:

- Producer = **Codex builder**. Reviewer = read-only **`harnie-reviewer` subagent**, never main inline; this preserves cross-model review because the builder is Codex, and the reviewer cannot write. Criteria = `code-review.md` + `verification-tiers.md`. Namespace = `CR`. `<dir>` = `.harnie/plan/<slug>/review/<unit>/`, where `<unit>` is the task's manifest `reviewUnit`.
- Record the reviewer's `loop.md` VERDICT/ISSUES response in `round-N.txt`. Pass **that round's delta `postSHA` through `--artifact` to `apply`**. This is mandatory for CR and lets `execution.mjs` recompute `reviewedScopeHash` at that tree, binding verification to the reviewed tree. For fixes, ask the Codex builder through `codex-reply`, then review only the delta. Continue until every dimension is APPROVE.

**B4. Verify each task.** Run `execution.mjs verify --root <repo> --slug <slug> --task <id>` after review approval. It executes the manifest's `verification[]` argv without a shell and records exitCode, scopeHash, and planHash receipts against reviewedPostSHA. Also perform Manual QA for user-visible behavior automation cannot catch, and reread `plan.md` to compare scope. Completion is rederived as **ledger APPROVE ∧ receipt pass**, so a failed verification or later code change automatically makes the task incomplete.

**B5. Final Wave (proportional to scale, parallel) — `Coverage · Quality · Runtime · Scope` gates.** Verify that the whole system fits together. Run each gate as an independent review unit through `review-loop-driver.md`, namespace `CR`, under `review/final-<gate>/` for `coverage`, `quality`, `runtime`, and `scope`:

- **Coverage** — Does the implementation satisfy every requirement ID and design decision in `plan.md`? Any uncovered FR/NFR is under-building.
- **Quality** — Apply the full `code-review.md` lens for correctness, safety, and overengineering.
- **Runtime** — Require actual execution evidence using `verification-tiers.md`, including integration boundaries. Unverified risk means REJECT.
- **Scope** — Complete only the requested scope and do not build unrequested work. Scope inflation is over-building and must be blocked.
- Reviewer = read-only **`harnie-reviewer`**, the opposite provider from the Codex builder. For each gate, pass the current tree's `--artifact <postSHA>` to `apply`. Require every gate to APPROVE, rerunning **only failed gates**. Use Claude alone by default; if the user requests high precision, add an auxiliary dual-provider final sign-off from Codex.

**B6. Report and rederive completion.** Run `execution.mjs completion --root <repo> --slug <slug>` to traverse the manifest and rederive completion. Each task requires ledger APPROVE, receipt pass, and current scope matching reviewed scope; each gate requires an approved ledger and the current whole tree matching the reviewed tree. Summarize changed files, each task's tier and verification evidence, every review unit's final verdict and round count, and all four Final Wave verdicts. **End the final response with a machine-readable footer:** if rederived complete, `HARNIE_STATUS: COMPLETE`; otherwise `HARNIE_STATUS: INCOMPLETE — <remaining blocker summary>`. The Stop hook uses the same derivation, so it blocks exit when authority says incomplete but the response claims COMPLETE or omits the footer. Report remaining blocking units, STALLED units, and unverified scope honestly as INCOMPLETE, then return control to the user.

---

## Invariants

- **Every modification is reviewed.** Architecture design review (A3), detailed design review (A4), code review (B3), and Final Wave (B5) all use the same `review-loop-driver.md` loop. Only the producer, reviewer provider, criteria, altitude lens, namespace, and `<dir>` differ. Preserve **symmetric cross-model review**: Claude producer → Codex review for design; Codex producer → Claude review for development, with reviewer opposite producer.
- Use the loop CLI, **not manual judgment**, for ledger/verdict consistency and state transitions; this prevents false approval.
- Keep design and planning in durable files (`plan.md`, `design/rev-N.md`, and `notepad.md`) so Claude and Codex read the same source. **Only disk artifacts of record may be referenced in a delegation**; a tool-result blob path is never a reference.
- Answer "is this inside the threat model?" and "must this mechanism exist?" **before** writing how to satisfy a design-review finding. A mechanism added without a concrete mistake scenario is overengineering, not compliance.
- **No verification command enters the manifest without evidence that it exercises something.** A check that matches nothing, or collects no tests, passes forever.
- Do not write code before the A5 approval gate.
