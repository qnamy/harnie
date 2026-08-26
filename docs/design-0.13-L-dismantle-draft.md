# harnie 0.13 candidate — Dismantling the L pipeline (draft, rev-0)

> Status: **analysis-only draft**. Not approved, not implemented; no code or existing document was modified. Reviewed uncommitted.
> Altitude: architecture. Targets: `skills/dev/stages/large.md`, `agents/harnie-task-runner.md`, `instructions/design-authoring-contract.md`, and the engine surface behind them.
> Premise (confirmed framing, 2026-08-26): harnie = ① a cross-model quality/evidence layer ② development automation **at size M and below** ③ a skill hub. Cross-model review (design: Claude produces → Codex reviews; code: Codex produces → Claude reviews) is **never removed by any option here**.
> Korean mirror: `design-0.13-L-dismantle-draft-ko.md` (content-equivalent).

---

## 1. Executive Summary

**Recommendation: partial dismantle — take apart L's *execution* layer only, keep its design and integration layers. And implement that dismantle in 0.13 as a zero-new-mechanism "assembly guide" (Option 1).**

Three things drove this.

1. **The boundary is set by hook ownership, not by taste.** Every machine enforcement harnie has (builder-thread attribution, approval binding, seal, completion derivation) hangs off the run sentinel's **owner session** (§3-F4). The moment execution leaves the owning session, **none** of it applies — unless that execution **bootstraps a run of its own**, in which case **all** of it applies unchanged. So "native parallel execution under a central harnie ledger" is not a middle option; it is impossible. The only workable shape is **one parallel unit = one harnie run**.
2. **In that shape most L-only machinery loses its reason to exist.** The task runner, briefs, wave scheduling, and errata-v2 in-flight propagation all exist to manage *N runners executing under a frozen central manifest*. If each unit is an independent run, that state does not exist. In particular, **errata v2 exists solely because the manifest is frozen during execution** — remove the frozen central manifest and errata's entire justification evaporates (§6).
3. **But building new machinery for it right now would violate harnie's own rules.** The mechanized form (mode `U`, dispatch-hash binding, `export-completion`) is attractive, yet it would be **new mechanism built ahead of a form that has never once been run** — exactly the pattern harnie's contest gate rejects as `overengineering`. 0.13 documents how to assemble the composition by hand with existing verbs, and revisits mechanization after two real runs.

**The strongest argument against dismantling is U-4**: the L runner path has **never been run end to end at any version** (§3-F1). Dismantling an unmeasured layer without measurement replaces unmeasured with unmeasured. The one reason that objection does not overturn the conclusion is **asymmetry**: the composition reuses the **already-exercised M path** n times, whereas L is assembled from parts that have never executed. Recombining exercised parts is a lower-variance bet. That asymmetry does *not* say "dismantling is safe" — it says **"deferring deletion costs almost nothing"**, which is why the recommendation is **freeze (stop routing) + deprecate**, not delete.

---

## 2. Questions this document answers

| # | Question | §|
|---|---|---|
| Q1 | What stays in harnie and what moves to native | §4 |
| Q2 | The integration stage's evidence contract — the minimum to keep | §5 |
| Q3 | What gets removed (task-runner, briefs, errata v2 — full disposition) | §6 |
| Q4 | Migration path and gates | §7 |
| Q5 | Arguments against | §8 |
| Q6 | Open questions | §9 |

---

## 3. Grounding (measured vs. unmeasured, kept distinct)

### F1. The L runner path has zero execution history — the starting point of this review

- `design-0.11-process.md` §2 NFR-4② requires an **L-path E2E** as a release gate and leaves it open as **[undecided U-4]**. `design-0.11-detail.md` §10 lists only the pass conditions; no target was ever chosen.
- The fcl-hmm run that grounded 0.11 was a **0.10** run, and even that run executed **entirely serially** on a shared worktree (`design-0.10-restructure.md` §11.6 — "many disjoint-scope units among 15 tasks, serial path used, rationale unrecorded"). **The parallel runner path did not run in 0.10 either.**
- **Verdict**: 0.11's L design is grounded in measurement (hmm's rounds, tokens, incidents), but **the remedy L proposes has never executed at any version**. The gate 0.11 wrote for itself — "an S canary alone is not enough to ship" — is unmet, yet 0.11.1 shipped.

### F2. Size of the L-only surface (ceiling on what removal recovers)

| Item | Size | L-only? |
|---|---|---|
| `skills/dev/stages/large.md` (+`-ko`) | 7.5KB + 8.5KB | **yes** |
| `agents/harnie-task-runner.md` (+`-ko`) | 6.0KB + 7.1KB | **yes** |
| `instructions/design-authoring-contract.md` (+`-ko`) | 2.5KB + 2.6KB | **yes** (the CONTRACT altitude exists only in L) |
| `execution.mjs` errata v2 (`errata-add/arm/set-disposition/list` + completion accounting) | ~53 references | **yes** |
| `execution.mjs` workspace mode (`repo-add`, `memberWorkroots`, `ws:` composite) | part of ~92 refs | **yes** (but §6 rules it "relocated", not removed) |
| `worktree.mjs merge` / `remove --archive-to` | ~110 lines | **yes** |
| `verify --integration`, `gates: [final-review]` | — | **no** — M also requires `integrationVerification` |
| watchdog · `rebind-arm` · seal · `capture --record` · ledger | — | **no** — S/M use them too (`set-mode S` registers implicit task `t1` as `building`) |

**Verdict**: "deleting L halves the engine" is false. What is recovered is **~34KB of docs + errata v2 + worktree merge/archive + workspace mode**; most incident-derived enforcement (seal, watchdog, ledger, receipts, approval binding) stays because S/M use it. Backlog item #2 (trimming engine bureaucracy) is **separate work**, and the correct order is dismantle → trim (the denominator changes).

### F3. What native actually provides (per the surface visible in this session)

- **`Agent` tool**: background subagents, `isolation: "worktree"` (per-agent isolated worktree, auto-cleaned if unchanged), `SendMessage` to resume with context intact.
- **`Workflow` tool**: deterministic JS orchestration (`parallel`/`pipeline`), per-agent `isolation:'worktree'`, `resumeFromRunId` with unchanged-prefix caching, `journal.jsonl` audit, concurrency cap `min(16, CPUs-2)`, and **session-connected MCP tools reachable via `ToolSearch`** (so Codex MCP is reachable — in interactive sessions).
- **Independent parallel sessions**: each with its own context, its own hooks, its own run.

**What native does not provide**: cross-model enforcement, fail-closed ledgers, one-shot approval binding, verification receipts and vacuous detection, completion derivation (honest reporting). That is why harnie remains.

### F4. Hook ownership — the fact that forces the boundary (verified in code)

1. `hooks/lib.mjs:93 resolveRoot(cwd, sessionId)` = `findRoot(cwd)` (walk up to `.harnie/active.json` or `.git`) → then that root's `.harnie/sessions/<sid>.json` binding. **A task worktree has `.git` but no `active.json`** → a session cwd'd there resolves root to that worktree, `ctx.active === false`, and **every guard is inert**.
2. `hooks/lib.mjs:112 isOwnerSession()` — every binding in `posttooluse.mjs` (builder threadId attribution, approval binding, errata/rebind binding) requires membership in `sentinel.sessionIds`. Owner membership grows **only through `bootstrapRun`'s resume path** (`execution.mjs:648`).
3. **Therefore**: moving execution outside the owning session (another session, another worktree) makes harnie's machine enforcement a **complete no-op** — with exactly one exception: **if that execution bootstraps its own run**, with its own sentinel and owner session, the S/M enforcement applies **in full**.
4. `bootstrapRun` refuses a new run while an incomplete one is active in the same root, and its error message already prescribes the remedy: *"start a new run by re-invoking this skill in a separate worktree checkout."* → **n parallel runs = n separate checkouts** is a shape the engine already assumes.

> F4 forces most of the decisions in this document. "Central ledger + native execution" is **not an option, it is impossible**; "one run per unit" is **not a preference, it is the only solution**.

### F5. Headless cannot be a parallel execution unit

`claude -p` does not load MCP servers (hooks do fire). The Codex builder is an MCP tool → **a headless unit run cannot build.** Parallel execution units can only be (a) interactive sessions the user opens, or (b) in-session `Agent`/`Workflow` agents. "Unattended L automation" is **already impossible** in the current structure, which removes one reason to keep the runner path (unattended parallelism).

### F6. Constraints from operational incident history

- **Active run worktree deleted (2026-08-26)**: a session told to "clean up worktrees and branches" deleted a *running* M run's worktree and unpushed branch → plan, design, and ledger lost. **The composition raises the number of simultaneously active worktrees to n, multiplying this exposure by n.**
- **codex routine hung-lock (2026-08-21~24)**: an MCP dispatch hang variant. n parallel Codex builders multiply that incident class by n — though the runner path carries the same exposure, so this is not a risk unique to the composition.

---

## 4. Target shape — three stages (Q1: the harnie ↔ native boundary)

L becomes a **composition, not a pipeline**.

```
[Stage 1 · harnie owns] design run  (a run that never builds)
    grounding → (ARCH → Codex DR) → task-split draft → task-scoped grounding
    → write CONTRACT → Codex DR → one approval gate
    output: CONTRACT + **dispatch pack** (n self-contained per-unit prompts)

[Stage 2 · native owns] execution — n units, each an independent harnie run
    unit i = `/harnie:dev <dispatch prompt i>` in its own checkout → an **M run**
    (own sentinel · own owner session · own baseline/seal/ledger/receipts/completion)
    parallelism, isolation and resume are native's job (separate sessions, or Agent/Workflow worktree isolation)

[Stage 3 · harnie owns] integration run  (thin)
    merge unit branches one at a time → one CR round on the merge delta → one `verify --integration`
    → Final Review, one unit (4 lenses) → completion
```

### 4.1 Boundary table

| Concern | Owner | Rationale |
|---|---|---|
| Requirements grounding, ARCH, CONTRACT design | **harnie** | Where cross-model DR applies. The only span where team design (`team-collab.md` §1) is in scope |
| Approval gate (what will be built) | **harnie** | `arm-approval` one-shot binding = the anti-self-approval invariant |
| Writing the dispatch pack | **harnie** | A derivative of CONTRACT. Prompt self-containment *is* the context isolation |
| **Parallel scheduling, worktree isolation, resume** | **native** | `Agent isolation:'worktree'`, `Workflow parallel/pipeline`, `resumeFromRunId`. harnie has no reason to build these — and 0.11 §2 already forbids them ("no schedulers or dependency-graph executors") |
| Per-unit design, build, code review, verification | **harnie (M path)** | A unit is an ordinary M run. **Zero new contracts** |
| Sequential integration, full suite, Final Review | **harnie** | Tree-bound receipts and completion derivation live here |
| Honest reporting (HARNIE_STATUS) | **harnie** | Per run (n+2 of them), each honest on its own |

### 4.2 Why "unit = M run" is forced

By F4-3, a unit without its own run gets zero enforcement. The moment it has one, **every contract that already exists in S/M comes for free**: pre-approval write block (H1), builder threadId attribution, watchdog, seal/seal-verify, `capture --record` baselines, delta scope attribution, fail-closed ledger, TASK-DETAIL design + Codex DR, the Claude CR loop, `verify` receipts, and the Stop-hook completion gate.

That is: **the composition's execution layer requires no new contract at all.** This is the core argument. Everything the runner path invented — briefs, the resume table, the canary handshake, waves, the inline-reviewer legitimacy carve-out — was needed only because it built "something that is not an M run".

### 4.3 Side effects — risks that disappear

- **Seal interleaving hazard gone** (0.10 §11.4; 3 false positives in that run): seal is whole-run-scoped. With one unit per run, another unit's `apply`/`verify` invalidating a pending seal **cannot occur by construction**.
- **Ledger namespace confusion gone** (0.10 §11.3; 2 misfiled IDs): unit ledgers live in physically different runs, so there is no cross-ID misfiling path.
- **Context budget**: the structure where one orchestrator accumulated every unit's fixed cost (hmm's dominant cost) is spread across n sessions.

---

## 5. Evidence contract for the integration stage (Q2: the minimum to keep)

The integration run must answer exactly three questions. **① Did each merged branch actually come from a completed unit run? ② Was the change the merge itself introduced reviewed? ③ Does the final tree pass the full suite?**

### 5.1 Keep (existing contracts unchanged, nothing new)

| Contract | Source | Form in the integration run |
|---|---|---|
| Fail-closed ledger `apply` (CR and DR) | `loop.md` / `loop.mjs` | Unchanged, for merge-delta review and Final Review |
| `capture --record` baseline + `delta` scope attribution | driver R1 | Capture `mergeBaselineSHA` before each merge (same as today's L step 6) |
| seal / seal-verify | DR-003 incident | Unchanged wherever the integration run opens a producer window (a conflict-resolution builder call) |
| `verify --integration` validity key (whole-tree artifact ‖ planHash ‖ normalized entry hash) + vacuous detection + refusal to re-run an unchanged tree | 0.11 §6-b | **Unchanged.** "Exactly one passing receipt bound to the final tree" |
| Final Review, one unit, 4 lenses (coverage · quality · runtime · scope), **no test re-runs** | 0.11 §6.3 | Unchanged. The runtime lens reads the integration receipt |
| `execution.mjs completion` derivation + Stop hook | invariant ② | Unchanged |
| Approval gate | A5 | Once, on the integration run's manifest (= list of merge units + `integrationVerification`) |
| Human-verification checklist handover | 0.11 §6.5 | The integration run aggregates each unit run's checklist |

### 5.2 The one new evidence this shape requires — proof a unit completed

**Problem**: a unit run's evidence (ledger, receipts, completion) lives in that unit's worktree under `.harnie/plan/<slug>/`. The integration run sees **only the branch**. Merging without checking lets a **STALLED-and-abandoned unit, a commit whose review never approved, or a unit with no verification receipt** enter the final tree silently — and Final Review, seeing only the merged tree, cannot tell the difference. That is a **false-approval path**, and it is precisely the hole today's L "confirmation round" plugs.

**Minimum remedy — split in two.**

- **0.13 (zero new mechanism)**: the integration run's manifest declares `unitEvidence: { workroot, slug, headSHA }` per unit, and the orchestrator reads that unit run's `completion` output **before** merging (reading is a sanctioned path) and checks **`complete === true` ∧ `headSHA === the merge branch's tip`**. On mismatch, do not merge. This is a document contract, not machine enforcement — **record that limitation explicitly.**
- **0.14+ (only after two real runs)**: add `execution.mjs export-completion --root <unitWorkroot> --slug <slug> --out <file>` and have the integration run's `validateManifest` check the file's signature and `headSHA` match fail-closed. The **concrete mistake scenario** above is already stated, so this mechanism is not a contest-gate `overengineering` target — but build it **after the mistake is observed at least once** (rule of one, not three: false approval is severe enough to promote on a single observation).

### 5.3 Merge review depth — shallower than today's L

Today's L step 6 runs a **full confirmation review unit** per merge (confirmation tier, delta from `mergeBaselineSHA`, prior unit verdict as context). In the composition that is **redundant** — the unit run already reviewed and approved its own delta in full. Instead:

- **One CR round on what the merge itself introduced** (conflict resolution + semantic drift). Zero conflicts and a purely fast-forward-like delta → record it, no round.
- Cross-unit coherence (contract violations, duplicated implementations, interface drift) is carried by **Final Review's coverage and scope lenses** — that is what the 4-lens checklist is for.
- **Invariant preserved**: "every modification is reviewed" holds — the merge commit is a modification and its delta is the review target.

**Unverified assumption**: whether collapsing the full confirmation review into one merge-delta round is safe is unknown (L never ran, so the confirmation round's real yield is unmeasured). → **U-C**.

---

## 6. Removal disposition (Q3: exhaustive)

| Item | Disposition | Rationale |
|---|---|---|
| `agents/harnie-task-runner.md` (+`-ko`) | **remove** (deprecate in 0.13 → delete after 2 real runs) | Its reason to exist is "an execution unit that is not an M run". If the unit *is* an M run, every part of the runner (resume table, canary handshake, inline-reviewer carve-out, `contract-conflict` halt) is either already in the M path or unnecessary |
| Task briefs (`tasks/t<id>-brief.md`, `.vN` reissue) | **replaced** by dispatch prompts | The brief's purpose (context isolation so a runner never reads a 100k document) is achieved more strongly by "an independent session starting from a self-contained prompt". The `.vN` reissue, the edition token, and the edition term in the `dr:` hash all disappear with it |
| Execution-wave scheduling (repeat 5→6, deps-satisfied checks, newly-eligible dependents) | **remove → native** | 0.11 §2 already bans "schedulers and dependency-graph executors" while `large.md` step 5 is effectively one. `Workflow pipeline` or independent sessions replace it |
| **errata v2 in-flight propagation** (`errata-add/arm/set-disposition`, TaskStop→reissue→respawn, `rebind-task --reason correction:`, the deps-descendant verify-only rule) | **remove** | **Its sole reason to exist is a central manifest frozen during execution.** With independent unit runs, a CONTRACT defect means: stop dispatching → revise CONTRACT → re-dispatch affected units (cost = discarding one unit run). Scope/verification changes inside a unit are handled by that unit's own A5.2. Note: the promotion evidence recorded in the `design-errata-v2-deferred` memo ("errata.md hand-tampering observed") applies to **run-level documents only** |
| `worktree.mjs merge` / `remove --archive-to` | **keep (relocated)** | The integration run uses both. `--archive-to`'s unit-review preservation matters *more* in the composition, since evidence is scattered across n worktrees |
| Workspace (multi-repo) mode, `repo-add`, `ws:` composite | **keep (relocated)** | The composition suits it better (a repo's unit = that repo's run). The integration run still needs per-repo `verify --integration`, so `repo` keys and `ws:` composites remain. **Listing it as "removed" would overstate the savings** |
| `instructions/design-authoring-contract.md` | **keep, revise** | CONTRACT is **promoted** to the composition's central artifact. Revision = add a "dispatch unit" column to the split table, drop brief-related wording |
| `skills/dev/stages/large.md` | **full rewrite** | Pipeline procedure → three-stage assembly guide (design-run procedure / dispatch-pack spec / integration-run procedure) |
| `gates: [final-review]`, `verify --integration`, `integrationVerification` | **keep** | M uses them too (F2). The integration run merely becomes the main consumer |
| seal · watchdog · `rebind-arm` · `capture --record` · ledger · approval binding | **keep** | Not L-only. Judged separately under backlog item #2 |
| The runner's "the runner writes no source" inline-reviewer justification | **dissolves** | In a unit run the reviewer is the `harnie-reviewer` subagent (the normal path) — the carve-out is simply unnecessary |

**Estimated recovery**: of ~34KB of docs, ~21KB deleted outright (runner + `large.md` procedure), errata-v2 engine (~53 references) removed, ~8KB of new text written. Net ≈ 13KB of docs plus one engine subsystem.

---

## 7. Migration path (Q4)

**Principle: delete nothing before the replacement is demonstrated.** U-4's lesson is not "delete L" but "do not ship without measurement" — and that lesson applies to the replacement just as much.

### Stage 0 — freeze routing + assembly guide (0.13.0, zero new mechanism)

1. Stop **automatic L routing** in the size judgment in `commands/dev.md` / `SKILL.md`: when L conditions are detected, do not auto-enter the pipeline — **present the assembly guide and get the user's choice** (proceed with the design run only, or explicitly select the legacy runner path).
2. Rewrite `stages/large.md` as the three-stage assembly guide. Keep the runner path's file but head it `DEPRECATED — unvalidated (U-4). Explicit selection only.`
3. Add a dispatch-pack section to `design-authoring-contract.md` (what a self-contained per-unit prompt must carry: one-paragraph goal / scope paths / cited contract sections / Env Fact Sheet / scope-test set / base branch / prohibitions).
4. Write the integration run's `unitEvidence` check as a document contract (§5.2, 0.13 row).
5. **State the operating precondition**: n units = n separate checkouts (`git worktree add`). As defense against the worktree-deletion incident (F6), add one line to `large.md`: cleanup instructions must enumerate their targets explicitly.

### Stage 1 — pilot (this is the measurement that replaces U-4)

**Target: a small, real, two-task L.** Two tasks rather than a six-task E2E because what is being measured is not throughput but **whether the boundary holds**.

Measurements (fixed in advance):

| # | Question | Pass criterion |
|---|---|---|
| P1 | Does a unit session in a sibling worktree bootstrap its own run cleanly? | sentinel created, owner session registered, H1 observed firing |
| P2 | Do two unit runs' Codex builders interfere? | correct threadId attribution; no hung lock (F6) |
| P3 | Does the integration run merge both branches and leave exactly one `verify --integration` receipt? | all three validity-key components match; not vacuous |
| P4 | Total human gates | design 1 + units 2 + integration 1 = 4. **Whether that is acceptable is the user's call** (§8-C3) |
| P5 | Total rounds and tokens | vs. the estimate for the same work as a single M run |

**On failure**: keep only Stage 0's guide and stop before Stage 2. Whether to withdraw the runner path's deprecation is decided then.

### Stage 2 — flip the default (after the pilot passes)

L conditions default to the assembly guide. The runner path moves to `stages/large-runner-legacy.md`, kept one version.

### Stage 3 — delete (only after ≥2 completed composition runs)

Delete the runner agent, briefs, waves, and errata v2. Mechanizing `export-completion` is judged separately, **only after §5.2's mistake scenario has actually been observed at least once**.

---

## 8. Arguments against (Q5)

**C1 — Replacing unmeasured with unmeasured.** L is a design that absorbed 4 rounds of Codex ARCH review and 2 rounds of detail review. Discarding it on zero measurements in favor of a composition with zero measurements is evidentially symmetric. — **Partial rebuttal**: the composition is n-fold reuse of the M path, which has execution history, so per-part variance is lower (§1-3). But **validated parts do not make a validated assembly.** This objection is why Stage 1 is a mandatory gate, and why the recommendation is **freeze, not delete**.

**C2 — Loss of global visibility during execution (the strongest objection).** In L, main holds the CONTRACT and sees every runner's exit report → it catches cross-task drift early, and when two runners flag the same contract clause it immediately knows the CONTRACT is defective. In the composition, n sessions each see only their own prompt → **drift stays latent until merge**, when it is most expensive to fix. Having no central recipient for `contract-conflict` is a real regression. **Mitigations, all with costs**: ⓐ do nothing (find it at merge); ⓑ unit runs append contract conflicts to a shared file the design session polls; ⓒ one read-only "contract coherence" scout before integration. → **U-D. This document does not settle it.**

**C3 — Human gates multiply by n.** Today's L covers everything with one approval. The composition needs design 1 + units n + integration 1 = **n+2**. At n=4 that is 6 — a plain regression for a single operator. Mitigations considered: (i) make units **size S** (no approval gate) — but S also skips TASK-DETAIL design and DR, and the root cause of hmm w7's 9 rounds was a fact gap at exactly that layer, so **unsuitable**; (ii) a new **mode `U`** (= M minus the approval gate) that only starts when the dispatch file's hash appears in the approved CONTRACT's dispatch index — the logic being that approval already happened at CONTRACT, and the anti-self-approval invariant survives because the hash is bound to a user-approved document. **But that is a new mode plus a new binding, and building it before the pilot is overengineering.** Out of scope for 0.13 → **U-B**.

**C4 — The Workflow path is unvalidated for builds.** Whether a Workflow agent can hold a Codex MCP thread across multi-round builds, whether hook root resolution (based on the parent session's cwd) stays consistent with an isolated worktree, and whether Workflow's own resume model conflicts with harnie's disk-based resume — all unmeasured. **This document therefore defaults the execution layer to independent interactive sessions and recommends Workflow only for design-stage fan-out (n scouts) and for the pilot's mechanical checks.**

**C5 — Workspace support does not disappear.** The multi-repo machinery (`repo-add`, `ws:` composites, per-entry `repo`) is **relocated** to the integration run. Reading "dismantle L" as "delete the workspace code" overstates the expected savings.

**C6 — n-fold increase in incident exposure.** n simultaneously active worktrees multiplies F6's deletion exposure by n. Backlog item #4 (a run-worktree lock marker) becomes a **precondition** of this proposal.

**C7 — Ordering dependency.** Doing backlog #2 (engine bureaucracy trim) first means auditing code the dismantle would delete. **Dismantle → trim** is the right order.

---

## 9. Open questions (Q6)

| ID | Question | How to decide | What it blocks |
|---|---|---|---|
| **U-A** | Do hooks fire and pass `isOwnerSession` in (a) a Workflow agent, (b) an `Agent` with `isolation:'worktree'`, (c) an independent interactive session in a sibling worktree? | (c) via Stage 1 P1. (a)(b) via a separate one-call canary | Choice of carrier for the execution layer |
| **U-B** | The n+2 human-gate problem — n honest gates vs. mode `U` + dispatch-hash binding | User's call after Stage 1 P4; if adopted, one Codex DR round is mandatory | Stage 2 |
| **U-C** | Is one merge-delta round a safe replacement for today's full confirmation review? | Observe in the pilot what the merge-delta review actually catches | Finalizing §5.3 |
| **U-D** | Who watches for contract drift during execution — nobody / shared-file append + polling / a pre-integration coherence scout | Whether drift actually occurred in the pilot | Mitigating C2 |
| **U-E** | Interference among n parallel Codex MCP builders (rate limits, thread confusion, hung locks) | Stage 1 P2 | Parallelism ceiling |
| **U-F** | Is the runner path worth keeping as legacy? | F5 (headless cannot use MCP) already removes the "unattended parallelism" case → leans toward deletion. Settle at Stage 3 | Stage 3 |
| **U-G** | What size is the integration run (reuse M vs. a new mode `I`)? | Measure in the pilot whether an M manifest can express it | Stage 2 |

---

## 10. Option comparison (basis for the recommendation)

| | **Option 0** keep as-is | **Option 1** freeze + assembly guide **(recommended)** | **Option 2** mechanize the composition | **Option 3** delegate to Workflow |
|---|---|---|---|---|
| Content | Keep L; actually perform the U-4 E2E once | Stop auto-routing to L; document the three-stage composition using existing verbs; deprecate the runner | mode `U` + dispatch hash + `export-completion` | Move the execution layer into a Workflow script |
| New mechanisms | 0 | **0** | 3 | 1+ (unknown) |
| Upfront cost | One L E2E (needs a large real job — deferred for over a year) | ~1 day of doc rewriting | Option 1 + engine work | Many unmeasured risks (C4) |
| Fits the framing ("automation at M and below") | ✗ keeps L automated | ✓ | △ re-expands automation | △ |
| Fits "overengineering is a defect" | △ keeps what already exists | ✓ | ✗ mechanizes before evidence | ✗ |
| Cost to reverse | — | low (nothing deleted) | medium | high |
| Residual risk | An unvalidated layer keeps receiving traffic | C2 (latent drift) and C3 (n× gates) unresolved | U-B needs a self-approval analysis | all of C4 |

**Why Option 1**: it realizes the framing immediately with zero new mechanism; it deletes nothing, so it does not take on C1's unmeasured-for-unmeasured risk; and the Stage 1 pilot supplies the measurement U-4 demanded **at a far lower price (two tasks)**. Option 2 becomes justified only once the pilot confirms C3 is a real problem.

---

## 11. What this draft deliberately leaves open

- The integration run's exact manifest schema (pending U-G).
- Final wording of the dispatch pack (only the item list in §7 Stage 0-3 is fixed here).
- When the runner path is deleted (Stage 3, conditional).
- Whether to actually enable team design (`team-collab.md`) at the CONTRACT stage — this document only restates that team design applies to **Stage 1 only**, per that file's existing §1 scope; the activation judgment (inert while its three preconditions are unmet) is separate.
