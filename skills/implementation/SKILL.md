---
name: implementation
description: Implements a software design document as written, runs the verification step the design fixed, and stops on whatever that design left open instead of deciding it. Takes the design file path and, optionally, a scope limit naming which of the design's files this session owns, so several sessions can run one design side by side without any of them deciding how the work is split. Use once a design document exists, including one whose review cleared only part of it, and implementation is what is being asked for. Do NOT use when there is no design document to execute, to write or revise a design or requirements, to settle an open item, or to split work into units and dispatch them.
---

# Software Implementation (The Design Is the Plan)

**The design document is the plan, and there is no second one.** Sections 1 to 7 are the contract this session executes; section 8 records the alternatives the designer rejected and is not an instruction. No task file, no step list, no checklist is produced here — the design already fixed the files, the interfaces, the failure behavior, and the verification, and a plan written on top of it becomes a second source of record that drifts from the first.

Three rules hold over everything below.

- **No design-level decision is made here.** A `[미결정]` in section 7 that blocks the work stops the work, and so does a choice sections 1 to 6 were supposed to fix and did not. An implementer that settles one produces code nobody agreed to, under a document that still says the question is open. Local expression inside this repository's conventions, a variable name or the shape of a private helper, is not such a decision and stops nothing.
- **Verification is section 6 run for real, and its output compared to the pass condition section 6 states.** Code that looks done and a command that was never run are the same evidence.
- **A design that turns out to be wrong routes back. It is not patched around locally.** The cheapest moment to find a design error is here; the most expensive place to bury one is inside the code that was supposed to follow it.

## Input

- **The design file path.** Required. Read sections 1 to 7 in full; that is the source of record for what to build and what not to touch.
- **The review result.** The current one is whichever the caller names; with none named and review files sitting beside the design, it is the highest-numbered `review-N.md` there, and an earlier round's verdict is not the verdict. 착수 불가 means do not start, and say so. 조건부 착수 means build only the part the review named as buildable and leave the blocked part alone.
- **A scope limit.** Optional, and only when the caller gives one. See §Scope limit.

**A request that arrives here with no design document is outside this skill.** Every rule below points at a section of a document that does not exist. Report that in one line and stop. This skill implements nothing without a design, and it does not write one to fill the gap: a design invented inline is one nobody reviewed, which is the failure the earlier stages exist to prevent. What the session does with the request after that is settled outside this skill.

## Procedure

1. **Restate in one sentence** what this session builds and what it must not touch. If you cannot, name the one thing missing and stop.
2. **Read section 7 before writing any code.** A blocking open item stops the work now rather than halfway through it. Report which item and who settles it. An item missing any of its three parts — the reason, who settles it, what it blocks — goes back to the design (§Routing back), because deciding how far an incomplete one reaches is the decision you are here not to make.
3. **Confirm the ground.** The paths, signatures, and conventions section 3 names must exist in this repository as written. A mismatch is a design fact error, not something to absorb here (§Routing back).
4. **Implement what section 2 decided, in the files section 3 names**, following what this repository already does. No mechanism section 2 did not decide enters the code: no abstraction, config surface, or defensive branch away from a trust boundary. Local expression the design left to you is yours, on the same boundary the rules above draw. **Never implement a section from your memory of it.** A long run can be compacted, taking the design's text out of the session while the work goes on, and continuing from a remembered version is how the code drifts from what was decided. After a compaction, get sections 2, 3, and 6 back in front of you before continuing.
5. **Run section 6's command** and compare its output to the condition section 6 calls passing. On a failure, say whether that same command already failed before this change, and say it only from that command run against the tree as it stood immediately before you touched it. An older record, the design's grounding included, describes a tree that has since moved. Without evidence from this tree, report the attribution as unknown. Attributing a pre-existing failure to this work, or this work's failure to the baseline, each send the next stage the wrong way, and a guess between them is how that happens.
6. **Self-check, then report.**

## Scope limit

A scope limit names the subset of section 3's files this session owns. Whoever is running several sessions against one design assigns it; this session never derives one for itself.

- You own exactly the files you were given. Every other file in section 3 belongs to another session that is running right now.
- **Needing to change a file outside your scope stops the work.** Report the file and what you needed from it. Do not edit it, and do not build a local workaround that avoids it. Two sessions editing one file means the split was made wrong, and the fix belongs in the split.
- Run section 6 regardless. When it cannot pass until another scope lands, report which part passed and which is waiting. **Never weaken the command or the pass condition to make it green.**

## Routing back

These findings go back to the design instead of being handled here, and they carry the same weight as each other. In each case, stop, report what the design says against what you found, name the section, and state the smallest change that would settle it. Do not revise the design yourself, and do not implement your own version of the decision.

| Finding | Why it is not yours |
|---|---|
| Section 3's path, signature, or convention does not match the repository | The design rests on a fact that is false, and other decisions may rest on it too |
| A decision in section 2 cannot be implemented as written | Choosing the replacement is a design decision |
| A requirement no decision covers surfaces mid-implementation | Covering it changes scope |
| Section 6's command passes without reaching what you built | You are the first to run it, so this defect surfaces nowhere else. Report the command that would observe the change instead of quietly substituting one |
| A section 7 item is missing its reason, its decider, or what it blocks | Completing it belongs to the designer or to whoever it should have named, and reading its blast radius out of an incomplete item is a decision |

## Self-check

Over the finished change, before reporting.

- Does every decision in section 2 that your scope covers appear in the code, and does every file you changed trace back to section 3 or to the scope you were given? Both directions.
- Did section 6's command actually run in this session, and did you compare its real output to the stated condition rather than to what you expected?
- Did a mechanism enter that section 2 did not decide — an abstraction, a knob, error handling for a case that cannot occur, a test for trivial code or framework wiring? Remove it. Local expression the design left open is not that.
- Is anything left that you settled yourself instead of stopping on it?

## Report

Korean, four lines at most: the design path and the scope you were given, the verification command with its actual result, the files changed, and any item you stopped on with who settles it. Do not paste the diff or the design; the code and the file are the artifacts.

## Do not

- Do not write or revise the design, the requirements, or the review files.
- Do not settle a `[미결정]`, and do not treat a missing decision as an invitation to make one.
- Do not split the work into units, write a task or plan file, or dispatch anyone. When one design is larger than one session, that split belongs to the person opening the sessions.
- Do not implement from section 8. The alternatives there were rejected.
- Do not touch code the design does not reach, and do not "improve" adjacent code, comments, or formatting on the way past.
- Do not report done on a verification you did not run, or on one you loosened until it passed.
