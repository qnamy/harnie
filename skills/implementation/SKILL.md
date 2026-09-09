---
name: implementation
description: Implements a contract as written — a software design document when one exists, otherwise the requester's request — records the baseline commit it started from, runs the verification that reaches the change, and stops on whatever the contract left open instead of deciding it. Takes the design file path, or the request when there is no design, and optionally a scope limit naming which files this session owns so several sessions can run one design side by side. Use when implementation is what is being asked for. Do NOT use to write or revise a design or requirements, to settle an open item, to review code, or to split work into units and dispatch them.
---

# Implementation (The Contract Is the Plan)

**The contract is the plan, and there is no second one.** With a design document, sections 1 to 7 are the contract and section 8 is not an instruction. Without one, the requester's request — or the requirements file — is the contract, read verbatim. No task file, step list, or checklist is produced here; a plan written on top of the contract becomes a second source of record that drifts from the first.

Three rules hold over everything below.

- **No contract-level decision is made here.** A `[미결정]` that blocks the work stops the work. So does a choice the contract was supposed to fix and did not, and, without a design, a reading of the request that would produce different software. Ask the requester or route back; never choose. Local expression inside this repository's conventions — a name, the shape of a private helper — is not such a decision.
- **Verification is run for real, and its output compared to the pass condition.** Code that looks done and a command that was never run are the same evidence.
- **A contract that turns out to be wrong routes back.** It is not patched around locally.

## Input

- **The contract.** The design file path, sections 1 to 7 read in full; or, with no design, the request text or the requirements file path. The report says which one you worked from.
- **The design review verdict**, when a design exists: the `design-review-N.md` the caller names, or the caller's statement that the design review was skipped. Given neither, ask; never pick a review file up on your own, since a file lying nearby may belong to another design. Record which you got in the report. 착수 불가 means do not start, and say so. 조건부 착수 means build only the part the review named as buildable.
- **A scope limit**, only when the caller gives one (§Scope limit).

## Procedure

1. **Record the baseline.** The tree must be clean at HEAD — `_chain/`, where the chain's own artifacts live, excepted — and that commit is the baseline the review and verification stages diff against. A dirty tree stops the work: report it and have the pre-existing work committed first. Never stash it; the stash stack is shared across worktrees.
2. **Restate in one sentence** what you build and what you must not touch. If you cannot, name the missing thing and stop.
3. **Read the open items before writing code.** With a design, section 7: a blocking item stops the work now, and an item missing its reason, decider, or blocked work routes back. Without a design, list every reading of the request that would produce different software, ask the requester about each before coding, and record the answers in the report.
4. **Confirm the ground.** The paths, signatures, and conventions the contract names must exist in this repository as written. A mismatch routes back.
5. **Implement what the contract decided, in the files it names**, following what this repository already does. No mechanism the contract did not decide enters the code: no abstraction, config surface, or defensive branch away from a trust boundary. **Never implement from your memory of the contract.** After a compaction, get its text back in front of you before continuing.
6. **Run the verification.** With a design, section 6's command, its output compared to the condition section 6 calls passing. Without one, the repository's existing check that reaches the change — its test command, a build, a run of the changed path; when none reaches it, say so rather than substituting a command that passes. On a failure, attribute it to the baseline only from that same command run at the baseline; without that run, report the attribution as unknown.
7. **Self-check, then report.**

## Scope limit

A scope limit names the subset of the contract's files this session owns — one unit from the design's 병렬 단위, or a list the caller gives. Whoever runs several sessions assigns it; this session never derives one.

- You own exactly those files. Needing to change a file outside them stops the work: report the file and what you needed from it, edit nothing, and build no local workaround. The fix belongs in the split.
- Run the verification regardless. When it cannot pass until another scope lands, report which part passed and which is waiting. Never weaken the command or the pass condition.

## Routing back

Stop, report what the contract says against what you found, name the section or the sentence, and state the smallest change that would settle it. Do not revise the contract, and do not implement your own version of the decision.

| Finding | Why it is not yours |
|---|---|
| A named path, signature, or convention does not match the repository | The contract rests on a false fact, and other decisions may too |
| A decision cannot be implemented as written | Choosing the replacement is a design decision |
| A requirement no decision covers surfaces mid-implementation | Covering it changes scope |
| The verification command passes without reaching what you built | You are the first to run it; report the command that would observe the change instead of substituting one |
| An open item is missing its reason, decider, or blocked work | Completing it belongs to whoever wrote it |

## Self-check

- Does every decision your scope covers appear in the code, and does every changed file trace to the contract or to your scope? Both directions.
- Did the verification actually run in this session, compared to its stated condition rather than to what you expected?
- Did a mechanism enter that the contract did not decide — an abstraction, a knob, handling for a case that cannot occur, a test for trivial code or framework wiring? Remove it.
- Is anything left that you settled yourself instead of stopping on?

## Report

Korean, six lines at most: the contract you worked from and your scope; the baseline commit; the verification command with its actual result; the files changed; without a design, the readings you asked about and the answers; any item you stopped on and who settles it. The review and verification stages receive this report unchanged — it is the change's only record of its baseline and its verification. Do not paste the diff.

## Do not

- Do not write or revise the design, the requirements, or the review files.
- Do not settle a `[미결정]`, and do not treat a missing decision as an invitation to make one.
- Do not split the work, write a task or plan file, or dispatch anyone.
- Do not implement from section 8; those alternatives were rejected.
- Do not touch code the contract does not reach, and do not "improve" adjacent code, comments, or formatting on the way past.
- Do not report done on a verification you did not run, or on one you loosened until it passed.
- Do not write a design to fill a gap. Without one, the request is the contract, and what it does not fix is asked, not designed.
