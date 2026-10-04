import { expect, test } from "bun:test";
import { BRIDGE_TOOL_POSTURE } from "@schlessera/brain-ui-sdk/server";
import { createJevClient } from "../packages/ui-server/src/classification/jev-client.js";
import { connectSurface, routePreparedTurn, routingRequest, scoreCalls, serializedTurn, type Arm } from "../scripts/turn-surface-routing.js";
import { connectBrainSurface, createFixture, fixtureTurn, scriptedAnswers } from "../scripts/turn-surface-fixture.js";
import { measureKeyless } from "../scripts/measure-turn-surface-keyless.js";

const BLOCK = "mcp__brain-ui__show_block";
const quote = { block: { kind: "quote", quote: "Inspect the mast before sailing." } };

test("inventory uses actual core stdio tools, project skill files and production bridge assembly", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Inventory Odysseus's notebook.");
  const core = await connectBrainSurface(fixture.root);
  try {
    expect(prepared.peer.tools.map(tool => tool.name).sort()).toEqual([...BRIDGE_TOOL_POSTURE.names].sort());
    expect(prepared.peer.tools.every(tool => tool._meta?.["anthropic/alwaysLoad"] === true)).toBe(true);
    expect(prepared.peer.tools.every(tool => Object.keys(tool.inputSchema.properties ?? {}).length > 0)).toBe(true);
    expect(core.tools.map(tool => tool.name).sort()).toEqual(["brain_add", "brain_archive", "brain_context", "brain_graph", "brain_list", "brain_read", "brain_search", "brain_update"]);
    expect(core.client.getInstructions()).toContain("Odysseus");
    const response = await core.client.callTool({ name: "brain_read", arguments: { path: "me/identity.md" } });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response)).toContain("preparing the next voyage");
    expect(Object.keys(fixture.skillFiles()).sort()).toEqual(fixture.skills.map(skill => skill.name).sort());
    expect(prepared.turn.options.settingSources).toEqual(["project"]);
  } finally { await core.client.close(); await prepared.close(); fixture.close(); }
});

for (const posture of ["normal", "no-grant", "autonomous"] as const) {
  for (const failure of ["off", "no_key", "timeout", "circuit_open", "low_confidence", "bad_response", "unknown_choice"] as const) {
    test(`${failure} preserves the real ${posture} turn, schemas, permissions and skill bytes`, async () => {
      const fixture = createFixture();
      const prepared = await fixtureTurn(fixture.root, "Show a quote card.", posture);
      const before = serializedTurn(prepared.turn);
      const skillBytes = fixture.skillFiles();
      let calls = 0;
      const client = createJevClient({ apiKey: failure === "no_key" ? null : "fixture", timeoutMs: 8, fetch: async (_url, init) => {
        calls++;
        if (failure === "timeout") return new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
        });
        if (failure === "circuit_open") return new Response("", { status: 500 });
        if (failure === "bad_response") return Response.json({ unexpected: true });
        const request = JSON.parse(String(init.body));
        expect(Object.keys(request.questions).length).toBeGreaterThan(4);
        expect(Object.keys(request.questions.tool.criteria).length).toBeGreaterThan(0);
        expect(Object.keys(request.questions.skill.criteria).length).toBeGreaterThan(0);
        const answers = scriptedAnswers(request, BLOCK, null);
        if (failure === "low_confidence" && answers.tool.type === "choice") answers.tool.confidence = 0.1;
        if (failure === "unknown_choice" && answers.tool.type === "choice") answers.tool.choice = "mcp__brain-ui__invented";
        return Response.json({ answers });
      } });
      try {
        if (failure === "circuit_open") {
          const request = routingRequest("show a quote", "", prepared.peer.tools, fixture.skills);
          for (let count = 0; count < 3; count++) await client.classify(request);
          expect(client.breaker().open).toBe(true);
        }
        const requestsBefore = calls;
        const result = await routePreparedTurn(prepared.turn, { enabled: failure !== "off", arm: "hard-prune", client,
          peers: { "brain-ui": prepared.peer }, skills: fixture.skills, budgetMs: 30 });
        expect(result.outcome).toBe(failure === "unknown_choice" ? "low_confidence" : failure);
        expect(serializedTurn(result.turn)).toBe(before);
        expect(result.turn).toBe(prepared.turn);
        expect(result.turn.options.canUseTool).toBe(prepared.turn.options.canUseTool);
        expect(result.turn.options.hooks).toBe(prepared.turn.options.hooks);
        expect(result.turn.options.env).toBe(prepared.turn.options.env);
        expect(fixture.skillFiles()).toEqual(skillBytes);
        expect(result.pruneFixtureSkills).toBe(false);
        const { tools } = await prepared.peer.client.listTools();
        expect(tools.length).toBeGreaterThan(0);
        expect(JSON.stringify(tools)).toBe(JSON.stringify(prepared.peer.tools.map(({ id: _id, serverName: _serverName, ...tool }) => tool)));
        if (["off", "no_key", "circuit_open"].includes(failure)) expect(calls).toBe(requestsBefore);
        if (failure === "timeout") expect(result.durationMs).toBeLessThan(250);
      } finally { await prepared.close(); fixture.close(); }
    });
  }
}

for (const arm of ["hint", "load-set", "hard-prune"] as Arm[]) {
  test(`${arm} uses real MCP listing and original handlers without changing permission authority`, async () => {
    const fixture = createFixture();
    const prepared = await fixtureTurn(fixture.root, "Show the mast reminder as a quote.");
    let routed: Awaited<ReturnType<typeof connectSurface>> | undefined;
    const client = createJevClient({ apiKey: "fixture", fetch: async (_url, init) => Response.json({ answers: scriptedAnswers(JSON.parse(String(init.body)), BLOCK, "voyage-plan") }) });
    try {
      const result = await routePreparedTurn(prepared.turn, { enabled: true, arm, client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
      expect(result.outcome).toBe("answered");
      expect(result.tools).toEqual([BLOCK]);
      expect(result.skills).toEqual(["voyage-plan"]);
      expect(result.turn.options.allowedTools).toBe(prepared.turn.options.allowedTools);
      expect(result.turn.options.canUseTool).toBe(prepared.turn.options.canUseTool);
      expect(result.turn.options.hooks).toBe(prepared.turn.options.hooks);
      expect(result.turn.options.env).toBe(prepared.turn.options.env);
      let peer = prepared.peer;
      if (arm !== "hint") {
        const server = result.turn.options.mcpServers!["brain-ui"];
        if (server.type !== "sdk") throw new Error("missing SDK server");
        peer = routed = await connectSurface("brain-ui", server);
      } else {
        expect(result.turn.options.mcpServers).toBe(prepared.turn.options.mcpServers);
        const original = prepared.turn.options.systemPrompt;
        const altered = result.turn.options.systemPrompt;
        if (!original || typeof original === "string" || Array.isArray(original) || original.type !== "preset" || !altered || typeof altered === "string" || Array.isArray(altered) || altered.type !== "preset") throw new Error("preset missing");
        expect(altered.append!.startsWith(original.append!)).toBe(true);
      }
      expect(peer.tools.length).toBe(arm === "hard-prune" ? 1 : 8);
      expect(peer.tools.find(tool => tool.id === BLOCK)?.inputSchema).toEqual(prepared.peer.tools.find(tool => tool.id === BLOCK)!.inputSchema);
      const response = await peer.client.callTool({ name: "show_block", arguments: quote });
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response)).toContain("Inspect the mast");
      const invalid = await peer.client.callTool({ name: "show_block", arguments: { block: {} } }).catch(() => ({ isError: true }));
      expect(invalid.isError).toBe(true);
      if (arm === "load-set") {
        expect(peer.tools.filter(tool => tool._meta?.["anthropic/alwaysLoad"] === true).map(tool => tool.id)).toEqual([BLOCK]);
        // A missed/deferred tool is still callable at the real MCP boundary.
        const missed = await peer.client.callTool({ name: "ask_user", arguments: { questions: [{ header: "Harbour", question: "Which harbour?", multiSelect: false, options: [{ label: "Ithaca", description: "Return home." }, { label: "Pylos", description: "Visit Nestor." }] }] } });
        expect(missed.isError).not.toBe(true);
        expect(prepared.askUserCalls()).toBe(1);
        expect(peer.tools.find(tool => tool.name === "ask_user")?._meta?.["anthropic/alwaysLoad"]).toBe(false);
      }
      if (result.pruneFixtureSkills) fixture.pruneSkills(result.skills);
      expect(Object.keys(fixture.skillFiles()).length).toBe(arm === "hard-prune" ? 1 : 3);
      if (arm === "hard-prune") await expect(peer.client.callTool({ name: "ask_user", arguments: {} })).rejects.toThrow("absent from this diagnostic arm");
    } finally { await routed?.client.close(); await prepared.close(); fixture.close(); }
  });
}

test("assembly budget bounds even a transport ignoring cancellation", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Show a quote card.");
  const client = createJevClient({ apiKey: "fixture", fetch: () => new Promise(() => {}), timeoutMs: 1000 });
  try {
    const result = await routePreparedTurn(prepared.turn, { enabled: true, arm: "load-set", client, budgetMs: 8,
      peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(result.outcome).toBe("timeout");
    expect(result.turn).toBe(prepared.turn);
    expect(result.durationMs).toBeLessThan(250);
  } finally { await prepared.close(); fixture.close(); }
});

for (const posture of ["no-grant", "autonomous"] as const) test(`successful selection preserves ${posture} capability withholding and exact authority`, async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Show a quote.", posture);
  let routed: Awaited<ReturnType<typeof connectSurface>> | undefined;
  try {
    const client = createJevClient({ apiKey: "fixture", fetch: async (_url, init) => Response.json({ answers: scriptedAnswers(JSON.parse(String(init.body)), BLOCK, null) }) });
    const result = await routePreparedTurn(prepared.turn, { enabled: true, arm: "load-set", client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    const server = result.turn.options.mcpServers!["brain-ui"];
    if (server.type !== "sdk") throw new Error("missing SDK server");
    routed = await connectSurface("brain-ui", server);
    expect(routed.tools.map(tool => tool.name).sort()).toEqual(["ask_user", "get_current_location", "query_activity", "show_block"]);
    expect(result.turn.options.allowedTools).toEqual(prepared.turn.options.allowedTools);
    if (posture === "autonomous") expect(result.turn.options.allowedTools).toEqual(["Read"]);
    expect(result.turn.options.canUseTool).toBe(prepared.turn.options.canUseTool);
  } finally { await routed?.client.close(); await prepared.close(); fixture.close(); }
});

test("request uses bounded real descriptions, separate absolute gates and only the previous tail", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Use voyage planning.");
  try {
    const request = routingRequest("Use voyage planning.", "obsolete context" + "x".repeat(1000), prepared.peer.tools, fixture.skills);
    expect(request.state).toEqual({ request: "Use voyage planning.", previous_assistant_tail: "x".repeat(1000) });
    expect(Object.keys(request.questions)).toHaveLength(15);
    expect(request.questions.needs_tool.type).toBe("noul");
    expect(request.questions.needs_skill.type).toBe("noul");
    const choices = request.questions.tool;
    if (choices.type !== "choice") throw new Error("missing tool choice");
    expect(Object.keys(choices.criteria)).toHaveLength(8);
    expect(Object.values(choices.criteria).every(description => description.length > 0 && description.length <= 300)).toBe(true);
    expect(request.questions[`fits_tool:${BLOCK}`].instructions).toContain(prepared.peer.tools.find(tool => tool.id === BLOCK)!.description!);
    expect(() => routingRequest("request", "", [], fixture.skills)).toThrow("nonempty");
  } finally { await prepared.close(); fixture.close(); }
});

test("D44 scoring excludes invalid arguments, subagent calls and incomplete turns for the intended reason", () => {
  const frames = [{ parent_tool_use_id: null, calls: [{ name: BLOCK, input: quote }, { name: BLOCK, input: { block: {} } }] },
    { parent_tool_use_id: "delegated", calls: [{ name: BLOCK, input: quote }] }];
  expect(scoreCalls(frames, true)).toEqual({ included: true, valid: [BLOCK], rejected: 1 });
  expect(scoreCalls(frames, false)).toEqual({ included: false, valid: [], rejected: 0 });
});

test("four arms share six frozen nonempty cases and expose scripted false-negative controls without live metrics", async () => {
  const report = await measureKeyless();
  expect(report.rows).toHaveLength(24);
  for (const arm of ["baseline", "hint", "load-set", "hard-prune"]) expect(report.rows.filter(row => row.arm === arm).map(row => row.case)).toEqual(report.rows.filter(row => row.arm === "baseline").map(row => row.case));
  const missed = report.rows.filter(row => row.case === "missed-quote");
  expect(missed.map(row => row.neededToolReachable)).toEqual([true, true, true, false]);
  expect(missed.map(row => row.scriptedValidCalls.length)).toEqual([1, 1, 1, 0]);
  expect(report.rows.filter(row => row.case === "wrong-skill" && row.arm !== "baseline").every(row => row.scriptedWrongSuggestion)).toBe(true);
  expect(report.rows.filter(row => row.case === "needless-skill" && row.arm !== "baseline").every(row => row.scriptedNeedlessSuggestion)).toBe(true);
  expect(Object.values(report.live).every(value => value === null)).toBe(true);
});
