---
name: design-authoring
description: Author an architecture design or a detailed design as a standalone request (outside the /harnie:dev loops) by loading the canonical designer gates and the matching altitude output contract. Thin wrapper — it applies agents/harnie-designer.md and instructions/design-authoring-{arch,detail}.md by reference and restates neither. For reviewing an existing design, the criteria live in instructions/design-review.md instead.
---

# Design Authoring (Thin Wrapper)

This skill contains **no design methodology of its own**. The canon lives in two places and is loaded by reference:

- **Persona, entry gates, working principles, final self-review** → `${CLAUDE_PLUGIN_ROOT}/agents/harnie-designer.md`
- **Output contract per altitude** → `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-arch.md` (ARCH) or `${CLAUDE_PLUGIN_ROOT}/instructions/design-authoring-detail.md` (DETAIL)

If this file ever appears to disagree with those documents, they win. Do not copy their content into this file or into the conversation; Read them and follow them.

## Procedure

1. **Pick the altitude.** Use the altitude definitions in `${CLAUDE_PLUGIN_ROOT}/instructions/model-matrix.md` §1. A request is ARCH or TASK-DETAIL (the detailed-design profile). When the request is ambiguous, confirm the altitude with the requester once.
2. **Load the canon.** Read the designer agent body and the matching altitude profile. When authoring inline, apply the agent body's entry gates and working principles yourself. When delegating to the `harnie-designer` subagent instead, pass the profile's **absolute path**, the altitude and mode signal, and the output path in the delegation prompt — the agent body requires Reading the profile, so never paste its contents.
3. **Author.** Follow the profile's section contract. Lightweight is the default; use the Formal section set only when the requester explicitly signals "formal". Write the document in the language the requester is working in.

## Scope Notes

- The `/harnie:dev` pipeline loads these same contracts directly at its design stages; do not invoke this skill inside it.
- Reviewing an existing design is not this skill: apply `${CLAUDE_PLUGIN_ROOT}/instructions/design-review.md` with the altitude lens matching the target.
