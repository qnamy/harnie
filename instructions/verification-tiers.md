# Verification Tiers (Canonical) — Single Definition for Builder and Reviewer

This file is the **only definition of verification tiers**. The builder uses it to select the required verification set, and the reviewer **independently assesses** whether the selected tier is appropriate based on the diff and impact radius. Do not duplicate these rules by role; reference or inject this file instead.

Choose the tier based on the change's **actual risk**, not its file count or line count.

| Tier | Definition (Risk) | Required Verification Set |
|---|---|---|
| **trivial** | No change to behavior, contracts, or dependencies | Diagnostics for changed files |
| **behavioral** | A user- or caller-observable behavior changes | Diagnostics + relevant tests + **focused execution or reproduction through the affected public entry point** |
| **cross-cutting** | Affects multiple boundaries, packages, data contracts, or build/deployment paths | Diagnostics + relevant tests + successful build + **integration or smoke execution across a real integration boundary** |

## Manual QA
- Required when the change has **user-visible behavior** that automated verification cannot confirm.
- If the necessary real execution cannot be performed, **do not treat the behavior as verified**. State the unverified scope and the reason.

## Unable to Verify ≠ Verification Not Required
- If a risk required for approval remains unverified, it is grounds for **REJECT from a merge-readiness perspective**, even when disclosed honestly.

## When the Project Lacks the Required Verification Type
- If the project has no relevant test, integration, smoke, or other required verification, **do not simply omit it**.
- Cover the same risk with an **equivalent substitute** such as manual reproduction, contract inspection, or log/count reconciliation, and state the substitution explicitly. If the substitute does not address the original risk, treat it as unverified.
