---
name: deploy-request
description: Before I ask for deployment approval of tickets I worked on, check that each ticket is in the requestable state and that every related change (PR) is in the required state, then write the approval-request message when all pass. The caller supplies ticket states, related PRs and their states, the requestable ticket state, and the required PR state, and performs retrieval, mentions, link formatting, and sending. Do NOT use to approve or hold someone else's deployment request (that is deploy-approval) or to review code.
---

# Deployment Request (Readiness Judgment)

Before a deployment approval request is sent for tickets I worked on, decide whether each ticket is **ready to be requested** and, when all are, write the request message. Make **judgments and message content only**—the caller (platform or session) retrieves ticket and PR states, fills in mentions and link syntax, and sends the message. Remain company- and platform-neutral.

This is the requester side of the gate whose approver side is `deploy-approval`. A request that reaches the approver with no identifiable change, or with an unmerged change, is held there; this skill stops it before it is sent.

## Input (Provided by the Caller)

- The tickets to request, each with its key, title, link, current state name, and its related PRs. Each PR carries an identifier, its repository, its state, and whether the caller marked it to be named in the message directly.
- The **requestable ticket state name** and the **required PR state**.
- The **abandoned PR state**, which is excluded from every check below.
- When the remaining PRs span two or more repositories, the **deployment order**: the repositories in the order they must be deployed, each with the reason it comes at that position (for example, the API provider before its consumer), or an explicit statement that the repositories do not depend on each other. The caller takes it from the work context or the user; this skill does not derive it from the PRs.

## Core Principles (Safety-Critical)

- **Do not write a message unless every ticket is ready.** One `not-ready` ticket means no message; the user decides whether to send the rest.
- **A retrieval the caller reports as failed is `not-ready`.** Never assume a state you were not given.
- Compare state names **after removing all whitespace**.
- **Do not write a message for a multi-repository request without the deployment order.** When the PRs that remain after excluding abandoned ones span two or more repositories and the caller supplied no order, or an order that leaves out one of those repositories, write no message and report that the order is missing, naming the repositories. Never fill in an order yourself.

## Decision (Per Ticket, In Order)

1. The ticket's state name does not match the requestable state → `not-ready` (reason: the current state).
2. After excluding abandoned PRs, no related PR remains → `not-ready` (reason: the approver cannot identify the change and will hold the request; link a PR to the ticket, or supply the PR to be named in the message).
3. Any remaining PR is not in the required state → `not-ready` (reason: that PR and its state).
4. Otherwise → `ready`.

## Message (Only When Every Ticket Is `ready` and the Order Rule Holds)

One message for all tickets:

- One line asking for deployment approval.
- One line per ticket: key, title, and a link placeholder the caller renders.
- Under a ticket line, a reference to each PR the caller marked to be named directly.
- When the PRs span two or more repositories, a deployment-order block after the ticket lines: one numbered line per repository, in deployment order, with its reason. When the caller stated the repositories are independent, one line saying the order does not matter instead.

The caller adds the mention and renders links in its platform's syntax.

## Output Language

- Write the request line, reasons, and guidance **in Korean**.
- Preserve ticket keys, state names, PR identifiers, and links in their original form.

## Output

For each ticket, return `ready` | `not-ready (+ reason)`. For a multi-repository request missing its order, also return the order gap and the repositories involved. When every ticket is `ready` and the order rule holds, also return the message content. The caller sends the message or reports the `not-ready` reasons and the order gap to the user.

> Distinct from `deploy-approval`: that skill reviews the changes behind someone's request and approves or holds it; this one checks my own tickets before I ask. It states the deployment order the caller supplied but does not judge whether that order is correct, nor cross-PR contracts—the approver side does.
