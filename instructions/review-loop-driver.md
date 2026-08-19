# Review Loop Driver (Canonical) — Shared CLI Wiring for Quick and Plan

`loop.md` owns the review loop's **state transitions, output schema, ledger rules, progress rules, and re-review scope**; read it first. This file defines only **how to run that contract deterministically** through the CLI and Codex. Do **not** merge the ledger or determine verdict consistency and state transitions manually. `scripts/loop.mjs` owns the deterministic core that prevents false approval.

**Reviewer = the producer's opposite provider**, bound per stage (symmetric cross-model):
- **Design loop:** producer = Claude (`harnie-designer`); reviewer = **Codex** (Codex MCP, `sandbox:"read-only"`).
- **Code loop:** producer = **Codex** (Codex MCP, `sandbox:"workspace-write"` — the builder); reviewer = **Claude** (the read-only `harnie-reviewer` subagent — never the orchestrator inline).

The loop core (`loop.mjs`) is provider-agnostic: R1 and R3–R5 are identical for both loops, and only **R2 (the reviewer call)** and the **producer's fix** differ by provider. Depending on installation mode, the Codex MCP tool is `mcp__plugin_harnie_codex__codex` for the plugin or `mcp__codex__codex` for a local `.mcp.json`; re-review or re-build uses the corresponding `*__codex-reply`. `<ROOT>` means `${CLAUDE_PLUGIN_ROOT}`. `<dir>` is the track-specific state directory, such as `.harnie/quick/<slug>/review/code/`, `.harnie/plan/<slug>/review/<unit>/`, or — for a task's pre-merge loops in dev-full's parallel PHASE B — `.harnie/review/design/` or `.harnie/review/code/` rooted in that task's own isolated worktree.

**`<repo>` is whichever root this invocation's loop concerns, not always the one active run's root.** Every quick and plan invocation of this driver uses the single active run's repo root. dev-full's parallel PHASE B is the one exception: a task's pre-merge design and code review loops (before that task merges into the run branch) run with `<repo>` set to that task's **isolated git worktree** — a separate repo root created by `scripts/worktree.mjs`, disjoint from the run worktree's own `.harnie/plan/<slug>/review/<unit>/`. R1–R5 below are otherwise unchanged; only the absolute path substituted for `<repo>` differs. See `skills/dev-full/SKILL.md` PHASE B (B2′/B3′) for when this applies.

**Producer's fix (between rounds):** In the design loop the Claude designer revises. In the code loop the **Codex builder** writes and revises via `codex-reply` (stateful, `workspace-write`); it receives the approved design (from `<dir>`'s `design.md` or the plan's `plan.md`) in its prompt so it builds against the reviewed design. R1 captures whatever the producer wrote, regardless of provider. **Keep the builder's response short**: it must not paste the implementation's source into its reply — the change is verified from disk, not from the response text — so its six-section report should stay around 50 lines.

**Builder delegation contract (code loop) — include these standing rules in the initial `codex` prompt; they bind every subsequent `codex-reply` fix:**
- **Baseline-relative test evidence:** before modifying code, run the relevant test set once to record the baseline failure set; report baseline vs. post-change failure counts and name any new failures, per `verification-tiers.md` Test Evidence Rules (pass the file's absolute path).
- **Fail-capability proof for new tests:** per the same rules, include break→fail→restore→pass evidence for each new test or materially strengthened assertion.
- **Build-tool caches stay out of the repo:** if the build tool writes caches or lock files under the home directory (which the sandbox denies), the **orchestrator preassigns a system-temp path in the prompt** (e.g., `GRADLE_USER_HOME` under the temp directory) — check the target repo's guidance (`AGENTS.md`/`CLAUDE.md`, or the personal untracked `CLAUDE.local.md`) for known tool-specific mappings. The builder must not invent cache directories inside the repo (they contaminate the R1 delta) or under `.harnie/`.

All Codex `codex`/`codex-reply` MCP calls assume `approval-policy:"never"` (pinned via the server's startup override); if a call fails with an MCP idle timeout or `AbortError: remote-cancel`, retry once via `codex-reply` against the registered threadId.

## R1. Capture the Fix Delta (Generated Independently by the Orchestrator)
**R1 applies to the code loop only.** For the **design loop**, the reviewed artifact is a document under `.harnie/` (`design.md` / `plan.md`), which `delta.mjs` deliberately excludes — a git delta there is always empty. So the design loop does **not** use R1's git delta: instead, **pass the design file's absolute path to the reviewer with an explicit instruction to read it before responding** — the `design.md`/`rev-N.md` path on the first review; on each re-review, the same path plus the list of changed section names, since the stateful reviewer session already holds the prior revision. The rest (R2–R5, ledger, state) is identical.

For the code loop, capture a baseline **immediately before** the change, then run the following after the change:
```
node <ROOT>/scripts/loop.mjs delta <repo> <baselineSHA> --scope <touched,paths> --out <dir>/delta.patch
```
- First review: capture the baseline immediately before the producer starts; the delta contains the full producer change. Re-review: capture a new baseline **immediately before the current fix**; the delta contains only that increment.
- If the output JSON has a non-empty `outOfScope`, an external or concurrent change occurred. Do not attribute it to the producer. Stop and coordinate according to the attribution invariant in `loop.md`. Because the delta compares the whole tree, **truly concurrent producers need isolated worktrees; in a shared worktree, serialize each producer's write-and-capture window** (non-overlapping paths alone do not prevent contamination).

## R2. Invoke the Reviewer
The criteria are the same regardless of provider (the already-read `loop.md` schema plus the applicable review criteria: `code-review.md` and `verification-tiers.md` for code, or `design-review.md` for design with the altitude stated by the caller). Only the mechanism differs.

**When the reviewer is Codex (design loop):** the reviewed artifact is a design document, so there is **no git delta** (per R1) — pass its path, not its content.
- **First review:** Call the Codex MCP `codex` tool with `sandbox:"read-only"`, `cwd:<repo>`, and the fixed review-tier model (`model:"gpt-5.6-sol"` — reviewer models are never difficulty-tiered, see `model-matrix.md` §3; installation default if model selection is unavailable). Set `developer-instructions` to the criteria. The prompt includes the task intent, constraints, and the **absolute path** to the design file (`design.md` / the relevant `plan.md` section), with an explicit instruction to read it before reviewing — `sandbox:"read-only"` denies writes only; reads succeed. Record the response's **threadId**.
- **Re-review:** Call `codex-reply` with the same threadId. Provide the **path to the revised design** plus the list of changed section names — not its content and not a git delta; the stateful thread already holds the prior revision. Never run stateless `codex review` repeatedly inside the loop; repeated full-context reads cause unbounded cost.

**When the reviewer is Claude (code loop):**
- The reviewer is the read-only **`harnie-reviewer` subagent** (tools = Read, Grep, Glob; model pinned to opus in its frontmatter) — never the orchestrator inline, and never the same actor that produced the change (here the producer is Codex, so Claude is cross-model). Its agent body already carries the criteria and output schema (Read instruction to `code-review.md`/`verification-tiers.md`/`loop.md`), so delegate via Task with only: the `<dir>/delta.patch` **path**, the previous ledger **path**, and a short scope/intent summary. Have it emit the **exact `loop.md` VERDICT/ISSUES schema**. Write its response to `<dir>/round-N.txt` — the same schema the Codex reviewer produces, so `apply` parses it identically.
- Keep it stateful the same way: preserve prior findings across rounds by pointing it at the prior ledger's path and reviewing only the **incremental delta + needed context**, never a full-codebase re-scan.
- REJECT bias applies. The reviewer must not be the builder's provider, and must be read-only (a code reviewer that can write is not a reviewer).

Either way, the review is written to `<dir>/round-N.txt` in the canonical schema before R4.

## R3. Save the Receipt
Save the raw reviewer response (Codex or Claude) unchanged as `<dir>/round-N.txt` for auditability and reproduction.

## R4. Merge the Ledger and Determine State Deterministically
```
node <ROOT>/scripts/loop.mjs apply --root <repo> \
  --ledger <dir>/ledger.json --review <dir>/round-N.txt \
  --ns <CR|DR> --state <dir>/state.json [--artifact <postSHA>] [--limit 3] [--progress auto|yes|no] [--reentry <reason>]
```
- `--root <repo>`: **Required.** The active repo root. `loop.mjs` verifies (canonical, symlink-resolved) that `--ledger`/`--state` sit inside `<repo>/.harnie`, so the state CLI cannot be turned into an arbitrary-path write primitive. `<repo>` is the same absolute path used elsewhere in the loop.
- `--ns`: `CR` for code review; `DR` for architecture or detailed-design review.
- `--artifact <postSHA>`: **Required for the code loop (`CR`)**, forbidden for the design loop (`DR`). Pass the reviewed tree SHA — the `postSHA` from this round's `delta` output (R1). `loop.mjs` is manifest/scope-agnostic, so it only records `reviewedPostSHA` in state; `execution.mjs` later recomputes `reviewedScopeHash` from `manifest.scope` at that SHA to bind verification to the reviewed tree. If it is ever omitted for a plan task, completion re-derivation fails closed (no reviewed artifact), so always pass it. **Workspace runs:** a Final Wave gate's artifact is the composite `ws:<sha256>` from `loop.mjs capture <run workroot>`; a task round's artifact stays that task's member-repo 40-hex `postSHA` (with `--root` still the run workroot) — `apply` accepts either form as long as it matches the corresponding current tree.
- `--state`: **Required**, and colocated with `--ledger` in the same review-unit `<dir>/`. The STALLED latch depends on persisted state; omitting it would let a prior STALLED be treated as round 0 and bypass re-entry, so `apply` fails closed without it. An **absent** state file is the legitimate initial state (round 0); an **existing** file must carry a valid `machineState`, or the command fails closed (a missing field is treated as tampering, not a fresh start). To block pointing a real ledger at a fresh state path, `apply` also fails closed when **ledger and state disagree on existence** (both must be absent for a first apply, or both present for an ongoing loop) or when they sit in **different parent directories**. The one residual case — pointing both `--ledger` and `--state` at a brand-new unit — is indistinguishable from a genuine new review unit and remains the caller's invariant.
- `--limit`: The stagnation limit (default 3); must be a positive integer or the command fails closed.
- `--progress`: Defaults to `auto`, which recognizes only gate progress type ③: a reduction in open blocking issue count. If the orchestrator recognizes qualitative progress type ①, new evidence, or type ②, measurable artifact improvement, pass `--progress yes` and record the rationale in the receipt. For a regression, leave it as `auto`, which means no progress unless the gate count decreases. (Applies in REVIEWING; it does **not** unlatch STALLED.)
- `--reentry <reason>`: Valid only from STALLED. Names exactly one of `new-evidence`, `external-state`, `user-decision`, or `scope-change` (assert `scope-change` only after user approval). Surface STALLED to the user first, then assert; the reason is recorded in state and the receipt. Passing it outside STALLED fails closed.
- Interpret the output as follows:
  - `needsReRequest: true`: Parsing failed, the verdict is inconsistent, or a blocking issue was omitted. The ledger and state remain unchanged. Re-prompt the reviewer (Codex via `codex-reply`, or re-run the Claude review), naming the schema error or omission.
  - `needsReentry: true`: The prior state is STALLED and no `--reentry` was given. The ledger and state remain **unchanged**, and the review is not applied — **gate progress or even an APPROVE in this round does not auto-unlatch STALLED**. Surface to the user, then re-run `apply` with `--reentry <reason>`.
  - `machineState: APPROVED`: This review unit passed.
  - `machineState: REVISING`: The producer fixes the open issues, then loops back to R2 for re-review. **Code loop:** first return to R1 and capture a new pre-fix baseline (git delta). **Design loop:** there is no R1 — the designer revises the design and re-injects the revised content (no baseline/delta).
  - `machineState: STALLED`: Stop and report the evidence, blockers, and unverified scope to the user; resume only via an explicit `--reentry` assertion.
- A `protocolViolations` entry for omitted non-blocking issues does not prevent progress, but must be recorded in the receipt.

## R5. Optional Final Sign-Off
For a substantial change or when the user requests it, run one fresh, git-aware final sign-off — **but it must stay cross-model with the producer**. For the **code loop** (producer = Codex), the sign-off is a **fresh Claude review** of the uncommitted diff (a read-only Claude agent applying the criteria); adding `codex review --uncommitted` is allowed only as an explicit **dual/auxiliary** pass, not as the sole sign-off. For the **design loop** (producer = Claude), a fresh Codex review is the cross-model sign-off. Do not use a stateless sign-off inside the iterative loop.

> **Invariant:** Every modification must be reviewed. Preserve a receipt containing the session, verdict, ledger, progress rationale, and fix summary. The work is not done while any blocking issue remains open.
