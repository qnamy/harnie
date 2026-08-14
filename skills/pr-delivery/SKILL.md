---
name: pr-delivery
description: "Write profile-driven delivery content for completed changes: a PR title and selected body sections plus review-request content and review type. Use a caller-injected Delivery Profile for title convention, body sections, and review-request policy while leaving platform execution, branch, and merge strategy to the caller."
---

# PR Delivery (PR Body and Review-Request Content)

Write the **content (what)** of the artifacts that deliver completed changes: the PR title and body, and the review-request message. Perform **writing and judgment only**. Remain company- and platform-neutral.

This is the final stage of the build process (... → development review → **create PR → request review**). The resulting PR later becomes input to another party's `pr-review`.

## Input (Provided by the Caller)

- Changes (diff/commits), build context (problem solved, key design decisions, and verification evidence actually collected), and an optional linked issue or ticket.
- A **Delivery Profile** that defines:
  - **Title convention:** for example, ticket-prefixed or plain.
  - **Body section set:** a subset selected from the Section Library below.
  - **Review-request policy:** `none` or `ask-once-then-send`.
- Optional request type or review lens, such as standard, high precision, security, or performance.

## Delivery Profile (Caller-Injected)

Apply the caller-provided profile without embedding environment-specific conventions in this skill.

- Format the title according to the profile's title convention.
- Include only the body sections selected by the profile, in the caller-specified order when provided.
- For `none`, do not produce content intended for sending a review request unless the caller explicitly asks for draft-only content.
- For `ask-once-then-send`, if approval was already obtained upstream, do not create another confirmation prompt. Produce the final message ready for immediate sending.
- Treat branch and merge strategy, along with all execution details, as the caller's **how**.

## PR Body Section Library

- **Background:** Explain why the change is needed: the problem and intent.
- **Changes:** Explain what changed and how. Identify the main areas reviewers should inspect when useful.
- **Review focus:** Point reviewers to areas requiring attention, including non-obvious decisions and tradeoffs.
- **Verification:** List only checks actually run and their results. Clearly identify anything not verified; do not embellish.
- **Scope & non-goals:** State what is included and what was intentionally excluded. Include linked issues or tickets when supplied.

The Delivery Profile selects a subset of these sections. Common archetypes:

- **full:** Background, Changes, Review focus, Verification, and Scope & non-goals.
- **minimal:** Changes only.

State only facts supported by the changes and supplied context. Do not invent missing facts or speculate; leave uncertainty explicit.

## Review Request Content

- Include a PR reference placeholder when the caller will construct the actual URL, plus what and where to review.
- Provide only the context needed to review: key decisions, tradeoffs, and areas requiring care.
- State the review type or requested lens.
- Keep the final message concise and ready for the caller's configured approval policy.

## Execution Belongs to the Caller

The caller owns the **how**: PR creation mechanism, platform coordinates, target branch, branch and merge strategy, reviewer assignment, review-request destination, mentions, and actual sending. Read those values from the caller's applicable instructions or configuration. This skill does not know them.

## Output

Return `{ PR title, PR body (Markdown), review-request message content, review type }`, reflecting the injected Delivery Profile. When the profile selects no review request, return no sendable review-request content. The caller uses the result to create the PR and, when applicable, send the review request.
