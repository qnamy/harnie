---
name: software-design-review
description: Reviews a software design document against the requirements it was written from, before implementation starts, and drives rounds of review and revision — two on its own, more only when the user releases them. Finds decisions left for the implementer, environment claims not grounded in the repository, verification that never reaches the change, uncovered requirements, dropped open items, and mechanisms no requirement needs. Use once a design document exists and before code is written. Do NOT use for visual, UI, or graphic design, for code or PR review, or to author a design document.
---

# Software Design Review

**Two roles share this file. Decide which you are before reading on, and read "Both roles, never" at the end either way.**

- Asked to review a design file → you are the **reviewer**. Read §Reviewer. Write nothing but your own result.
- Asked to run or continue a design review → you are the **coordinator**. Read §Coordinator, and §Reviewer only to write the reviewer's request.
- A session that wrote the design never reviews it alone. If you wrote it and were asked to review it, you are the coordinator.

Two failures this exists to prevent. A design that reads well, is implemented faithfully, and rests on a fact nobody checked or a decision nobody made. And a review that grows the design past what was asked for, one accepted finding at a time.

**The requirements are the baseline, not the design.** Every judgment about what is missing or what is too much is made against the requirements file or the requester's original words — never against the scope the design declares for itself, which moves every time a finding is accepted.

## Reviewer

**Input.** The design file path. The requirements file path, or the requester's original request verbatim — a restatement by the coordinator is not an input, and given neither the round fails: ask, and state no verdict. From round 2 on, the previous result and the coordinator's `design-response-N.md`. The path to write the result to. The result names which requirements source it judged against. From round 3 on, the request opens with the user's release of that round quoted in the user's words; a round-3-or-later request whose first line is not that quotation fails the same way: state no verdict and name the missing release.

**Procedure.**

1. Read the design and restate it in one sentence. If you cannot, that is the first finding.
2. Check every environment claim. Repository claims — paths, signatures, dependency versions, migration head, how tests run and whether they pass — against this repository, citing the path you verified against. Claims from outside it — a library's API, a protocol rule — against their source when you can reach it; when you cannot and a decision rests on the claim, it is `discuss:` naming who can check.
3. Sweep the MUST-find list, then the fence.
4. Write each finding with its proof (§Finding form).
5. Self-check, delete what fails it, and deliver in Korean to the result path. When you cannot write files, return the result as your answer and say so.

**MUST find.** Each is `issue:` when it holds.

- **Decision gap** — an implementer with a small reasoning budget still has a core decision to make. Name it.
- **Fact error** — an environment fact that is false, or unsupported and not marked open. Report every one in the same round.
- **Verification that does not reach the change** — section 6 passes without exercising what was built, or without observing what was asked for.
- **Uncovered requirement** — a stated requirement no decision covers.
- **Lost open item** — a requirements `[미결정]` neither carried into section 7 nor settled with a note that it was a technical choice left to design; or one carried with no reason, decider, or blocked work.
- **Ownership, boundary, failure behavior** — two owners for one datum, a boundary crossed, a transaction or idempotency gap, or a failure mode among errors, duplicates, timeouts, retries, partial success, and concurrency that the design does not handle. **The requirements' stated tolerance is the ceiling**: a failure the requester accepts — manual recovery, a bounded outage — is not missing handling.
- **Self-contradiction** — two sections that cannot both be followed.
- **Split defect** — only when section 3 carries 병렬 단위: a file section 3 names to touch in two units or in none, a dependency on a unit not listed or a dependency cycle, the shared foundation spread over several units, or a unit marked 상세설계 위임 whose entry does not fix its interface to the other units, what it must do, or a requirement condition that binds it — that entry is the whole request its session will see. Inside such a unit, the decision-gap rule above applies to the boundary only.
- **Cross-cutting** — only where the design reaches it: a new trust boundary, personal data, or money moving without authentication, authorization, or audit decided on that path.

**The fence.** A mechanism no requirement needs — an abstraction, cache, config knob, extra round trip, boot service, state file, retry layer, future flexibility, technology — is `issue:`. The mirror rule binds your own findings: **a finding that can only be satisfied by adding a mechanism names the requirement, or the failure inside the requirements' scope, that needs it, with a concrete mistake scenario; otherwise it is `nit:` or nothing.** Handling for an external behavior nobody has observed is never demanded; it is `discuss:` asking for the observation. Withdraw an earlier demand a later revision made unnecessary.

**Never raise.** Wording, section order, length, terminology. A redesign you would prefer. A claim with no quotation behind it. Systems the requirements do not put in scope, and detail below the level the requirements ask for. From round 2 on, a new `nit:`.

**Finding form.** One line each, in Korean, opening with a stable id and a severity.

| Prefix | Meaning | Blocks |
|---|---|---|
| `issue:` | A defect the designer must fix | 착수 |
| `discuss:` | A decision or check this review cannot settle. Names its decider and is carried into section 7 | That item's reach only |
| `nit:` | Optional suggestion | No |

Ids run `D-01`, `D-02` in the order first raised, never renumbered or reused. Severity is fixed for an id's life; if it changes, close the id and open a new one. After the id: **where** (section, decision id, or a short quotation); **what is wrong**; **the failure it produces** — which input or state, implemented as written, yields what wrong outcome; **the condition a fix must satisfy**, not the fix; and, for any finding whose fix adds something, **the requirement it rests on**.

**Self-check.** A finding with no failure scenario is deleted, and so is an additive finding with no requirement behind it. A suspicion of your own you could not confirm is a question, or `discuss:` when a decision rests on it; a fact the design asserts without support stays a finding.

**Result.** Korean: one verdict line, findings ordered by severity, then questions. From round 2 on, report every earlier finding as `open` or `resolved`, resolved only where you verified it in the current design — omission is not resolution. A finding the coordinator rejected with a reason closes if the reason holds; otherwise it stays open with its failure restated. Re-review covers the open findings and the revision delta.

| Verdict | Condition |
|---|---|
| 착수 가능 | No open `issue:`, no open `discuss:` |
| 조건부 착수 | No open `issue:`; the open `discuss:` items leave a buildable part — name what is buildable and what is blocked |
| 착수 불가 | An open `issue:`, or `discuss:` items blocking the whole path |

## Coordinator

**The reviewer.** Open, through orca, one interactive session in this worktree running the other provider's agent — from Claude, Codex; from Codex, Claude — and tell it to act as this skill's reviewer. It starts with none of your context and the same session continues across rounds. Open it with the narrowest write surface that runtime offers — `_chain/` writable, the rest of the tree not — since nothing else enforces that the reviewer writes only its result. When the runtime cannot draw that line, open it anyway and rely on this skill's rule; never open it read-only, which blocks the result file. Requests and results travel as files. When orca is not available, ask the user to open that session. Nothing else is a review: not this session, not a same-provider subagent. Give each round a time limit, 15 minutes unless the user says otherwise, and report a failed round instead of waiting.

**The request.** Pass the input list in full. The requirements go as the file path or the requester's words verbatim — never your restatement, and never a list longer than what the requester wrote.

**Rounds.** Round 1 is a full review. Per round: accept or reject each finding, apply the accepted ones to the design yourself, and hand back the open findings plus what you changed. Results go to `design-review-N.md` and dispositions to `design-response-N.md`, in `_chain/` — wherever the design itself lives — unless the user names other paths. `N` counts every round this chain has run, restarts and route-backs included; a number is never reused, a result file is never overwritten, and no round file carries a name other than its number.

- The loop ends when no `issue:` is open — not at a round count.
- **Two rounds on your own.** At that limit with findings still open, stop and report them to the user. A round the user releases has the same scope as any re-review. A released round's request opens with the user's release quoted in their words; a decision the user made on a `discuss:` item is not a release.
- A rejected finding goes to the next round with its reason. If it is still open after that one exchange, put it to the user.

**Accepting.** By necessity, never by label. Accept what prevents a concrete failure inside the requirements, names a real defect, or is cheap with clear value. Reject what adds a mechanism with no named failure, expands scope past the requirements, or is taste. **Before accepting a fix that adds a runtime mechanism — state, retry, lock, controller, health check, boot service — first check whether removing something, narrowing scope, or leaving it to pilot observation closes the finding. When a finding arose from the previous round's fix, evaluate reverting that fix first.** `discuss:` is not yours to settle: carry it into section 7 with the decider it names and raise it to the user.

**The response file.** One line per finding raised so far, in id order, four fields: id · 처분 (`수용`/`기각`) · 사유 (required for `기각`; for a `수용` whose fix adds a mechanism, the requirements sentence or the requester's words that need it — a `수용` that cannot quote one becomes `기각`) · 반영 위치 (design section numbers; `-` for `기각`). A `수용` without 반영 위치 is unfinished.

**After applying, check the design yourself**: section 6 still reaches the change; every requirements `[미결정]` is still there; and **the design's mechanisms have not grown past round 1 without a requirement naming why**. That growth is yours to reverse, not a reviewer finding.

**Unfinished findings.** When the loop stops with an `issue:` open, write it into section 7 as a `[미결정]` under its id — the reviewer's failure as the reason, the user as decider, what it blocks.

## Both roles, never

- Never let the session that wrote the design review it alone.
- Never judge scope against the design's own declared scope; the requirements are the baseline.
- Never treat finding count, round count, or result length as quality.
- Never fill in a `[미결정]` for the person it names.
- Never split a round across sub-reviewers, lenses, or subagents: one reviewer session reads the whole input and writes the whole result.
- Never modify a file this skill does not assign you: the reviewer writes only its result; the coordinator changes only the design and the round files.
- Never end the loop by dropping an `issue:`: each ends resolved, rejected with a reason the reviewer settled, or recorded as a `[미결정]`. A non-blocking finding may end open and unfixed.
