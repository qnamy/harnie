---
name: dev
description: Runs the harnie development chain end to end on one instruction for a small, clearly bounded change — designs it, has the design reviewed, implements it, has the implementation reviewed, and verifies it, with the reviews and the verification in one separate session of the other provider opened through orca. Refuses before starting when the request carries signs of a large or risky change, and hands the work back after the design when the design turns out larger than one session should own. Use for a routine change the requester wants done without directing each stage. Do NOT use for work that needs a requirements stage, spans repositories, changes a schema or an external contract, touches security, authentication, or payment paths, or is meant to run as parallel sessions.
---

# dev (One Instruction, Whole Chain)

**This skill sequences the chain skills; it decides nothing they decide.** Each stage runs on its own skill, read in full when that stage starts — `software-design`, `software-design-review`, `implementation`, `implementation-review`, `acceptance-verification` — and the request, verbatim, is the requirements baseline every one of them judges against. There is no requirements stage here: a request that needs one is refused, not interpreted.

Two rules hold over everything below.

- **A stage's own stop ends this run at that stage.** A route-back from implementation, a review that ends its two rounds with an `issue:` open, a verification other than 통과 — each is reported as that skill reports it, the artifacts stay in `_chain/`, and the user decides what comes next. Nothing is retried by loosening a stage.
- **This session never reviews or verifies its own work.** One interactive session of the other provider, opened through orca in this worktree, is the reviewer for both reviews and the runner of the verification. It is opened once and kept across stages.

## Gate 1 — before anything

Refuse, in one line naming the sign, and offer the chain stage by stage instead, when any of these holds.

- The request cannot be restated in one sentence, or two readings of it would produce different software. That work starts at `requirements`.
- It changes a database schema or migration, a contract another system reads — public API, message format, another repository's code — or crosses repositories.
- It runs through an authentication, authorization, or payment path.
- The requester asks for parallel sessions, or names more than one worktree.
- `_chain/` already holds another chain's files. The user clears it; this skill deletes nothing.

The tree must be clean at HEAD, `_chain/` excepted; pre-existing work is committed first, never stashed. Record that commit — it is the baseline the review and verification stages will use.

## Stages

1. **Design.** Run `software-design` on the request verbatim. Output `_chain/design.md`.
2. **Gate 2 — read the design.** Hand the work back, design kept, when section 3 names more than six files to touch, when section 3 carries 병렬 단위, or when section 7 holds an item that blocks implementation. Say which of the three you found and stop; the user continues from the design by stages or in parallel.
3. **Design review.** Act as the coordinator of `software-design-review`: open the reviewer session, run the rounds, apply accepted findings to the design. Output `_chain/design-review-N.md` and `design-response-N.md`. Proceed only on 착수 가능; 조건부 착수 and 착수 불가 end the run with the report that skill gives. Then read Gate 2 again over the revised design — accepted findings can add files or units — and hand back the same way when it now meets a condition.
4. **Implementation.** Run `implementation` with the design path and the last `design-review-N.md` as the verdict, no scope limit. Keep its report; it carries the baseline, the verification command, and its real result.
5. **Implementation review.** Act as the coordinator of `implementation-review` with the same reviewer session and the five inputs that skill lists. Output `_chain/implementation-review-N.md` and `implementation-response-N.md`. Proceed only on 검증 착수 가능.
6. **Verification.** Have the reviewer session run `acceptance-verification`: criteria from the request verbatim, the design's section 6 command and the implementation report's command, the baseline, the implementation review verdict. Output `_chain/acceptance-verification.md`.
7. **Report.**

## Report

Korean, at most eight lines: the request in one sentence; each stage that ran with its artifact path and its verdict; the baseline commit; the files changed; the verification verdict with its 실패 and 미검증 counts; and, when the run ended early, the stage it ended at and what the user decides. Do not paste artifacts. Nothing is committed here; committing is the user's.

## Do not

- Do not skip a stage, reorder them, or run two at once.
- Do not use a same-provider subagent as the reviewer.
- Do not edit the design outside the design review loop, or the code outside the implementation review loop, once that loop has closed.
- Do not split the work, create worktrees, or dispatch implementation sessions; a design that needs it is handed back at Gate 2.
