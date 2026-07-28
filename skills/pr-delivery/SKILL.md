---
name: pr-delivery
description: Write the "what" for delivering completed changes—PR title and body (what, why, verification, and scope) plus review-request content (what and where to review, context, and request type). The caller determines execution details—the "how," including platform API/MCP, target branch, channel, mentions, and required reviewers—from company or platform instructions.
---

# PR Delivery (PR Body and Review-Request Content)

Write the **content (what)** of the artifacts that deliver completed changes: the PR title and body, and the review-request message. Perform **writing and judgment only**. The caller (platform or routine) reads company or platform instructions to determine the **how and where**, including the PR creation API, target branch, review-request channel, mentions, and required reviewers. Remain company- and platform-neutral.

This is the final stage of the build process (... → development review → **create PR → request review**). The resulting PR later becomes input to another party's `pr-review`.

## Input (Provided by the Caller)

- Changes (diff/commits) + build context (problem solved, key design decisions, and verification evidence actually collected) + optional linked issue/ticket.

## PR Body: "What"

- **Title:** State in one line what the change does. Represent scope precisely; follow caller instructions for prefixes or naming conventions when provided.
- **Summary:** Explain what changed and why—the problem solved and intent. Base this on actual changes, not speculation.
- **Key changes:** Identify the main files or areas reviewers should inspect and explain the rationale for **non-obvious decisions**.
- **Verification:** State which checks ran and at which tier. Include **only checks actually performed**. Clearly mark anything not verified; do not embellish.
- **Scope and non-goals:** State what is included and what was **intentionally excluded**. Include linked issues or tickets.
- Do not invent missing facts. Leave uncertainty explicit.

## Review Request: "What"

- Include a PR reference (the caller constructs the actual URL) and **what and where to review** as the review focus.
- Provide the **context** needed for review: key decisions, tradeoffs, and areas requiring care.
- State the **request type:** standard review / high precision / a specific lens such as security or performance.
- Keep it concise so the reviewer can begin immediately.

## Execution Belongs to the Caller (Company or Platform Instructions)

The PR creation mechanism (platform API/MCP), target branch, reviewer assignment rules (including required reviewers), review-request channel, and mentions are environment-specific. **Read them from the applicable company or platform instructions, such as a routine configuration file.** This skill does not know those coordinates.

## Output

Return `{ PR title, PR body (Markdown), review-request message content, review type }`. The caller uses this content to create the PR and send the review request on the platform.
