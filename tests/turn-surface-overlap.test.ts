import { expect, test } from "bun:test";
import { captureSurface } from "../scripts/capture-turn-surface";
import type { SurfaceDecision } from "../scripts/turn-surface-overlap";
import { observedSkills } from "../scripts/turn-surface-skills";

test("installed CLI spawns before routing settles, then applies MCP load set", async () => {
  let spawned = false;
  let decisionSettled = false;
  let spawnWasBeforeDecision = false;
  let settle!: (decision: SurfaceDecision) => void;
  const decision = new Promise<SurfaceDecision>(resolve => { settle = resolve; });
  const result = await captureSurface({ decision, onSpawn: () => {
    spawned = true;
    spawnWasBeforeDecision = !decisionSettled;
    decisionSettled = true;
    settle({ arm: "load-set", routed: true, tools: ["mcp__brain-ui__show_block"], skills: [] });
  }, recoverTool: "mcp__brain__brain_search" });
  expect(spawned).toBe(true);
  expect(spawnWasBeforeDecision).toBe(true);
  const bridge = result.request.tools.filter(tool => tool.name.startsWith("mcp__brain-ui__"));
  expect(bridge).toHaveLength(1);
  expect(bridge.find(tool => tool.name === "mcp__brain-ui__show_block")?.defer_loading).not.toBe(true);
  expect(result.request.tools.some(tool => tool.name === "ToolSearch")).toBe(true);
  const core = result.request.tools.filter(tool => tool.name.startsWith("mcp__brain__"));
  expect(core).toHaveLength(0);
  expect(result.requests).toHaveLength(2);
  const recovered = result.requests[1]!.tools.find(tool => tool.name === "mcp__brain__brain_search");
  expect(recovered?.input_schema).toBeDefined();
  expect(recovered?.defer_loading).toBe(true);
  expect(JSON.stringify(result.requests[1]!.messages)).toContain("tool_reference");
  expect(JSON.stringify(result.requests[1]!.messages)).toContain("mcp__brain__brain_search");
  expect(result.cliVersion).toBe(result.runtime.claudeCode);
});

test("installed CLI hard pruning removes rejected MCP tools and project skill listings", async () => {
  const result = await captureSurface({ decision: Promise.resolve({ arm: "hard-prune", routed: true,
    tools: ["mcp__brain-ui__show_block"], skills: ["voyage-plan"] }),
    skillCatalogue: ["voyage-plan", "shipbuilding", "crew-log", "dataviz", "code-review", "claude-api"] });
  expect(result.request.tools.filter(tool => tool.name.startsWith("mcp__"))).toHaveLength(1);
  expect(result.request.tools.some(tool => tool.name === "mcp__brain-ui__show_block")).toBe(true);
  const messages = JSON.stringify(result.request.messages);
  expect(messages).toContain("voyage-plan:");
  expect(messages).not.toContain("shipbuilding:");
  expect(messages).not.toContain("crew-log:");
  expect(messages).not.toContain("dataviz:");
  expect(messages).not.toContain("code-review:");
  expect(messages).not.toContain("claude-api:");
  // The diagnostic prunes MCP/skills; built-in availability stays constant.
  expect(result.request.tools.some(tool => tool.name === "Read")).toBe(true);
});

test("installed CLI relevance hint follows the unchanged complete skill listing", async () => {
  const result = await captureSurface({ decision: Promise.resolve({ arm: "hint", routed: true,
    tools: ["mcp__brain-ui__show_block"], skills: ["voyage-plan"] }) });
  expect(result.request.tools.filter(tool => tool.name.startsWith("mcp__"))).toHaveLength(16);
  const messages = JSON.stringify(result.request.messages);
  const hint = messages.indexOf("<tool_relevance>");
  expect(hint).toBeGreaterThan(0);
  for (const name of ["voyage-plan:", "shipbuilding:", "crew-log:"]) {
    const listed = messages.indexOf(name);
    expect(listed).toBeGreaterThan(0);
    expect(hint).toBeGreaterThan(listed);
  }
  expect(JSON.stringify(result.request.system)).not.toContain("<tool_relevance>");
  const skills = observedSkills(result.request);
  expect(skills).toHaveLength(15);
  expect(skills.find(skill => skill.name === "claude-api")?.description).toContain("SKIP only when another provider");
  expect(skills.find(skill => skill.name === "dataviz")?.description).toContain("color by series");
});

test("native skill load set keeps rejected names discoverable without their descriptions", async () => {
  const result = await captureSurface({ decision: Promise.resolve({ arm: "load-set", routed: true,
    tools: [], skills: ["voyage-plan"] }), skillCatalogue: ["voyage-plan", "shipbuilding", "crew-log", "dataviz"] });
  const messages = JSON.stringify(result.request.messages);
  expect(messages).toContain("voyage-plan: Plan Odysseus");
  expect(messages).toContain("shipbuilding");
  expect(messages).not.toContain("Review timber and assembly notes for Odysseus");
  expect(messages).toContain("dataviz");
  expect(messages).not.toContain("Use this skill whenever you are about to create ANY chart");
});

test("router fallback preserves all actual MCP tools and all project skills", async () => {
  const result = await captureSurface({ decision: Promise.resolve({ arm: "hard-prune", routed: false, tools: [], skills: [] }) });
  expect(result.request.tools.filter(tool => tool.name.startsWith("mcp__"))).toHaveLength(16);
  expect(result.request.tools.filter(tool => tool.name.startsWith("mcp__")).every(tool => tool.defer_loading !== true)).toBe(true);
  const messages = JSON.stringify(result.request.messages);
  for (const name of ["voyage-plan:", "shipbuilding:", "crew-log:"]) expect(messages).toContain(name);
  expect(messages).not.toContain("<tool_relevance>");
});
