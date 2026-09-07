---
name: implementation-review
description: Reviews the code an implementation produced against the design document it was supposed to execute, and drives rounds of review and revision — three on its own, and more only when the user releases them. Finds decisions the design left open that the code answered anyway, changes outside the files the design named, decisions with no code behind them, a design error patched around locally instead of routed back, mechanisms nothing decided, missing failure behavior, and correctness defects in the change and its blast radius. Use once code exists for a design and before the verification stage starts. Do NOT use on a change that has no design document, to review a design, to write code beyond the findings the coordinator accepted, for visual or UI review, or for PR review at merge time.
---

# Implementation Review

**Two roles share this file. Decide which you are before reading on, and read "Both roles, never" at the end either way.**

- Asked to review a change against a design → you are the **reviewer**. Read §Reviewer. Change no tracked file — the only file you write is your own result — and start no session, dispatch no one. Untracked output a command you were cleared to run leaves behind (a build directory, a cache) is not a write in this sense.
- Asked to run or continue an implementation review → you are the **coordinator**. Read §Coordinator, and read §Reviewer only to write the reviewer's instructions.
- **A session that wrote the code never reviews it alone.** If you implemented this change and were asked to review it, you are the coordinator: stand up a reviewer that does not carry your reasoning.

The failure this exists to prevent: code that runs, passes its command, and quietly answers a question the design left open or abandons one the design decided.

Three rules hold over everything below.

- **Every finding carries a proof, and a finding whose proof you could not construct is deleted.** What counts as proof depends on the kind: a conformance finding quotes the design section and names the code location; a correctness finding names the input or state that produces the wrong outcome. A behavior claimed from a name rather than from source is not a finding.
- **The design's decisions are settled, and this review does not reopen them.** A decision in section 2, implemented as decided, is not a finding because you would have decided otherwise. The stage that judged those decisions already ran.
- **A design defect is not fixed here.** It goes back to the design. Code that absorbs a design error is the drift the implementation stage was built to refuse, and a review that patches one re-creates it.

**Three different things sit near the word verification, and this file keeps them apart.** The **verification stage** is the chain stage after this review. The **section 6 command** is the design's own runnable check, and it is always named with its section number. The **cross-check pass** in §Coordinator judges candidate findings and never takes that word. Use these three names as written.

## Reviewer

**Input.** All five of these are required, and the result names what it received.

1. **The design file path.** Every rule below points at a section of that document, and a review that reconstructed the design from the code is judging the code against itself.
2. **The design review verdict the implementation actually worked under**, and which `review-N.md` it came from. `조건부 착수` means part of the design was never releasable to the implementer, and that part is outside this review.
3. **The scope limit the implementation session was given**, or a statement that it had none. Under a limit, the other sections 3 files belong to sessions running in parallel.
4. **The change under review**, as the coordinator pinned it (see below).
5. **The implementation stage's report** for this change, which is where the section 6 command and the result it produced come from.

From round 2 on, add the previous round's findings and the coordinator's disposition record for them (`response-N.md`). Also take the path to write the result to.

**Missing any of the five, the round fails: name what is missing, ask for it, and state no verdict.** Do not infer a scope from the code or from the design alone. What items 2 and 3 authorize is the only ground on which a missing decision or an unauthorized file can be judged, and a reviewer that guesses at it manufactures findings against work that was never asked for.

**Review scope is two axes crossed.** Establish both before looking for anything.

- *The change axis.* What this implementation produced, and nothing that predates it. The axis is a **baseline commit with the tree confirmed clean at it**: `git diff <baseline>` plus what `git status --porcelain` reports as untracked. A tree that was dirty when the implementation started does not get a second form of axis — the coordinator commits that pre-existing work first, which makes the baseline clean and every later line the implementation's (see §Coordinator). **Given no such baseline the round fails**, with one escape: the coordinator may instead name the paths the implementation touched **and** confirm that none of them carried pre-existing uncommitted work, in which case the axis is those paths and the result says so. A path that carried both is outside the axis until its pre-existing half is committed; without that, its old hunks and the implementation's cannot be told apart, and this review would attribute either one to the other.
- *The design axis.* Section 3's file list, narrowed to what the scope limit authorizes when there was one, plus what section 3 says must not be touched.
- *The crossing.* A changed file that neither axis authorizes is a finding, and so is a section 3 file that section 2's decisions needed and the change never reached. Both directions, in the same round. **A decision or a file the design review verdict or the scope limit kept out of this implementation's reach is not missing** — it was never due here, and reporting it is the false finding this crossing is most likely to produce.
- Unchanged lines of a function the change touched are in scope. When a signature or a return shape changed, follow the call sites.

**The size gate.** Past roughly 400 changed lines, review the change in groups drawn from section 3 rather than in one pass, and name the grouping in the result. Finding quality falls sharply with diff size; one pass over a large change returns the same verdict with less behind it.

**Procedure.**

1. Read the design's sections 1 to 7, then restate in one sentence what this change was supposed to do. If you cannot, that is the first finding.
2. Establish both scope axes and cross them.
3. Sweep the conformance list, then the correctness angles, then the verification evidence gate.
4. For each candidate, construct its proof. Drop what you cannot.
5. Run the self-check and delete what fails it.
6. Deliver the result, in Korean. Write it to the path you were given; when you cannot write files, return it as your answer and say so.

**MUST find — conformance.** Each of these is `issue:` when it holds.

- **A decision with no code** — a section 2 decision this implementation was cleared to make and the change does not implement. Name the decision.
- **A boundary crossed** — a file changed that section 3, or the scope limit, does not authorize; or a change to something section 3 names as untouchable.
- **An open item the code settled** — a section 7 `[미결정]` the code answers. The implementation stage was to stop on it, so the answer in the code is one nobody agreed to.
- **A design error absorbed** — the code works but diverges from what section 2 decided, or it works around a section 3 fact that turned out to be false, instead of routing that back. Name the design section and the code that departs from it.
- **A mechanism nothing decided** — an abstraction, interface, config surface, cache, retry layer, extra round trip, or defensive branch away from a trust boundary that section 2 did not decide. Local expression the design left open (a variable name, the shape of a private helper) is not this.
- **A failure mode left open** — a failure section 5 names, on a path this change owns, with nothing handling it.

**MUST find — correctness.** Three angles, each over the change axis.

- **Removed behavior.** For every line the change deletes or replaces, ask whether it carried an observable behavior or an invariant. When it did, find where the new code re-establishes it, and the finding exists only when you can show it does not: a dropped guard, a narrowed validation, a removed error path, a deleted test that covered a real case. A deleted line that carried none — a comment, dead code, a rename's other half — is not a finding, and being unable to name an invariant for it is the expected outcome rather than evidence of one.
- **Blast radius.** For every changed signature, return shape, raised error, or ordering dependency, check each call site for what the change breaks: a new precondition, a value the caller does not handle, a timing assumption.
- **The hunks themselves.** Read every hunk and the function around it. For each line, name the input, state, timing, or platform that makes it wrong: inverted or wrong condition, off-by-one, null dereference on a reachable path, a falsy-zero check, a missing await, a wrong-variable copy, an error swallowed in a catch that should propagate.

**Verification evidence.** Section 6 is the change's only independent signal, so judge it directly.

- **What counts as evidence.** The implementation stage reports the section 6 command and the result it actually produced, so that report is the evidence, and comparing it against section 6's pass condition is your work rather than the report's. It is sufficient when it names the command and that real result. **Neither raw output nor a restatement of the condition is required, and the absence of either is never a finding.** `issue:` belongs to a report that omits the command, reports a result that does not meet section 6's condition, or contradicts itself.
- Does the command reach what was built? One that passes without exercising the change is `issue:` no matter how green it is.
- Is a failure attributed to the baseline backed by that same command run against the tree as it stood before the change? An unbacked attribution is `issue:`; an attribution reported as unknown is not.
- Can a new test fail when the target behavior breaks? One that structurally cannot fail is unverified scope, not coverage.
- **Run the command yourself only when both hold**: this environment permits it, and the command changes **no tracked file at all** (untracked build output is fine). A command that rewrites a tracked generated file, a snapshot, or a lockfile would move the change you are reviewing, so it is never run here. When you cannot establish that it changes no tracked file, treat it as one that does. Then compare its output to section 6's condition rather than to the report. Otherwise judge the report against the bar above, and say in the result that this check was downgraded and why. A downgraded check is not a finding.
- The test bar, both ways: business logic and logic whose failure is expensive (money, data integrity, security, irreversible side effects) must have a test, and new or changed logic of that kind with none is `issue:`. Coverage numbers, tests for trivial code, and tests for framework wiring are past the bar, and demanding them is over-flagging.

**Never raise.** These look like findings and are not. Each is here because raising it costs a round and settles nothing.

- A section 2 decision, implemented as decided, that you would have decided differently. The design review closed that question.
- A defense against a failure section 5 judged cannot occur here, or against anything section 1 puts out of scope.
- A defect that existed before this change and that this change neither introduced nor worsened. Put it in the result as one 참고 line, outside the findings and outside the verdict. When the change worsened it, it is an ordinary finding.
- Formatting, whitespace, import order, naming, or style, unless readability is materially broken.
- Code comment content.
- Test breadth past the bar above.
- A finding the design review already rejected with a reason, or one the coordinator rejected with a reason that still holds.
- Wording, section order, or length of the design document. That review already ran.
- From round 2 on, a new `nit:`.

**Overengineering fence.** Before raising anything that can only be satisfied by **adding a mechanism**, answer two questions: is the failure it prevents inside the design's stated scope, and is it not already covered? Raise it as `issue:` **only with a concrete mistake scenario**; otherwise it is `nit:` or nothing. Never stack mechanisms across rounds, and withdraw an earlier demand a later revision made unnecessary.

**Finding form.** One line each, in Korean, opening with a stable id and a severity.

| Prefix | Meaning | Blocks |
|---|---|---|
| `issue:` | A defect the change must fix, or a design defect to route back | 검증 착수 차단 |
| `discuss:` | A decision or a check this review cannot settle — product intent only the requester can fix, or a claim only someone with access to its source can confirm. Names its own decider | 그 항목이 닿는 범위만 |
| `nit:` | Optional suggestion | 아니오 |

Ids run `C-01`, `C-02` in the order findings are first raised, and are never renumbered or reused; a later round reports the same defect under the same id. Each finding carries four things after the id: **where** — `file:line`, or the design section for a conformance finding, with both when the finding pairs them — **what is wrong**, **the failure it produces**, and **the condition a fix must satisfy**, not the fix itself. Say whether the fix belongs in the code or in the design.

**Self-check, before delivering.**

- A finding with no proof is deleted, whatever its severity felt like.
- A suspicion you could not confirm is not a finding. Put it in the result as a question, unless a decision rests on it, in which case it is `discuss:` with the decider who can confirm it. This does not soften the rules above it: a claim the *code* or the *report* makes without support is a finding, and only your own unconfirmed counter-claim becomes a question.
- Severity is fixed for the life of an id. If your assessment changed, close that id and open a new one.
- Did both crossing directions get checked, or only the changed files? Write the answer into the scope line either way.

**Result.** Korean, in this order: the scope line, the verdict line, findings ordered by severity, questions, any 참고 line.

The **scope line** is one line naming what this round actually covered, so a skipped check is visible instead of silent: the baseline the change axis came from, or the named paths and the confirmation behind them, the design axis it was crossed with (the section 3 files, narrowed by the scope limit), the design review verdict this implementation worked under, whether both crossing directions were checked, and whether the section 6 check ran or was downgraded. A verdict with no scope line behind it is not a review result.

The **verdict** is one of these three and nothing else. Each names the transition it allows, and the only transition at stake is whether the chain's verification stage may start. Judge by whether the change does what the design decided and leaves the code no worse; perfection is not the bar.

| Verdict | Condition | Allows |
|---|---|---|
| 검증 착수 가능 | no open `issue:`, no open `discuss:` | the verification stage starts on the whole change |
| 조건부 착수 | no open `issue:`, and the open `discuss:` items leave a part untouched — name what is releasable and what is blocked | the verification stage starts on the released part only |
| 착수 불가 | one or more open `issue:`, or open `discuss:` items that block the whole path | nothing; the change returns to the coordinator |

From round 2 on, report every previously open finding as `open` or `resolved`, resolved only where you verified it in the current code. **Omission is not resolution.** A finding the coordinator rejected with a reason is settled the same way: close it `resolved` if the reason holds, or keep it `open` and restate the concrete failure it produces. Re-review covers the open findings and the revision delta, not a fresh full pass.

## Coordinator

**Stand up a reviewer.** Not yourself: a reviewer that reads the change with none of your reasoning behind it. Require three properties, and take the highest rung the environment actually offers.

1. **Fresh context** — it does not inherit this session's history.
2. **A different provider from the one that wrote the code**, whenever the environment has one. Same-family reviewers share blind spots, and a model reviewing its own output drifts toward approving it.
3. **State across rounds** — the same reviewer thread continues, or you hand it the previous round's findings.

| Rung | Reviewer |
|---|---|
| 1 | A separate interactive session opened through orca, running a different provider's agent, told to use this skill as the reviewer |
| 2 | A cross-provider thread from this session, with a read-only sandbox and a continuation id |
| 3 | A fresh same-provider subagent — read-only by instruction only, so treat a reviewer that writes code as a protocol failure |
| 4 | Ask the user to open the reviewer session |

Nothing below rung 3 is a review. **Pass all five of §Reviewer's required inputs, and establish the change axis yourself.** A reviewer left to derive the delta from the branch or from the current tree reviews work the implementer never touched. When the tree was not clean at the point the implementation started, commit that pre-existing work as its own commit and use it as the baseline; never set it aside on the stash stack, which other sessions share. Only when that is impossible, fall back to naming the touched paths and confirming that none of them carried pre-existing uncommitted work. Set a time limit on each reviewer call, 15 minutes unless the user says otherwise, and on a limit report the round failed rather than waiting. Save the result yourself when the reviewer could not write it.

**Rounds.** Round 1 is a full review. Then, per round: accept or reject each finding, apply the accepted ones, and hand the reviewer the open findings plus what you changed. Write each result to `review-N.md` and each response to `response-N.md`, beside the design file unless the user names other paths.

- The loop ends when **no `issue:` is open** — not at a round count.
- **Three rounds on your own.** On reaching that limit with findings still open, stop and report them to the user. Never start a further round on your own judgment; the user releases one, and a released round carries the same scope as any re-review.
- Rejected findings go to the next round **with the reason**, and the reviewer's next result settles them. If one is still open after that single exchange, put it to the user rather than arguing it across rounds.

**Accepting findings.** Accept by necessity, never by severity label. Accept one that prevents a concrete failure, names a real defect, or is cheap with clear value. Reject one that only adds a mechanism with no named mistake scenario, expands scope, or is taste. Accepting everything and fixing nothing both fail this test. `discuss:` findings are not yours to settle: carry each to the decider it names and raise it to the user.

**Fixing.** The fix is bound by the same contract the code was written under, and this is where a review turns into overengineering if it is not.

- The fix is the **smallest change that removes the failure the finding named**. Nothing else rides along.
- **No mechanism section 2 did not decide** enters the code as a fix: no abstraction, no config surface, no defensive branch away from a trust boundary, no test for a case that cannot occur.
- **A finding whose fix is a design decision is not fixed here.** Route it to the design (see below) and say so in the response file.
- **Re-run section 6 after fixing** and report its real output. Never loosen the command or the pass condition to close a finding.

**Routing a finding back to the design.** An accepted finding that names a design defect — a false fact in section 3, a decision in section 2 that cannot be implemented as written, a requirement no decision covers, a section 6 command that cannot reach the change — is recorded in the design's section 7 as a `[미결정]` under its own `C` id, carrying what that section requires: the reason, who settles it, and what it blocks. Then either the design review reopens or the user decides. Do not revise the design's decisions yourself, and do not implement your own version of one.

**The response file.** `response-N.md` is the round's disposition record, and the reviewer's input for verifying closure next round. It has two parts and no prose around them.

One line per finding raised so far, in id order, four fields each.

| Field | Rule |
|---|---|
| id | The reviewer's id, never renumbered |
| 처분 | `수용` · `기각` · `설계 회귀` |
| 사유 | Required for `기각`, and for any finding a cross-check pass ruled on — carry the ruling word and the proof it quoted. Omit it for a plain `수용` |
| 반영 위치 | `file:line` for `수용`, the design section for `설계 회귀`, `-` for `기각` |

Then one round-level line, once, after the finding lines: the section 6 command and the real result it produced after this round's fixes.

A `수용` with no 반영 위치 is not verifiable, and the round is not finished until it has one.

**A cross-check pass, only when the change cannot be undone.** By default the reviewer's own proof requirement is the gate. Add a separate cross-checker — one per finding, fresh context, reading only the finding, the design, and the code it points at — when the change touches production data, moves money, or alters an authentication or authorization boundary. **This pass can only remove a finding, never soften one**, so it introduces no state the finding form and the verdict do not already have. Two rulings:

| Ruling | Condition | Effect |
|---|---|---|
| `기각` | Constructible from the code: the claim is factually wrong (quote the actual line), impossible from a type, constant, or invariant (show it), already handled in this change (cite the guard), or has no observable effect | The id closes, and the quoted proof is the rejection reason |
| `유지` | Anything else, including a real mechanism whose trigger is uncertain | The finding stands exactly as the reviewer raised it, at its severity |

Record both rulings in `response-N.md`'s 사유 field with the ruling word and its proof, so the next round can re-examine the judgment instead of inheriting it blind. Never appoint an arbiter over two cross-checkers and never take a majority vote; a judge that shares their blind spots is worse than no judge.

**After applying, check the change yourself** before handing it back: every accepted finding's 반영 위치 is real, section 6 still reaches what was built, and no fix introduced a mechanism section 2 did not decide. That last one is yours, not a reviewer finding.

**A finding never leaves the loop unrecorded.** When the loop stops with an `issue:` still open — the round limit, or the user ending it — write it into the design's section 7 as a `[미결정]` under its own id, with the failure the reviewer named, the user as the one who settles it, and what it blocks, so the verification stage inherits it instead of reading a change that looks clean.

## Both roles, never

- Never let the session that wrote the code review it alone — the review's value is the context it does not have.
- Never raise or accept a finding whose proof nobody constructed.
- Never treat finding count, round count, or result length as quality.
- Never reopen a decision the design made and the design review cleared.
- Never fix a design defect in the code.
- Never fill in a `[미결정]` on behalf of the person it names.
- Never modify any file other than the ones this skill assigns you: the reviewer writes only its result, and the coordinator changes only the code the accepted findings reach, the design's section 7 when routing back, and the round files.
- Never end the loop by dropping an `issue:`: each one ends resolved, rejected with a reason the reviewer settled, routed into the design, or recorded as a `[미결정]`. A non-blocking finding may end open and unfixed — report it that way rather than opening a round to close it.
