---
name: implementation-review
description: Reviews the code an implementation produced against its contract — the design document when one exists, otherwise the requester's request — and drives rounds of review and revision, two on its own and more only when the user releases them. Finds open items the code answered anyway, files changed outside the contract, decisions with no code behind them, contract errors patched around locally, mechanisms nothing needed, missing failure behavior, and correctness defects in the change and its blast radius. Use once code exists and before the verification stage starts. Do NOT use to review a design, to write code beyond the findings the coordinator accepted, for visual or UI review, or for PR review at merge time.
---

# Implementation Review

**Two roles share this file. Decide which you are before reading on, and read "Both roles, never" at the end either way.**

- Asked to review a change against its contract → you are the **reviewer**. Read §Reviewer. Change no tracked file; the only file you write is your own result.
- Asked to run or continue an implementation review → you are the **coordinator**. Read §Coordinator, and §Reviewer only to write the reviewer's request.
- A session that wrote the code never reviews it alone. If you implemented this change and were asked to review it, you are the coordinator.

The failure this exists to prevent: code that runs, passes its command, and quietly answers a question the contract left open or abandons one the contract decided.

Three rules hold over everything below.

- **Every finding carries a proof, and a finding whose proof you could not construct is deleted.** A conformance finding quotes the contract and names the code location. A correctness finding names the input or state that produces the wrong outcome. A behavior claimed from a name rather than from source is not a finding.
- **The contract's decisions are settled, and this review does not reopen them.** A decision implemented as decided is not a finding because you would have decided otherwise.
- **A contract defect is not fixed here.** It goes back to the contract. Code that absorbs a contract error is the drift the implementation stage refuses, and a review that patches one re-creates it.

**The requirements are the baseline.** What is missing and what is too much are judged against the requirements or the requester's words — never against scope the code or a previous round created for itself.

Two names are kept apart here. The **verification stage** is the chain stage after this review. The **verification command** is the design's section 6 command, or, without a design, the command the implementation report names.

## Reviewer

**Input.** All five are required, the result names what it received, and missing any of them the round fails: name what is missing, ask, and state no verdict.

1. **The contract and the requirements.** The design file path, sections 1 to 7, together with the requirements file path or the requester's request verbatim; or, with no design, the request or the requirements alone. Scope is judged against the requirements, and a design does not stand in for them.
2. **The design review verdict** the implementation worked under and its `design-review-N.md` — when a design exists; a statement that the design review was skipped counts as this input. Under 조건부 착수 the blocked part is outside this review.
3. **The scope limit** the implementation was given, or a statement that it had none.
4. **The baseline commit**, as the implementation report recorded it.
5. **The implementation report**: the verification command and its real result, the files changed, and, without a design, the readings asked about and their answers.

From round 2 on, add the previous result and the coordinator's `implementation-response-N.md`. Also take the path to write the result to. From round 3 on, the request opens with the user's release of that round quoted in the user's words; a round-3-or-later request whose first line is not that quotation fails the same way: state no verdict and name the missing release. Do not infer a scope from the code or from the contract alone: a reviewer that guesses at it manufactures findings against work that was never asked for.

**Scope is two axes crossed.** Establish both before looking for anything.

- *The change axis.* `git diff <baseline>` plus untracked files, `_chain/` excepted — the chain's own artifacts live there. Nothing that predates the baseline.
- *The contract axis.* Section 3's files, narrowed by the scope limit, plus what section 3 says must not be touched. Without a design, the files the implementation report names.
- *The crossing.* A changed file neither axis authorizes is a finding, and so is a contract file that a decision needed and the change never reached. Both directions, in the same round. What the design review verdict or the scope limit kept out of this implementation's reach is not missing.
- Unchanged lines of a function the change touched are in scope. When a signature or return shape changed, follow the call sites.
- Past roughly 400 changed lines, review in groups drawn from the contract's file list and name the grouping in the result.

**Procedure.**

1. Read the contract and restate in one sentence what this change was supposed to do. If you cannot, that is the first finding.
2. Establish both axes and cross them.
3. Sweep conformance, then correctness, then the verification evidence.
4. Construct each candidate's proof; drop what you cannot.
5. Self-check, delete what fails it, and deliver in Korean to the result path. When you cannot write files, return the result as your answer and say so.

**MUST find — conformance.** Each is `issue:` when it holds.

- **A decision with no code** — a decision this implementation was cleared to make that the change does not implement. Name it.
- **A boundary crossed** — a file changed that the contract axis does not authorize, or a change to something named untouchable.
- **An open item the code settled** — a section 7 `[미결정]` the code answers; or, without a design, a reading of the request that changes the software, decided in code with no requester's answer in the report.
- **A contract error absorbed** — the code diverges from a decision, or works around a false fact, instead of routing back. Name the contract location and the code that departs from it.
- **A mechanism nothing needed** — an abstraction, interface, config surface, cache, retry layer, extra round trip, or defensive branch away from a trust boundary that no decision and no requirement needs. Local expression — a name, a private helper's shape — is not this.
- **A failure mode left open** — a failure section 5 names, or that the request's words imply, on a path this change owns, with nothing handling it. **The requirements' stated tolerance is the ceiling**: a failure the requester accepts is not missing handling.

**MUST find — correctness.** Three angles over the change axis.

- **Removed behavior.** For every deleted or replaced line, ask whether it carried an observable behavior or an invariant. The finding exists only when you can show the new code does not re-establish it: a dropped guard, a narrowed validation, a removed error path, a deleted test over a real case. A line that carried none — a comment, dead code, a rename's other half — is not a finding.
- **Blast radius.** For every changed signature, return shape, raised error, or ordering dependency, check each call site for what breaks: a new precondition, an unhandled value, a timing assumption.
- **The hunks themselves.** Read every hunk and the function around it. For each line, name the input, state, timing, or platform that makes it wrong: an inverted condition, an off-by-one, a null dereference on a reachable path, a falsy-zero check, a missing await, a wrong-variable copy, an error swallowed where it should propagate.

**Verification evidence.** The report's command and its real result are the evidence; comparing them to the pass condition is your work. `issue:` belongs to a report that omits the command, reports a result that fails the condition, contradicts itself, or names a command that passes without reaching the change. A failure attributed to the baseline without that same command run at the baseline is `issue:`; an attribution reported as unknown is not. Under a scope limit, a part of the verification the report attributes to a scope that has not landed yet is waiting, not failing — say so in the scope line; a failure inside this scope is a failure. A new test that structurally cannot fail is unverified scope. Run the command yourself only when this environment permits it and it changes no tracked file; otherwise judge the report and say the check was downgraded. The test bar runs both ways: business logic and logic whose failure is expensive — money, data integrity, security, irreversible side effects — must have a test, and coverage numbers, tests for trivial code, and tests for framework wiring are past the bar.

**Never raise.** A decision implemented as decided that you would have decided differently. A defense against a failure the contract excludes or the requirements accept. A defect that predates the change and that the change neither introduced nor worsened — one 참고 line outside the findings and the verdict. Formatting, whitespace, import order, naming, style, comment content. Test breadth past the bar. A finding already rejected with a reason that still holds. The contract document's wording. Anything the requirements do not put in scope. From round 2 on, a new `nit:`.

**The fence.** A finding that can only be satisfied by **adding a mechanism** names the requirement, or the failure inside the requirements' scope, that needs it, with a concrete mistake scenario; otherwise it is `nit:` or nothing. Withdraw an earlier demand a later revision made unnecessary.

**Finding form.** One line each, in Korean, opening with a stable id and a severity.

| Prefix | Meaning | Blocks |
|---|---|---|
| `issue:` | A defect the change must fix, or a contract defect to route back | 검증 착수 |
| `discuss:` | A decision or check this review cannot settle. Names its decider | That item's reach only |
| `nit:` | Optional suggestion | No |

Ids run `C-01`, `C-02` in the order first raised, never renumbered or reused. Severity is fixed for an id's life; if it changes, close the id and open a new one. After the id: **where** — `file:line`, the contract location, or both when the finding pairs them; **what is wrong**; **the failure it produces**; **the condition a fix must satisfy**, not the fix, and whether it belongs in the code or in the contract; and, for any finding whose fix adds something, **the requirement it rests on**.

**Self-check.** A finding with no proof is deleted, and so is an additive finding with no requirement behind it. A suspicion of your own you could not confirm is a question, or `discuss:` when a decision rests on it; a claim the code or the report makes without support stays a finding. Both crossing directions were checked, and the scope line says so.

**Result.** Korean, in this order: the scope line, the verdict line, findings by severity, questions, any 참고 line. The **scope line** names the baseline, the contract axis, the design review verdict worked under (or that there was no design), whether both crossing directions were checked, and whether the verification command ran or was downgraded. A verdict with no scope line is not a result. From round 2 on, report every earlier finding as `open` or `resolved`, resolved only where verified in the current code — omission is not resolution. A finding the coordinator rejected with a reason closes if the reason holds; otherwise it stays open with its failure restated. Re-review covers the open findings and the revision delta.

| Verdict | Condition | Allows |
|---|---|---|
| 검증 착수 가능 | No open `issue:`, no open `discuss:` | The verification stage starts on the whole change |
| 조건부 착수 | No open `issue:`; the open `discuss:` items leave a part untouched — name both parts | The verification stage starts on the released part |
| 착수 불가 | An open `issue:`, or `discuss:` items blocking the whole path | Nothing; the change returns to the coordinator |

## Coordinator

**The reviewer.** Open, through orca, one interactive session in this worktree running the other provider's agent — from Claude, Codex; from Codex, Claude — and tell it to act as this skill's reviewer. It starts with none of your context and the same session continues across rounds. Open it with the narrowest write surface that runtime offers — `_chain/` writable, the rest of the tree not — since nothing else enforces that the reviewer writes only its result. When the runtime cannot draw that line, open it anyway and rely on this skill's rule; never open it read-only, which blocks the result file. Requests and results travel as files. When orca is not available, ask the user to open that session. Nothing else is a review: not this session, not a same-provider subagent. Give each round a time limit, 15 minutes unless the user says otherwise, and report a failed round instead of waiting.

**The request.** Pass all five inputs. The baseline comes from the implementation report; when the report has none, it is the commit the tree was clean at when implementation started, and pre-existing uncommitted work is committed as its own commit first — never stashed. The requirements go as the file path or the requester's words verbatim, never your restatement.

**Rounds.** Round 1 is a full review. Per round: accept or reject each finding, apply the accepted ones, and hand back the open findings plus what you changed. Results go to `implementation-review-N.md` and dispositions to `implementation-response-N.md`, in `_chain/` — wherever the design itself lives — unless the user names other paths. `N` counts every round this chain has run, restarts and route-backs included; a number is never reused, a result file is never overwritten, and no round file carries a name other than its number.

- The loop ends when no `issue:` is open — not at a round count.
- **Two rounds on your own.** At that limit with findings still open, stop and report them to the user. A round the user releases has the same scope as any re-review. A released round's request opens with the user's release quoted in their words; a decision the user made on a `discuss:` item is not a release.
- A rejected finding goes to the next round with its reason. If it is still open after that one exchange, put it to the user.

**Accepting.** By necessity, never by label. Accept what prevents a concrete failure inside the requirements, names a real defect, or is cheap with clear value. Reject what adds a mechanism with no named failure, expands scope past the requirements, or is taste. **Before accepting a fix that adds a runtime mechanism — state, retry, lock, controller, health check — first check whether removing something, narrowing scope, or leaving it to observation closes the finding. When a finding arose from the previous round's fix, evaluate reverting that fix first.** `discuss:` is not yours to settle: carry it to its decider and raise it to the user.

**Fixing.** The fix is the smallest change that removes the failure the finding named; nothing else rides along. No mechanism the contract did not decide enters as a fix. A finding whose fix is a contract decision is routed back, not fixed. Re-run the verification command after fixing and report its real output; never loosen the command or the condition to close a finding.

**Routing back.** An accepted finding that names a contract defect — a false fact, a decision that cannot be implemented as written, an uncovered requirement, a verification command that cannot reach the change — goes into the design's section 7 as a `[미결정]` under its `C` id with the reason, the decider, and what it blocks; without a design, it goes to the requester. Then the design review reopens or the user decides. Do not revise the contract's decisions yourself.

**The response file.** One line per finding raised so far, in id order, four fields: id · 처분 (`수용`/`기각`/`설계 회귀`) · 사유 (required for `기각`; for a `수용` whose fix adds a mechanism, the requirements sentence or the requester's words that need it — a `수용` that cannot quote one becomes `기각`) · 반영 위치 (`file:line` for `수용`, the contract location for `설계 회귀`, `-` for `기각`). Then one round line: the verification command and its real result after this round's fixes. A `수용` without 반영 위치 is unfinished.

**After applying, check the change yourself**: every accepted finding's 반영 위치 is real; the verification command still reaches what was built; no fix introduced a mechanism the contract did not decide; and **the code's mechanisms have not grown past round 1 without a requirement naming why**. That growth is yours to reverse, not a reviewer finding.

**Unfinished findings.** When the loop stops with an `issue:` open, write it into the design's section 7 as a `[미결정]` under its id — the reviewer's failure as the reason, the user as decider, what it blocks — or, without a design, report it to the user as open. The verification stage inherits it instead of reading a change that looks clean.

## Both roles, never

- Never let the session that wrote the code review it alone.
- Never raise or accept a finding whose proof nobody constructed.
- Never judge scope against what the code or a previous round created; the requirements are the baseline.
- Never treat finding count, round count, or result length as quality.
- Never reopen a decision the contract made and the design review cleared.
- Never fix a contract defect in the code.
- Never fill in a `[미결정]` for the person it names.
- Never split a round across sub-reviewers, lenses, or subagents: one reviewer session reads the whole input and writes the whole result.
- Never modify a file this skill does not assign you: the reviewer writes only its result; the coordinator changes only the code the accepted findings reach, the design's section 7 when routing back, and the round files.
- Never end the loop by dropping an `issue:`: each ends resolved, rejected with a reason the reviewer settled, routed into the contract, or recorded as a `[미결정]`. A non-blocking finding may end open and unfixed.
