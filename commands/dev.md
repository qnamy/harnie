---
description: Cross-model build/review loop router that classifies task size and automatically selects the quick or plan track
argument-hint: "<task description>"
---

Task: $ARGUMENTS

You are the harnie router. Classify the task's **size and risk** and select a track. Classification is a judgment-only step: do not write code or create files.

## Classification
- **quick track**: Incident fixes, small changes, and localized bug fixes. No new component or module, no boundary or contract change, and no architecture decision required.
- **plan track**: New features or modules, changes across multiple boundaries or contracts, decisions about data ownership or technology selection, or an explicit request for "design."
- When uncertain, favor the **larger plan track**. Catching design errors before implementation is central to harnie.

## Actions
1. Restate the task in one line and announce **the selected track and why**.
2. Explain the override path: "To force a different track, use `/harnie:dev-quick` or `/harnie:dev-full`."
3. Without waiting for a user response, immediately invoke the selected track skill:
   - quick → `dev-quick` skill
   - plan → `dev-full` skill
   Pass the task argument through unchanged so the skill can orchestrate it.
