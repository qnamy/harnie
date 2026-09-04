---
name: software-design-review
description: Reviews a software design document before implementation starts, and drives rounds of review and revision — three on its own, and more only when the user releases them. Finds decisions left for the implementer to make, environment claims not grounded in the repository, a verification step that never reaches the change, uncovered requirements, dropped or silently settled open items, and mechanisms nothing needs. Use once a design document exists and before code is written. Do NOT use for visual, UI, or graphic design, for code or PR review, to author a design document, or for in-loop review inside the harnie dev pipeline — that one belongs to instructions/design-review.md and instructions/loop.md.
---

# Software Design Review

**Two roles share this file. Decide which you are before reading on, and read "Both roles, never" at the end either way.**

- Asked to review a design file → you are the **reviewer**. Read §Reviewer. Write nothing but your own result, start no session, dispatch no one.
- Asked to run or continue a design review → you are the **coordinator**. Read §Coordinator, and read §Reviewer only to write the reviewer's instructions.
- **A session that wrote the design never reviews it alone.** If you wrote this design and were asked to review it, you are the coordinator: stand up a reviewer that does not carry your reasoning.

The failure this exists to prevent: a design that reads well, is implemented faithfully, and turns out to rest on a fact nobody checked or a decision nobody made.

## Reviewer

**Input.** The design file path (required); the requirements file path, or — when the design came from a direct request — that request's text or a stable path to it; a lens, when the coordinator named one; from round 2 on, the previous round's findings together with the coordinator's disposition record for them (`response-N.md`); the path to write the result to. **Requirement coverage is judged against whichever of the two you were given, and the result names which.** Given neither, the round fails: ask for that input and state no verdict. Never infer the requirements from the design — a review that skipped coverage cannot say 착수 가능.

**Procedure.**

1. Read the design through and restate it in one sentence. If you cannot, that is the first finding.
2. Collect every claim the design makes about its environment and check each one. Repository claims — file paths, signatures, dependency versions, migration head, how tests are run and whether they pass — are checked against this repository, and the finding carries the path you verified against. Claims cited from outside it — a library's API, a version constraint, a protocol rule — are checked against that source when this session can reach it. When it cannot and a decision rests on that claim, the claim is `discuss:`, naming who can check the source and what it blocks; only a claim no decision rests on becomes a question.
3. Sweep the MUST-find list, then the overengineering fence.
4. For each finding, write the proof that it is real (see **Finding form**).
5. Run the self-check and delete what fails it.
6. Deliver the result, in Korean. Write it to the path you were given; when you cannot write files, return it as your answer and say so — the coordinator saves it.

**MUST find.** Each of these is `issue:` when it holds.

- **Decision gaps** — an implementer with a small reasoning budget still has a core decision to make. Name the decision.
- **Fact errors** — the design asserts an environment fact that is false, or that it cannot support and did not mark as open. A decision resting on one is blocking. Report every one in the same round.
- **Verification that does not reach the change** — the design's verification step passes without exercising what was built, or does not observe the behavior the request asked for.
- **Uncovered requirements** — a stated requirement no decision covers.
- **Open items that did not survive** — reconcile every `[미결정]` in the requirements one-to-one against this design: each is either carried over, or settled with a note saying it was a technical choice left to design. One that is simply absent is blocking, and so is one stated inline with no reason, decider, or blocked work.
- **Ownership, boundaries, failure behavior** — two owners for the same data, a boundary crossed, a missing failure mode among errors, duplicates, timeouts, retries, partial success and concurrency, or a transaction/idempotency gap.
- **Self-contradiction** — two sections that cannot both be followed.
- **Cross-cutting concerns**, and only where the design actually reaches them: a new trust boundary, personal data, or money moving without the authentication, authorization, or audit trail on that path being decided.

**Overengineering fence.** Unsupported abstractions, caches, config knobs, extra round trips, hypothetical-future flexibility, and technology nothing needs are grounds for `issue:` too. Before raising anything that can only be satisfied by **adding a mechanism**, answer two questions: is the failure it prevents inside this design's stated scope, and is it not already covered? Raise it as `issue:` **only with a concrete mistake scenario**; otherwise it is `nit:` or nothing. Never stack mechanisms across rounds — withdraw an earlier demand that a later revision made unnecessary.

**Never raise.** Wording, section order, document length, or terminology taste. A redesign you would have preferred. A behavioral claim with no quotation behind it. Detail the design's own stated scope does not cover — judge it at the altitude it declares, and treat a missing lower-level decision as a finding only where that scope promised it. From round 2 on, a new `nit:`.

**Finding form.** One line each, in Korean, opening with a stable id and a severity.

| Prefix | Meaning | Blocks |
|---|---|---|
| `issue:` | A design defect the designer must fix | 착수 차단 |
| `discuss:` | A decision or a check this review cannot settle — product intent only the requester can fix, or a claim only someone with access to its source can confirm. Names its own decider and is carried into the design's `[미결정]` | 그 항목이 닿는 범위만 |
| `nit:` | Optional suggestion | 아니오 |

Ids run `D-01`, `D-02` in the order findings are first raised, and are never renumbered or reused; a later round reports the same defect under the same id. Each finding carries four things after the id: **where** (section number, decision id, or a short quotation), **what is wrong**, **the failure it produces** — with which input or state, implemented as written, produces what wrong outcome — and **the condition a fix must satisfy**, not the fix itself.

**Self-check, before delivering.**

- A finding with no failure scenario is deleted, whatever its severity felt like.
- A suspicion you could not confirm is not a finding — put it in the result as a question, unless a decision rests on it, in which case it is `discuss:` with the decider who can confirm it. This does not soften the rule above it: a fact the *design* asserts without support is a finding, and only your own unconfirmed counter-claim becomes a question.
- Severity is fixed for the life of an id. If your assessment changed, close that id and open a new one.

**Result.** Korean, one verdict line, then findings ordered by severity, then questions. State no verdict other than these three.

| Verdict | Condition |
|---|---|
| 착수 가능 | no open `issue:`, no open `discuss:` |
| 조건부 착수 | no open `issue:`, and the open `discuss:` items leave a part that can be built — name what is buildable and what is blocked |
| 착수 불가 | one or more open `issue:`, or open `discuss:` items that block the whole path |

From round 2 on, report every previously open finding as `open` or `resolved`, resolved only where you verified it in the current design. **Omission is not resolution.** A finding the coordinator rejected with a reason is settled the same way: close it `resolved` if the reason holds, or keep it `open` and restate the concrete failure it produces. Re-review covers the open findings and the revision delta, not a fresh full pass.

## Coordinator

**Stand up a reviewer.** Not yourself: a reviewer that reads the design with none of your reasoning behind it. Require three properties, and take the highest rung the environment actually offers.

1. **Fresh context** — it does not inherit this session's history.
2. **A different provider from the one that wrote the design**, whenever the environment has one. Same-family reviewers share blind spots.
3. **State across rounds** — the same reviewer thread continues, or you hand it the previous round's findings.

| Rung | Reviewer |
|---|---|
| 1 | A separate interactive session opened through orca, running a different provider's agent, told to use this skill as the reviewer |
| 2 | A cross-provider thread from this session (from Claude, a Codex thread with a read-only sandbox and a continuation id) |
| 3 | A fresh same-provider subagent — read-only by instruction only, so treat a reviewer that writes as a protocol failure |
| 4 | Ask the user to open the reviewer session |

Nothing below rung 3 is a review. Pass the reviewer its input list in full — a reviewer missing the requirements or the original request cannot judge coverage. Set a time limit on each reviewer call, 15 minutes unless the user says otherwise, and on a limit report the round failed rather than waiting. Save the result yourself when the reviewer could not write it.

**Rounds.** Round 1 is a full review. Then, per round: accept or reject each finding, apply the accepted ones to the design file yourself, and hand the reviewer the open findings plus what you changed. Write each result to `review-N.md` and each response to `response-N.md`, beside the design file unless the user names other paths.

- The loop ends when **no `issue:` is open** — not at a round count.
- **Three rounds on your own.** On reaching that limit with findings still open, stop and report them to the user. Never start a further round on your own judgment; the user releases one, and a released round carries the same scope as any re-review — the open findings and the delta that addressed them, never a fresh full pass.
- Rejected findings go to the next round **with the reason**, and the reviewer's next result settles them. If one is still open after that single exchange, put it to the user — do not argue it across rounds.

**Accepting findings.** Accept by necessity, never by severity label. Accept one that prevents a concrete failure, names a real defect, or is cheap with clear value. Reject one that only adds a mechanism with no named mistake scenario, expands scope, or is taste. Accepting everything and fixing nothing both fail this test. `discuss:` findings are not yours to settle — carry each into the design's `[미결정]` with the decider it names, the requester for intent and whoever can reach the source for an unconfirmed claim, and raise it to the user.

**The response file.** `response-N.md` is the round's disposition record, and the reviewer's input for verifying closure next round. One line per finding raised so far, in id order, four fields and no prose around them.

| Field | Rule |
|---|---|
| id | The reviewer's id, never renumbered |
| 처분 | `수용` · `기각` |
| 사유 | Required for `기각`; omit it for `수용` |
| 반영 위치 | The design section numbers the change landed in; `-` for `기각` |

A `수용` with no 반영 위치 is not verifiable, and the round is not finished until it has one.

**After applying, check the revised document yourself** before handing it back: section 6's verification still reaches the change, and every `[미결정]` carried from the requirements is still there. A revision that changes a decision breaks those two first, and that break is yours, not a reviewer finding.

**A finding never leaves the loop unrecorded.** When the loop stops with an `issue:` still open — the round limit, or the user ending it — write that finding into the design's section 7 as a `[미결정]` under its own id, carrying what that section requires — the reason (the failure the reviewer named), the user as the one who settles it, and what it blocks — so the implementation stage inherits it instead of reading a design that looks settled.

**Lenses.** One reviewer by default. **Split into lenses only when a decision in this design cannot be undone if it is wrong** — production data lost or altered, money moved, an authentication or authorization boundary changed, a contract already published to another system. At most three, and only in round 1; from round 2 a single reviewer follows the merged findings.

| Lens | Pushes | Reads |
|---|---|---|
| 과설계 | mechanisms out | the design, and this repository's existing conventions |
| 요구사항 충족 | what is missing in | the requirements file, or the original request |
| 사실 검증 | claims down | the repository, and the sources the design cites from outside it |

Give each lens four things — its objective, the finding form above, which sources to read, and what it must leave alone; without the fourth, lenses duplicate each other's work. **Lenses do not assign ids**: they report findings unnumbered and you assign the ids once, when you merge, so round 2's single reviewer inherits one unambiguous set. No lens sees another's findings. **You merge them**: drop duplicates, order by severity, and put a contradiction between two lenses to the user. Never appoint an arbiter reviewer and never take a majority vote; a judge that shares the reviewers' blind spots is worse than no judge.

## Both roles, never

- Never let the session that wrote the design review it alone — the review's value is the context it does not have.
- Never treat finding count, round count, or result length as quality.
- Never fill in a `[미결정]` on behalf of the person it names.
- Never modify any file other than the ones this skill assigns you: the reviewer writes only its result, and the coordinator changes only the design file and the round files.
- Never end the loop by dropping an `issue:`: each one ends resolved, rejected with a reason the reviewer settled, or recorded as a `[미결정]`. A non-blocking finding may end open and unfixed — report it that way rather than opening a round to close it.
