---
name: quality-digest
description: Collect accumulated review findings, cluster recurring quality problems, and propose candidates for promotion into enforced rules such as lint, CI, or review criteria. Operate semi-automatically—propose only and let the user choose what to adopt. Never change standard configuration automatically.
---

# Quality Digest (Recurring Findings → Enforced-Rule Proposals)

Collect review findings accumulated over a period, identify **recurring quality problems**, and propose candidates to **promote into enforced rules**. **Propose only**—the **user chooses** whether to adopt them, and the caller performs any changes to lint configuration, CI, or review criteria. **Never modify standard configuration automatically.** Remain company- and platform-neutral.

This is the final stage of the review lifecycle: "recurring finding → enforcement," creating a **feedback loop in which reviews strengthen their own standards**. Adopted results and related code flow into the code-writing process.

## Input (Provided by the Caller)

- A set of review findings or comments accumulated over a period, in a form that allows extraction of prefixes (`issue`/`discuss`/`nit`), content, locations, targets, and frequency.

## Procedure

1. **Cluster:** Group recurring findings of the same kind, such as the same anti-pattern, repeated contract violation, or recurring omission. Exclude one-off or highly context-specific findings.
2. **Rank:** Sort by frequency × impact. Hold anything below the **rule of three** (one or two occurrences) from promotion candidacy.
3. **Propose promotion candidates:** Select the single most appropriate enforcement mechanism for each cluster:
   - **Mechanically verifiable** → a lint/format rule or CI check such as static analysis or a guard.
   - **Requires judgment and is difficult to automate** → an added review-criteria item in the `pr-review` team overlay.
4. **Human gate:** Present each candidate with **evidence (representative examples, frequency, and false-positive risk)**. **The user decides whether to adopt it.** The caller implements only adopted candidates.

## Core Principles

- **Never apply automatically.** Always propose → user selects → caller implements.
- Propose promotion **only when repetition provides evidence** (rule of three).
- Report the **cost of enforcement—false positives and development friction—honestly alongside the benefit**. Explicitly flag rules likely to produce many false positives.
- Guard against overengineering: do not create broad rules for one or two examples.

## Output

Return a list of promotion candidates. Each item contains `{ recurring-finding summary · representative examples · frequency · proposed enforcement mechanism (lint/CI/criteria) · false-positive risk }`. After the user chooses, the caller updates lint configuration, CI, or team criteria and sends related code changes through the code-writing process.
