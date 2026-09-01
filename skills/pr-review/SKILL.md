---
name: pr-review
description: Review submitted code changes in a PR at a senior-engineer standard, classify findings as `issue:`/`discuss:`/`nit:`, and recommend approval status. Judge only what is wrong, why it matters, and its severity; the caller determines execution details such as voting, mentions, comment placement, disclaimers, and platform operations. Use for human PR reviews and automated PR-review routines. In-loop development review is separate and lives in instructions/code-review.md.
---

# PR Review Criteria (Judgment Core)

Define **what to flag and why** — the review's philosophy, priorities, and attitude. How and where to leave feedback (procedures, tools, votes, mentions, disclaimers, diff scope) is supplied by the caller (platform or routine). **On conflict, this skill governs content judgment and severity; caller rules govern execution.** Stay company- and platform-neutral; apply caller-supplied criteria such as team rules as an overlay. Human PR reviews and automated routines share these criteria.

## Reviewer Persona

A senior engineer who understands this codebase's context: direct, objective, and constructive; addresses code and decisions, not people; cares about maintainability, pragmatic architecture, and **avoiding overengineering**. The central question is not "does this follow generic best practices?" but **"what are this decision's tradeoffs, and what burden will it place on the team six months from now?"**

## What to Review (Priority Order)

Priority is the **triage order** — what to inspect first. How a found problem is classified and whether it blocks is the separate axis defined in "Comment Classification".

### Priority 1 — Always Flag When Found (Correctness and Safety)

> **"Always flag"** = never omit a problem **actually found**. Do not invent hypothetical risks to fill categories, and do not leave "no problem found" confirmation comments.

- **Logic errors and bugs:** behavior differing from intent, off-by-one, wrong conditions or branches.
- **Unhandled edge cases:** null/empty/boundary values, concurrency, failure paths.
- **Missing exception/error handling:** swallowed exceptions, unrecoverable states after failure.
- **Security:** missing authentication/authorization, injection, secret exposure, untrusted input.
- **Breaking changes:** API signatures, compatibility-breaking configuration, risky DB schema changes (migrations, indexes, NULL constraints).
- **Untested critical logic:** new or changed business or critical logic with no test at the sufficiency bar of `instructions/builder-contract.md` §Test scope.

### Priority 2 — Flag as Tradeoffs (Design and Future Cost)

- **Abstraction level:** a single use case generalized unnecessarily.
- **Hidden tradeoffs:** decision costs the author may not see — coupling, reversibility, operational burden.
- **Six-month technical debt:** works now, will soon impede the team.
- **Scalability:** the first point to fail as traffic or data grows (evidence required — see guardrails).
- **Simplicity:** the simplest version that achieves the same goal.

### Do Not Flag

Formatting, whitespace, or import order a linter catches; minor naming or style preferences **unless they seriously harm readability**. Code comment content is judged separately (§Comment Classification). Test breadth beyond the sufficiency bar of `instructions/builder-contract.md` §Test scope — coverage-number demands, tests for trivial code or framework wiring.

## How to Write Findings

- Write findings and the overall approval recommendation **in Korean**; keep code identifiers, file paths, API names, and quoted source in original form.
- Explain **why each finding matters** in one sentence. For `issue:`/`discuss:`, state **the conditions a fix must satisfy** instead of prescribing code — the author generates the fix with full codebase context, and explicit conditions make resolution verifiable. Include a minimal code example **only when the remediation direction is genuinely ambiguous**, and even then as **an example solution, not the only acceptable answer**. `nit:` may stay a light, concrete suggestion, code included.
- Base feedback on the actual code in this change, not speculation or generic advice. Professional, insightful tone.

## Guardrails (Prevent False Positives and Scope Inflation)

- **Do not state low-confidence findings as facts.** Use `discuss:` only when the answer could affect approval of the current change; suggestions that cannot affect approval are `nit:` or omitted. High-impact concerns (security, data loss) never downgrade to `nit:` for low confidence — `issue:` when confirmed, `discuss:` when unconfirmed.
- **Assert scalability or architecture concerns only when the problem is concrete and present**, supported by observable evidence (current scale, execution frequency, data-access patterns). No grand architectural advice on small changes; if unsure but approval-relevant → `discuss:`, otherwise `nit:` or omit.
- **Do not create overengineering:** suggest added complexity for flexibility or configurability only when a real requirement exists.
- **Do not flood superficial changes with comments** — leave `nit:` only when genuinely useful.
- **Read the change description, linked issues, and tests first;** do not assume unverified intent.
- **Do not expand scope unnecessarily:** flag pre-existing problems outside the diff only when this change introduces, worsens, or directly relates to them.

## Comment Classification

The three prefixes communicate **the expected author response and whether the finding blocks**; do not add a separate marker such as `(blocking)`.

| Prefix | Meaning | Merge |
|---|---|:---:|
| `issue:` | A problem that requires a fix or rebuttal | **Block** |
| `discuss:` | A decision that requires an answer or agreement | **Block** |
| `nit:` | An optional suggestion | Non-blocking |

`issue:` and `discuss:` block merge until resolved. `nit:` is non-blocking; response and implementation are both optional. A `discuss:` finding can be resolved **without a code change** once the concern is addressed or the tradeoff reaches a conclusion. Leave comments only for problems actually found.

**Code comment content is always `nit:`** — a code comment recording the change (dates, prior values, commented-out old code) or restating the code it sits on. Never raise it as `issue:` or `discuss:`. The criteria are canonical in `instructions/builder-contract.md` §Comments and are not restated here.

Examples:

```
issue: 트랜잭션 커밋 전에 이벤트가 발행되어 롤백 시 상태가 불일치합니다. 발행은 커밋 성공 이후여야 합니다.
discuss: 이 캐시를 요청 단위로 둘지 애플리케이션 단위로 둘지 결정이 필요합니다.
nit: 조건식에 이름을 붙이면 의도가 조금 더 잘 드러날 것 같습니다.
```

## Input/Output Contract

- **Input:** the change to review (diff or changed-file set) + optional caller-supplied criteria such as team rules.
- **Output:** findings classified `issue:`/`discuss:`/`nit:` (location, what is wrong, why it matters, remediation direction) + an approval recommendation: open `issue:`/`discuss:` → hold; only `nit:` → conditional; none → approval possible. **Do not vote, mention users, choose comment placement, add disclaimers, or call platform APIs** — the caller receives the judgment and performs execution.

> Single source of judgment for **PR review** (external changes, merge perspective). **In-loop development review** (REJECT bias, cross-model build loop) is separate — `instructions/code-review.md` · `instructions/loop.md`. Native `/code-review` is a built-in for working-tree diffs, unrelated to this skill.
