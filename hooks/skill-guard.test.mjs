import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "./skill-guard.mjs";

const skillCall = (skill) => ({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill } });
const slash = (command_name, command_source = "bundled") => ({
  hook_event_name: "UserPromptExpansion",
  expansion_type: "slash_command",
  command_name,
  command_source,
});

test("model call to a blocked bundled skill is denied with the replacement named", () => {
  const out = decide(skillCall("code-review"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /implementation-review/);
});

test("direct slash command to a blocked skill is blocked", () => {
  assert.equal(decide(slash("simplify")).decision, "block");
});

test("a plugin's same-named skill passes: only bundled bare names are blocked", () => {
  assert.equal(decide(skillCall("other:code-review")), null);
  assert.equal(decide(slash("other:simplify", "plugin")), null);
  assert.equal(decide(slash("code-review", "plugin")), null);
});

test("only the three listed names count; inherited object properties do not", () => {
  assert.equal(decide(skillCall("constructor")), null);
  assert.equal(decide(slash("toString")), null);
});

test("chain skills and unrelated tools pass through", () => {
  assert.equal(decide(skillCall("harnie:implementation-review")), null);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), null);
  assert.equal(decide(slash("plan")), null);
});
