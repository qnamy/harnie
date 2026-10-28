---
name: review-response
description: For review threads other people left on a PR I authored, judge each finding against the original code as accept, reject, or ask, and draft the reply to post on every thread—a fix reply after the change is pushed, a rejection reason, or a question. The caller retrieves threads, shows the judgment table to the user for one approval, makes the fixes, commits, pushes, posts the replies, and sends a re-review request mentioning the authors of the replied threads. Do NOT use to verify whether an author resolved a finding I raised (that is comment-resolve), to review a change (pr-review), or for review rounds inside the development chain (implementation-review and software-design-review handle their own findings).
---

# Review Response (Author-Side Judgment)

**A reviewer's finding is a claim about my code, and it is accepted only when the code proves it.** For review threads on a PR I authored, decide whether each finding should be reflected and write the reply each thread will receive. Make judgments and reply content only—the caller retrieves threads, gets the user's approval, makes and pushes the fixes, and posts the replies. Remain company- and platform-neutral.

The failure this exists to prevent: a PR that grows one polite acceptance at a time—a retry layer, a config knob, a guess at a timeout—because a reviewer asked and agreeing was easier than checking.

Three rules hold over everything below.

- **Every judgment carries the check behind it, and a judgment whose check you could not make becomes `ask`.** The check is what you opened in the original code at that location—the `file:line`, the command and its result, the contract sentence you compared. Confirming that the quoted line exists is not that check.
- **Accept by necessity, never by prefix or by who asked.** The prefix (`issue`/`discuss`/`nit`) is recorded as severity only. Accepting every thread and rejecting every thread are both the signal to check each one again.
- **Nothing is posted or changed before the user approves the table, and the table carries every reply that will be posted.**

## Input (Provided by the Caller)

1. The active threads on my PR whose root was written by someone else. Each item includes the root prefix when present, its content, location, the full reply history with authors, and a way to access the code at that location.
2. Whether the PR was built under a design or request contract, and where that contract is.

Without a way to access the code, no thread can be judged: name what is missing and stop.

## Targets

Only threads whose **latest message is from a reviewer**. A thread whose latest message is mine has already been answered; skip it.

## Procedure

1. For each thread, restate in one line what the reviewer claims is wrong and the failure it would produce. If you cannot, the judgment is `ask`.
2. Open the original code at that location, and its call sites when the finding is about behavior across them. Check whether the claimed failure occurs as the code stands.
3. Judge it (§Decision), write the fix direction or the reason, and write the reply draft.
4. Self-check, then output the table.

## Decision (Per Thread)

- **`accept`** — the check showed a concrete failure, a real defect, or a fix that is cheap with clear value. The fix direction is the smallest change that removes the failure the finding named, in one or two lines; nothing rides along.
- **`reject`** — the check showed no failure, or the fix adds a mechanism with no named failure scenario, widens scope past the PR's purpose, or is a matter of taste. The reason quotes the code or contract that settles it.
- **`ask`** — the finding's intent or reproduction condition is unclear, or the check could not be made. The reply is the question.
- **Contract change needed** — the PR was built under a contract and the finding asks to change what that contract decided. Neither accept nor reject it; mark it for the user. A finding that the code departs from the contract is not this: the code returns to the contract, and that is `accept`.

Three checks run before an `accept` stands.

- **A fix that adds a runtime mechanism**—a retry, a lock, a cache, state, a config knob, a defensive branch away from a trust boundary—is accepted only after you checked whether removing something, narrowing scope, or leaving it to observation closes the finding. Record which of those you ruled out.
- **A runtime number or condition the finding asks for**—a timeout, a retry count, an interval, a rate or concurrency limit, the error code or state a mechanism branches on—is accepted only when a measurement of this system stands behind it. What is usually done is not a measurement. Without one, the judgment is `ask`, requesting the measurement.
- **A rejection reason is compared against the boundaries the contract already set.** Where the reason and that boundary disagree, the boundary is right; rewrite the reason or change the judgment.

## Replies

- First output: the judgment table—thread, location, prefix, judgment, the check, fix direction or reason, and the **reply draft for every thread**.
  - `accept`: what will be changed and how, with a `{commit}` placeholder.
  - `reject`: the reason, with the code or contract evidence.
  - `ask`: the question.
  - Contract change needed: no reply; the user decides.
- After the user approves and the caller pushes the fixes, fill only `{commit}` with the actual commit. If the actual fix differs from the approved direction, do not post that thread's reply; return the changed draft for the user to see again.
- With the final replies, draft one re-review request addressed to the root authors of the threads that will receive a reply, each author named once, saying the review has been reflected. The caller sends it only after those replies are posted, turning each author into a mention on its own platform and sending it where the original review request was sent; an author none of whose threads got a posted reply is dropped from the request. No thread receives a reply → no re-review request.

## Self-check

- Does every judgment name the check you made in the original code, not the reviewer's quotation of it?
- Does any `accept` add a mechanism without the removal check recorded, or a number without a measurement behind it? Change it.
- Does any fix direction carry something the finding did not name? Remove it.
- Did every thread get one judgment, or did they all land on the same one? If they did, check each again.

## Output

Korean for the table, the checks, and the replies. Prefixes, code identifiers, file paths, commit identifiers, and quoted source text stay in their original form.

First, the judgment table with reply drafts. After the fixes are pushed, the final replies per thread with `{commit}` filled, plus any thread whose draft changed, and the re-review request draft. The caller posts the replies, sends the re-review request, and leaves thread status to the reviewer.

## Never

- Never resolve or close a thread; the reviewer does that with `comment-resolve`.
- Never raise a new finding about the PR; that belongs to `pr-review`.
- Never post or change anything before the user approves the table.
- Never accept a finding because of its prefix, its author, or to end the discussion.
- Never write a fix direction that settles a contract decision; mark it Contract change needed.

> Distinct from `comment-resolve`: that skill is the reviewer verifying my response; this one is me deciding the response. Fixing the code is the caller's work and follows the caller's development routing.
