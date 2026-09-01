# Verification Tiers (Canonical) — Single Definition for Builder and Reviewer

This file is the **only definition of verification tiers**. The builder uses it to select the required verification set, and the reviewer **independently assesses** whether the selected tier is appropriate based on the diff and impact radius. Do not duplicate these rules by role; each role's agent body instructs it to **Read this file directly** instead.

Choose the tier based on the change's **actual risk**, not its file count or line count.

## Test Evidence Rules (Builder and Reviewer)
- **"Relevant tests"** in the tier table below are selected by `builder-contract.md` §Test scope: unit tests on business and critical logic, boundary risks exercised through the real boundary — not coverage-driven additions.
- **Baseline-relative pass criterion.** In a repo whose suite already has failures, an absolute "tests pass" claim is meaningless. Before modifying code, run the relevant test set once to record the **baseline failure set**; after the change, report **baseline failure count vs. post-change failure count** and name any new failures. The pass criterion is: **the post-change failure set is a subset of the baseline failure set**. A "tests pass" report without this comparison is not evidence.
- **New tests must prove they can fail.** A test that structurally cannot fail — its assertion passes even when the target behavior is broken, for example because it never observes the result it claims to check — verifies nothing. For each new test or materially strengthened assertion, prove fail-capability once: temporarily break the target behavior, observe the test fail, restore it, observe it pass, and include that observation in the evidence.

| Tier | Definition (Risk) | Required Verification Set |
|---|---|---|
| **trivial** | No change to behavior, contracts, or dependencies | Diagnostics for changed files |
| **behavioral** | A user- or caller-observable behavior changes | Diagnostics + relevant tests + **focused execution or reproduction through the affected public entry point** |
| **cross-cutting** | Affects multiple boundaries, packages, data contracts, or build/deployment paths | Diagnostics + relevant tests + successful build + **integration or smoke execution across a real integration boundary** |

## Manual QA
- Required when the change has **user-visible behavior** that automated verification cannot confirm.
- If the necessary real execution cannot be performed, **do not treat the behavior as verified**. State the unverified scope and the reason.
- **Human-verification items are separated upfront** (in the plan's verification strategy) and handed over as a checklist — item, how to check, risk — in the completion report; they never count as "verified" without a human's confirmation (`needs-human-verification: N`).

## Unable to Verify ≠ Verification Not Required
- If a risk required for approval remains unverified, it is grounds for **REJECT from a merge-readiness perspective**, even when disclosed honestly.

## When the Project Lacks the Required Verification Type
- If the project has no relevant test, integration, smoke, or other required verification, **do not simply omit it**.
- Cover the same risk with an **equivalent substitute** such as manual reproduction, contract inspection, or log/count reconciliation, and state the substitution explicitly. If the substitute does not address the original risk, treat it as unverified.
