---
name: deploy-request
description: Before I ask for deployment approval of tickets I worked on, check that each ticket is in the requestable state and that every related change (PR) is in the required state, then write the approval-request message when all pass. The caller supplies ticket states, related PRs and their states, the requestable ticket state, and the required PR state, and performs retrieval, mentions, link formatting, and sending. Do NOT use to approve or hold someone else's deployment request (that is deploy-approval) or to review code.
---

# Deployment Request (Readiness Judgment)

Before a deployment approval request is sent for tickets I worked on, decide whether each ticket is **ready to be requested** and, when all are, write the request message. Make **judgments and message content only**—the caller (platform or session) retrieves ticket and PR states, fills in mentions and link syntax, and sends the message. Remain company- and platform-neutral.

This is the requester side of the gate whose approver side is `deploy-approval`. A request that reaches the approver with no identifiable change, or with an unmerged change, is held there; this skill stops it before it is sent.

## Input (Provided by the Caller)

- The tickets to request, each with its key, title, link, current state name, and its related PRs. Each PR carries an identifier, its state, and whether the caller marked it to be named in the message directly.
- The **requestable ticket state name** and the **required PR state**.
- The **abandoned PR state**, which is excluded from every check below.

## Core Principles (Safety-Critical)

- **Do not write a message unless every ticket is ready.** One `not-ready` ticket means no message; the user decides whether to send the rest.
- **A retrieval the caller reports as failed is `not-ready`.** Never assume a state you were not given.
- Compare state names **after removing all whitespace**.

## Decision (Per Ticket, In Order)

1. The ticket's state name does not match the requestable state → `not-ready` (reason: the current state).
2. After excluding abandoned PRs, no related PR remains → `not-ready` (reason: the approver cannot identify the change and will hold the request; link a PR to the ticket, or supply the PR to be named in the message).
3. Any remaining PR is not in the required state → `not-ready` (reason: that PR and its state).
4. Otherwise → `ready`.

## Message (Only When Every Ticket Is `ready`)

One message for all tickets:

- One line asking for deployment approval.
- One line per ticket: key, title, and a link placeholder the caller renders.
- Under a ticket line, a reference to each PR the caller marked to be named directly.

The caller adds the mention and renders links in its platform's syntax.

## Output Language

- Write the request line, reasons, and guidance **in Korean**.
- Preserve ticket keys, state names, PR identifiers, and links in their original form.

## Output

For each ticket, return `ready` | `not-ready (+ reason)`. When every ticket is `ready`, also return the message content. The caller sends the message or reports the `not-ready` reasons to the user.

> Distinct from `deploy-approval`: that skill reviews the changes behind someone's request and approves or holds it; this one checks my own tickets before I ask. It does not judge cross-PR contracts or deployment order—the approver side does.
