// The installed Claude CLI's serialisation of the shipped tool surface under
// `createClaudeSdkTurn`'s production defaults: core brain tools stay deferred,
// the complete stable bridge roster (including unavailable tools) loads eagerly with
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
    "mcp__brain__brain_add",
    // The core server's fixed Apify tools (#3162): deferred like every core tool, and refused in a worker,
    // which holds neither the token nor the ledger; the turn's own Apify tools are the eager bridge ones.
    "mcp__brain__brain_apify_abort", "mcp__brain__brain_apify_approvals", "mcp__brain__brain_apify_availability", "mcp__brain__brain_apify_discover", "mcp__brain__brain_apify_inspect", "mcp__brain__brain_apify_prepare",
    "mcp__brain__brain_apify_results", "mcp__brain__brain_apify_revoke", "mcp__brain__brain_apify_run", "mcp__brain__brain_apify_status",
    "mcp__brain__brain_archive",
    "mcp__brain__brain_compute_cancel", "mcp__brain__brain_compute_collect", "mcp__brain__brain_compute_health",
    "mcp__brain__brain_compute_plan", "mcp__brain__brain_compute_run", "mcp__brain__brain_compute_status",
    "mcp__brain__brain_context", "mcp__brain__brain_graph",
    "mcp__brain__brain_list", "mcp__brain__brain_read", "mcp__brain__brain_read_many", "mcp__brain__brain_search", "mcp__brain__brain_update",
  ]);
  // 24 before the six external compute bridge tools (#3108), the ten fixed Apify bridge tools (#3162) and read_attachment (#3154).
  expect(capture.request.tools.filter(tool => tool.name.startsWith("mcp__brain-ui__"))).toHaveLength(41);
  for (const name of ["inbox_list", "inbox_get", "inbox_add", "resolve_action", "complete_share", "turn_temp", "reference_source", "reference_worktree",
    "brain_compute_health", "brain_compute_plan", "brain_compute_run", "brain_compute_status", "brain_compute_cancel", "brain_compute_collect",
    "brain_apify_availability", "brain_apify_approvals", "brain_apify_revoke", "brain_apify_discover", "brain_apify_inspect", "brain_apify_prepare", "brain_apify_run", "brain_apify_status", "brain_apify_results", "brain_apify_abort",
    "read_attachment"]) {
    const tool = capture.request.tools.find(tool => tool.name === `mcp__brain-ui__${name}`);
    expect(tool?.input_schema).toBeDefined();
    expect(tool?.defer_loading).not.toBe(true);
  }
  expect(capture.request.tools.map(tool => tool.name)).toContain("Skill");
  expect(capture.request.tools.map(tool => tool.name)).toContain("Read");
  const text = JSON.stringify(capture.request.messages);
  expect(capture.fixtureSkills).toHaveLength(3);
  for (const skill of capture.fixtureSkills) expect(text).toContain(`${skill.name}: ${skill.description}`);
});
