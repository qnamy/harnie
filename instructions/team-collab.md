<!-- wired 2026-08-26; see §8 for runtime gate -->

# Team Collaboration Profile (harnie layer)

General Agent Teams rules — routing (5-question test), hard rules, member axes, templates, known limitations — live in `~/workspace/agent-ops/claude/agent-teams.md` and are **not restated here**. Read that file first; this document adds only what is harnie-specific. On conflict, the general file owns team mechanics and this file owns harnie's pipeline integration. If that file is unreadable in this environment, see §8 gate 4 — the profile stays inert rather than proceeding on an unresolved test.

## 1. Where it applies

Two places only:

- **`harnie:dev` design stages** — the L stage's ARCH step (`design/arch-rev-N.md`) and CONTRACT step (`design/contract-rev-N.md`).
- **Incident analysis** — the T-B competing-hypothesis template, artifact path named by the orchestrator.

At those points, when the general file's ≥3-of-5 test passes **and the user consents in the same turn**, upgrade the single `harnie-designer` subagent to a team. Everything else in the pipeline (grounding, build, code review, verification, S/M sizes) never forms a team.

## 2. Composition

- Teammates **reference existing functional agent definitions** — `harnie-scout` (explorer roles), `harnie-designer` (designer / artifact owner). Domain specialization is injected through the spawn prompt; never add new agent definitions for a team. The general file's thinking lenses (`skeptic-challenger` · `simplicity-advocate` · `ops-risk`) also ride on `harnie-scout` as spawn-prompt injections — at most 1–2 per team.
- `harnie-reviewer` is **never** a teammate. A challenger role inside a team is an explorer, not a reviewer.
- ≤4 teammates. State each teammate's model **explicitly at spawn**, from `instructions/model-matrix.md` (e.g. ARCH designer = fable only at very-hard difficulty, otherwise per the matrix; CONTRACT designer = sonnet/opus by difficulty; `harnie-scout` = haiku; a T3 challenger = opus).
- A teammate referencing a subagent definition inherits its `tools:`/`model:` but not `skills:`/`mcpServers:` — restate any needed instruction path in the spawn prompt.

## 3. Write scope

- Exactly **one artifact owner** per team phase, writing **one file** at the path the orchestrator names (e.g. `design/contract-rev-N.md`). All other teammates are read-only contributors that report through messages.
- **No source-code writes** in a team phase — team phases are design/analysis only.
- Teammates **never call `.harnie/` CLIs** (`execution.mjs`, ledgers, approval gates). Authority state stays with the orchestrator; a teammate that believes state must change reports it, and the orchestrator makes the call.

## 4. Completion

Judge complete only when both hold: the artifact **exists on disk and the orchestrator has read it** ∧ the **owner's result message** has been received. An idle notification alone is never completion — it carries no output.

Teammate messages and idle notifications arrive only at the lead's turn boundaries; when the orchestrator needs the result mid-turn, **pull the artifact from the named path** instead of waiting. If the owner goes idle without a result message, **nudge once**; a second silent idle is a team anomaly (§6).

## 5. Handoff to the review loop

Team output enters the **existing DR loop without exception** — Codex as the design reviewer at the stated altitude (`n-arch/`, `n-contract/`), full ledger, contests, and revision cycle. Team-internal debate is same-provider and **does not replace a single cross-model review round**; never shorten the loop, lower the altitude, or pre-mark issues resolved because "the team already argued it".

## 6. Failure and abort

- Team state is **disposable**: teammates do not survive session loss or `/resume`. Recovery is to restart the stage from the on-disk artifact, or to degrade to a single `harnie-designer` that continues from the partial artifact.
- **Anomaly triggers**: the owner still silent after the §4 nudge, or artifact absent at the named path. On either, abandon the team and take the degradation path — do not retry the same team.
- Record the abort in `notepad.md` (one append: stage, trigger, path taken) so the run's later stages and the digest see it.

## 7. Escalation from a solo subagent

A solo `harnie-designer` that finds it needs collaboration does not form a team itself. It returns `NEEDS-COLLAB: <reason>` plus the path of its partial artifact. The orchestrator re-judges the ≥3-of-5 test, and on a pass re-runs the stage as a team with the partial artifact injected as **prior work**. That return is not a failed round: it does not count toward stagnation, the DR round counter, or the revision index.

## 8. Preconditions

Preconditions met (2026-08-26: 2 blocking E2E PASS, flag globally enabled).

All four remain runtime gates before any team is formed, and are checked at the stage boundary:

1. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is in effect for this session.
2. The session is **interactive** — headless `-p` always takes the existing single-subagent path, flag or not.
3. Both stage-2 E2E checks **PASS**: ① plugin hooks fire inside teammate sessions, ② unnamed dispatches remain ordinary subagents while the flag is on.
4. The general rules file (`~/workspace/agent-ops/claude/agent-teams.md`, §1's normative source) is **readable in this environment**. This path is machine-local, not shipped inside the plugin — an installation without it (e.g. via the marketplace, without the author's `agent-ops` checkout) cannot resolve the ≥3-of-5 test or the team mechanics it defines. On any read failure, this profile **stays inert** and `harnie:dev` takes the single-`harnie-designer` path — never form a team on an unresolved gating criterion.

Preconditions are met, but this profile stays inactive in any session where gate 1, 2, or 4 does not hold.
