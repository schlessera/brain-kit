// The installed Claude CLI's serialisation of the shipped tool surface under
// `createClaudeSdkTurn`'s production defaults: core brain tools stay deferred,
// the fourteen bridge tools (the five inbox tools among them) load eagerly with
// their schemas, and the emitted skill listing reaches the request. Package
// tests check only the MCP `_meta` stamp; this is the half where the CLI
// honours it. Split verbatim from the turn-surface measurement test (#1386),
// whose token-group arithmetic stays in experiments/turn-surface-capture.test.ts.
// Keyless: the capture runs against a loopback fixture model.
import { expect, test } from "bun:test";
import { captureSurface } from "../scripts/capture-turn-surface";
import { deferredToolNames } from "../scripts/turn-surface-token-groups";

test("actual installed CLI request preserves shipped deferred core tools, eager bridge and emitted skills", async () => {
  const capture = await captureSurface();
  expect(capture.request.model).toBe("claude-sonnet-5-5");
  expect(capture.cliVersion).toBe(capture.runtime.claudeCode);
  expect(capture.request.tools.filter(tool => tool.name.startsWith("mcp__brain__"))).toHaveLength(0);
  expect(deferredToolNames(capture.request).filter(name => name.startsWith("mcp__brain__")).sort()).toEqual([
    "mcp__brain__brain_add", "mcp__brain__brain_archive", "mcp__brain__brain_context", "mcp__brain__brain_graph",
    "mcp__brain__brain_list", "mcp__brain__brain_read", "mcp__brain__brain_search", "mcp__brain__brain_update",
  ]);
  expect(capture.request.tools.filter(tool => tool.name.startsWith("mcp__brain-ui__"))).toHaveLength(14);
  for (const name of ["inbox_list", "inbox_get", "inbox_add", "resolve_action", "complete_share", "turn_temp"]) {
    const tool = capture.request.tools.find(tool => tool.name === `mcp__brain-ui__${name}`);
    expect(tool?.input_schema).toBeDefined();
    expect(tool?.defer_loading).not.toBe(true);
  }
  expect(capture.request.tools.some(tool => tool.name === "Skill")).toBe(true);
  expect(capture.request.tools.some(tool => tool.name === "Read")).toBe(true);
  const text = JSON.stringify(capture.request.messages);
  expect(capture.fixtureSkills).toHaveLength(3);
  for (const skill of capture.fixtureSkills) expect(text).toContain(`${skill.name}: ${skill.description}`);
});
