#!/usr/bin/env node
// Claude Code only: Codex has no skill-invocation hook event, so this file is inert there.
// Blocks the bundled skills the development chain replaces and names the replacement in the reason.
import { readFileSync } from "node:fs";

const REVIEW = "구현 리뷰는 implementation-review(설계 대비), PR 리뷰는 pr-review를 쓴다";
export const BLOCKED = new Map([
  ["code-review", REVIEW],
  ["review", REVIEW],
  ["simplify", "과설계 제거는 implementation-review의 fence와 구현 계약이 맡는다"],
]);

// Bundled skills are invoked by bare name; a namespaced name belongs to a plugin and is never ours to block.
const bundledName = (name) => {
  const s = String(name || "").trim();
  return s.includes(":") ? null : s;
};

export function decide(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.hook_event_name === "PreToolUse" && payload.tool_name === "Skill") {
    const skill = bundledName(payload.tool_input && payload.tool_input.skill);
    const reason = skill && BLOCKED.get(skill);
    if (!reason) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `harnie: ${skill} 대신 ${reason}`,
      },
    };
  }
  if (payload.hook_event_name === "UserPromptExpansion" && payload.expansion_type === "slash_command") {
    if (payload.command_source === "plugin") return null;
    const skill = bundledName(payload.command_name);
    const reason = skill && BLOCKED.get(skill);
    if (!reason) return null;
    return { decision: "block", reason: `harnie: /${skill} 대신 ${reason}` };
  }
  return null;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const out = decide(payload);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
