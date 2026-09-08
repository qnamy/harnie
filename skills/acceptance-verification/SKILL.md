---
name: acceptance-verification
description: Runs the verification a design fixed, in a session that did not write the implementation, and attributes each run to the requirements' completion criteria so every criterion lands on 검증됨, 미검증, or 실패. Confirms a reproducing test failed before the fix, and audits the test files the change edited. Use after implementation review clears a change and before the change is called done. Produces a Korean result file beside the design document. Do NOT use to review code or a design, to hunt defects, to decide whether a failure belongs to the implementation or to the design, to fix anything, or in the session that wrote the implementation.
---

# Acceptance verification

You run the verification the design fixed, and you report what those runs prove about the requirements. Nothing else.

**This session must not be the one that wrote the implementation.** A session that produced a change cannot be the session that judges its verification. If it is, say so and stop.

Defect hunting, code-against-design consistency, and correctness judgment already happened in implementation review. Repeating them here is out of scope, and so is deciding whether a failure is the implementation's fault or the design's. You report what ran and what came out.

## Input

1. **The criteria.** From the requirements document: each functional requirement, each quality constraint, and each completion criterion — a document with no separate completion section still yields its requirements as criteria. If there is no requirements document, derive the criteria from the user's original request. **A derived criterion may never widen the user's original request** — 6 stated requirements do not become 16. Record the list, and where each item came from, at the top of the result file before running anything. An empty list is a failed input, never a 통과.
2. **The commands.** The design's verification section, and the verification command the implementation report names with what it observed. Without a design, the report's command is the primary one; add a repository check only for a criterion no named command reaches, confirming the check exists rather than assuming it.
3. **The baseline.** The commit whose tree is the change's starting point. You do not compute it — take it from the implementation report, or from the implementation review's scope line, or have the user name it. Without a baseline neither the failure-first gate nor the test-file audit runs, and no criterion whose evidence is a test run can be 검증됨.
4. **The implementation review verdict.** Under 조건부 착수, only the released part is verified: criteria the blocked part covers stay 미검증, marked blocked, and its commands are not run.

Write the criteria list before you run anything. Criteria assembled after seeing results are fitted to the results.

## Procedure

1. Run each verification command. Record the command, its exit code, and the output lines that decide the judgment.
2. **Discard hollow runs.** An exit code of 0 is evidence only when you can say what the run exercised. A test run reporting zero tests decides nothing — record 미검증.
3. **Failure-first gate**, for a fix to reported broken behavior: run the reproducing test at the baseline. If it passes there, the criterion is 실패 — the test does not demonstrate the fix, whatever it does now.
4. **Test-file audit.** Compare the test files between the baseline and the current tree. A loosened assertion, expected value, or comparison that no criterion on your list needs is 실패, no matter what the suite reports.
5. Attribute each run to the criteria it decides. A criterion with no run behind it is 미검증.
6. Separate what only a person can confirm into a checklist. Those criteria stay 미검증 until a human confirms them; "unable to verify" never means "verification was not required".

When a command exists nowhere in the project, look for an equivalent way to exercise the same behavior before recording 미검증. Absence of the exact command is not absence of the check.

## Judgment

Each criterion gets one of three values.

- **검증됨** — a run you made, quoted in the result file, decides it.
- **미검증** — no run decides it, or the only run was hollow, or it awaits a person.
- **실패** — a run decided against it, or the failure-first gate or the test-file audit caught it.

The overall verdict follows mechanically from the counts, in exactly these words.

- **통과** — 실패 0, 미검증 0.
- **조건부 통과** — 실패 0, 미검증 1건 이상.
- **미통과** — 실패 1건 이상.

## Never

- Never edit source, tests, or configuration to make a verification pass. The one thing you may fix is your own run environment — a mistyped command, a missing dependency — and you record that you did.
- Never judge a criterion that is not on the list you wrote at the start. Something outside the requirements is not this stage's business.
- Never report code quality, naming, structure, formatting, or a defect that predates the change. Those are not findings here; a reviewer told to find gaps will always find some.
- Never count a criterion 검증됨 on another session's report. Only a run you made, with output you can quote, decides one.
- Never let a passing suite stand in for a criterion no command actually reaches.

## Output

Write one Korean file, `_chain/acceptance-verification.md` — wherever the design itself lives — unless the user names another path. One file, no rounds, no revisions of it.

The file carries four things, in this order.

1. **기준** — the criteria list and where each came from (requirements document, or derived from the request), the baseline commit, and the implementation review verdict worked under.
2. **판정** — the overall verdict on its own line, then a table of criterion, 판정, and the run that decided it.
3. **실행 기록** — for each command: the command, its exit code, and the output lines you are relying on. A 실패 quotes the failing output verbatim.
4. **사람 확인** — the checklist of what a person must confirm, and what confirming it would decide.

Report to the user in three lines: the file path, the overall verdict, and the counts of 실패 and 미검증. Do not paste the file's contents into the reply.

If you finish with anything other than 통과, say which criteria are open and stop. Choosing what happens next — another implementation round, a design change, a scope decision — belongs to the user, not to this stage.
