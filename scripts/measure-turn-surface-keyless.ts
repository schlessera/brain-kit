/** #587 offline mechanics. This entry has no live transport or query import. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJevClient } from "../packages/ui-server/src/classification/jev-client.js";
import { discoverSkills } from "../packages/core/src/lib/skills/discover.js";
import { ARMS, connectSurface, routePreparedTurn, scoreCalls, type Arm } from "./turn-surface-routing.js";
import { connectBrainSurface, createFixture, fixtureTurn, FROZEN_CASES, installedRuntime, scriptedAnswers } from "./turn-surface-fixture.js";

export async function measureKeyless() {
  const inventoryFixture = createFixture();
  const inventoryTurn = await fixtureTurn(inventoryFixture.root, "Inventory the voyage notebook.");
  const brain = await connectBrainSurface(inventoryFixture.root);
  let inventory;
  try {
    const shipped = discoverSkills({ root: inventoryFixture.root, modules: [] });
    inventory = {
      runtime: installedRuntime(),
      bridge: inventoryTurn.peer.tools.map(({ id, description, inputSchema, _meta }) => ({ id, description, inputSchema, _meta })),
      brain: { tools: brain.tools.map(({ id, description, inputSchema, annotations }) => ({ id, description, inputSchema, annotations })), instructions: brain.client.getInstructions() },
      shippedAndLocalSkills: shipped.skills.map(({ name, description, source }) => ({ name, description, source })),
      fixtureProjectSkills: inventoryFixture.skillFiles(),
      systemPromptAppend: inventoryTurn.turn.options.systemPrompt,
      settingSources: inventoryTurn.turn.options.settingSources,
      unobserved: ["CLI built-in schemas and preset prompt", "CLI-generated skill listing", "full API request and cache boundaries"],
    };
  } finally { await brain.client.close(); await inventoryTurn.close(); inventoryFixture.close(); }
  const rows = [];
  for (const arm of ARMS) for (const sample of FROZEN_CASES.cases) {
    rows.push(await measureCase(arm, sample));
  }
  return { evidence: "keyless-scripted-mechanics", fixtureVersion: 1, inventory,
    serializedInventoryBytes: Buffer.byteLength(JSON.stringify(inventory)), rows,
    live: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, firstFrameMs: null, jevCostUsd: null, runToRunSpread: null },
    interpretation: "No model ran. Bytes are not tokens. Reachability and scripted choices are not tool-use or skill-load rates. No routing shape or confidence policy is adopted." };
}

async function measureCase(arm: Arm, sample: typeof FROZEN_CASES.cases[number]) {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, sample.prompt);
  let routedPeer: Awaited<ReturnType<typeof connectSurface>> | undefined;
  let calls = 0;
  let requestBytes = 0;
  try {
    const client = createJevClient({ apiKey: "scripted-fixture", fetch: async (_url, init) => {
      calls++; requestBytes = Buffer.byteLength(String(init.body));
      const request = JSON.parse(String(init.body));
      return Response.json({ answers: scriptedAnswers(request, sample.pickedTool, sample.pickedSkill) });
    } });
    const result = await routePreparedTurn(prepared.turn, { enabled: true, arm, client,
      peers: { "brain-ui": prepared.peer }, skills: fixture.skills, previousTail: "Odysseus is planning the next leg.", budgetMs: 2000 });
    if (result.pruneFixtureSkills) fixture.pruneSkills(result.skills);
    let peer = prepared.peer;
    const server = result.turn.options.mcpServers?.["brain-ui"];
    if (!server || server.type !== "sdk") throw new Error("missing routed bridge");
    if (result.turn !== prepared.turn && arm !== "hint") peer = routedPeer = await connectSurface("brain-ui", server);
    const available = peer.tools.map(tool => tool.id);
    let invoked = false;
    if (sample.neededTool && available.includes(sample.neededTool)) {
      const response = await peer.client.callTool({ name: sample.neededTool.replace("mcp__brain-ui__", ""), arguments: sample.input ?? {} });
      if (response.isError) throw new Error("scripted valid call failed at the original executor");
      invoked = true;
    }
    const files = fixture.skillFiles();
    const parsedCalls = scoreCalls([{ parent_tool_use_id: null, calls: invoked ? [{ name: sample.neededTool!, input: sample.input }] : [] }], true);
    return { arm, case: sample.id, outcome: result.outcome, classifierRequests: calls, requestBytes,
      exposedTools: available, eagerTools: peer.tools.filter(tool => tool._meta?.["anthropic/alwaysLoad"] === true).map(tool => tool.id),
      projectSkillEntries: Object.keys(files), neededToolReachable: sample.neededTool ? available.includes(sample.neededTool) : null,
      scriptedValidCalls: parsedCalls.valid, scriptedWrongSuggestion: sample.neededSkill !== null && result.skills.length > 0 && !result.skills.includes(sample.neededSkill),
      scriptedNeedlessSuggestion: sample.neededSkill === null && result.skills.length > 0,
      // Model skill loading and ToolSearch have deliberately not been simulated.
      observedSkillLoads: null, toolSearchRoundTrips: null };
  } finally { await routedPeer?.client.close(); await prepared.close(); fixture.close(); }
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("keyless command takes no flags; live/count_tokens execution is not implemented or authorized");
  // Validate that the committed input is still available; no cached model
  // responses are being presented as new experiments.
  readFileSync(join(import.meta.dir, "fixtures/turn-surface-cases.json"));
  console.log(JSON.stringify(await measureKeyless(), null, 2));
}
