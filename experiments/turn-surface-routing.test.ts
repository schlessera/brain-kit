import { expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClassificationRequest } from "@schlessera/brain-ui-sdk/internal";
import type { ClaudeSdkTurn } from "../packages/ui-backend-claude/src/sdk-options.js";
import { createJevClient } from "../packages/ui-server/src/classification/jev-client.js";
import { connectSurface, routePreparedTurn, routingRequest, scoreCalls, serializedTurn, type Arm } from "../scripts/turn-surface-routing.js";
import { connectBrainSurface, createFixture, fixtureTurn, scriptedAnswers, STABLE_BRIDGE_ROSTER } from "../scripts/turn-surface-fixture.js";
import { measureKeyless } from "../scripts/measure-turn-surface-keyless.js";

const BLOCK = "mcp__brain-ui__show_block";
const quote = { block: { kind: "quote", quote: "Inspect the mast before sailing." } };

/**
 * Pass the production prompt stream through a recorder, so a test knows
 * exactly which message objects production yielded once the router has read
 * them. The recorder adds nothing: it yields each production message as is.
 */
function recorded(turn: ClaudeSdkTurn) {
  const yielded: SDKUserMessage[] = [];
  if (typeof turn.prompt === "string") throw new Error("expected a streamed production prompt");
  const source = turn.prompt;
  const prompt = (async function* () { for await (const message of source) { yielded.push(message); yield message; } })();
  return { turn: { ...turn, prompt }, yielded };
}

async function consume(prompt: ClaudeSdkTurn["prompt"]): Promise<SDKUserMessage[]> {
  if (typeof prompt === "string") throw new Error("expected a streamed prompt");
  const messages: SDKUserMessage[] = [];
  for await (const message of prompt) messages.push(message);
  return messages;
}

/**
 * A turn whose stream the router has read: every other field is the prepared
 * turn's own, and the stream yields exactly the production messages, the same
 * objects in the same order, once each.
 */
async function expectEquivalentTurn(actual: ClaudeSdkTurn, prepared: ClaudeSdkTurn, yielded: SDKUserMessage[]) {
  expect(actual).not.toBe(prepared);
  expect(Object.keys(actual).sort()).toEqual(Object.keys(prepared).sort());
  for (const key of Object.keys(prepared) as (keyof ClaudeSdkTurn)[]) if (key !== "prompt") expect(actual[key]).toBe(prepared[key]);
  const pulledByRouter = yielded.length;
  const delivered = await consume(actual.prompt);
  // The router pulled the whole production stream; the consumer receives it
  // once, with nothing lost, duplicated, reordered or rebuilt.
  expect(yielded.length).toBe(pulledByRouter);
  expect(delivered).toHaveLength(yielded.length);
  delivered.forEach((message, index) => expect(message).toBe(yielded[index]!));
  expect(JSON.stringify(delivered)).toBe(JSON.stringify(yielded));
  return delivered;
}

const messageText = (message: SDKUserMessage) => {
  const content = message.message.content;
  if (typeof content !== "string") throw new Error("expected a text-only message");
  return content;
};

async function* messages(...items: SDKUserMessage[]) { for (const item of items) yield item; }
const userText = (text: string): SDKUserMessage => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text }, session_id: "" });

test("inventory uses actual core stdio tools, project skill files and production bridge assembly", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Inventory Odysseus's notebook.");
  const core = await connectBrainSurface(fixture.root);
  try {
    expect(prepared.peer.tools.map(tool => tool.name).sort()).toEqual([...STABLE_BRIDGE_ROSTER]);
    expect(prepared.peer.tools.every(tool => tool._meta?.["anthropic/alwaysLoad"] === true)).toBe(true);
    expect(prepared.peer.tools.every(tool => Object.keys(tool.inputSchema.properties ?? {}).length > 0)).toBe(true);
    expect(core.tools.map(tool => tool.name).sort()).toEqual(["brain_add", "brain_archive", "brain_context", "brain_graph", "brain_list", "brain_read", "brain_read_many", "brain_search", "brain_update"]);
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
      // Autonomous turns carry a string prompt; interactive ones stream it.
      const streamed = typeof prepared.turn.prompt !== "string";
      const input = streamed ? recorded(prepared.turn) : { turn: prepared.turn, yielded: [] };
      const before = serializedTurn(input.turn);
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
        const result = await routePreparedTurn(input.turn, { enabled: failure !== "off", arm: "hard-prune", client,
          peers: { "brain-ui": prepared.peer }, skills: fixture.skills, budgetMs: 30 });
        expect(result.outcome).toBe(failure === "unknown_choice" ? "low_confidence" : failure);
        // Outcomes decided before the prompt is read return the turn itself;
        // after a streamed prompt was read, an equivalent turn.
        const unread = !streamed || ["off", "no_key", "circuit_open"].includes(failure);
        if (unread) {
          expect(result.turn).toBe(input.turn);
          expect(input.yielded).toHaveLength(0);
        } else {
          expect(input.yielded).toHaveLength(1);
          await expectEquivalentTurn(result.turn, input.turn, input.yielded);
        }
        expect(serializedTurn(result.turn)).toBe(before);
        expect(result.turn.options.canUseTool).toBe(prepared.turn.options.canUseTool);
        expect(result.turn.options.hooks).toBe(prepared.turn.options.hooks);
        expect(result.turn.options.env).toBe(prepared.turn.options.env);
        expect(fixture.skillFiles()).toEqual(skillBytes);
        expect(result.pruneFixtureSkills).toBe(false);
        const server = result.turn.options.mcpServers!["brain-ui"];
        if (server.type !== "sdk") throw new Error("missing returned turn server");
        // Connecting this actual returned entry also catches an inventory
        // probe that has already occupied the baseline's transport.
        const connection = connectSurface("brain-ui", server);
        await expect(connection).resolves.toHaveProperty("tools");
        const observed = await connection;
        try {
          expect(observed.tools.length).toBeGreaterThan(0);
          expect(JSON.stringify(observed.tools)).toBe(JSON.stringify(prepared.peer.tools));
          if (posture !== "autonomous") expect(observed.tools.map(tool => tool.name).sort()).toEqual([...STABLE_BRIDGE_ROSTER]);
        } finally { await observed.client.close(); }
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
      const input = recorded(prepared.turn);
      const result = await routePreparedTurn(input.turn, { enabled: true, arm, client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
      expect(result.outcome).toBe("answered");
      expect(result.turn.options).not.toBe(input.turn.options);
      await expectEquivalentTurn({ ...result.turn, options: input.turn.options }, input.turn, input.yielded);
      expect(result.tools).toEqual([BLOCK]);
      expect(result.skills).toEqual(["voyage-plan"]);
      expect(result.turn.options.allowedTools).toBe(prepared.turn.options.allowedTools);
      expect(result.turn.options.canUseTool).toBe(prepared.turn.options.canUseTool);
      expect(result.turn.options.hooks).toBe(prepared.turn.options.hooks);
      expect(result.turn.options.env).toBe(prepared.turn.options.env);
      const server = result.turn.options.mcpServers!["brain-ui"];
      if (server.type !== "sdk") throw new Error("missing SDK server");
      const peer = routed = await connectSurface("brain-ui", server);
      if (arm === "hint") {
        expect(result.turn.options.mcpServers).toBe(prepared.turn.options.mcpServers);
        const original = prepared.turn.options.systemPrompt;
        const altered = result.turn.options.systemPrompt;
        if (!original || typeof original === "string" || Array.isArray(original) || original.type !== "preset" || !altered || typeof altered === "string" || Array.isArray(altered) || altered.type !== "preset") throw new Error("preset missing");
        expect(altered.append!.startsWith(original.append!)).toBe(true);
      }
      expect(peer.tools.length).toBe(arm === "hard-prune" ? 1 : STABLE_BRIDGE_ROSTER.length);
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
    const input = recorded(prepared.turn);
    const result = await routePreparedTurn(input.turn, { enabled: true, arm: "load-set", client, budgetMs: 8,
      peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(250);
    await expectEquivalentTurn(result.turn, input.turn, input.yielded);
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
    // No-grant turns register the full stable roster and withhold at the
    // permission hook; autonomous turns keep their exact handler membership.
    expect(routed.tools.map(tool => tool.name).sort()).toEqual(posture === "autonomous"
      ? ["ask_user", "complete_share", "get_current_location", "inbox_add", "inbox_get", "inbox_list", "query_activity", "resolve_action", "show_block"]
      : [...STABLE_BRIDGE_ROSTER]);
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
    expect(Object.keys(request.questions)).toHaveLength(4 + STABLE_BRIDGE_ROSTER.length + fixture.skills.length);
    expect(request.questions.needs_tool.type).toBe("noul");
    expect(request.questions.needs_skill.type).toBe("noul");
    const choices = request.questions.tool;
    if (choices.type !== "choice") throw new Error("missing tool choice");
    expect(Object.keys(choices.criteria)).toHaveLength(STABLE_BRIDGE_ROSTER.length);
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

test("a production attachment stream preserves the turn instead of classifying an empty request", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Describe the vessel.", "normal", [{ data: "fixture-image-data", mediaType: "image/png" }]);
  let calls = 0;
  const client = createJevClient({ apiKey: "fixture", fetch: async () => { calls++; return Response.json({ answers: {} }); } });
  try {
    const input = recorded(prepared.turn);
    const result = await routePreparedTurn(input.turn, { enabled: true, arm: "hard-prune", client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(calls).toBe(0);
    expect(result.outcome).toBe("unsupported_input");
    const [message] = await expectEquivalentTurn(result.turn, input.turn, input.yielded);
    const content = message!.message.content;
    if (!Array.isArray(content)) throw new Error("expected attachment content blocks");
    expect(content.map(block => block.type)).toEqual(["text", "image"]);
  } finally { await prepared.close(); fixture.close(); }
});

test("a single text-only streamed message is classified as sent and reaches the provider unchanged", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Show the mast reminder as a quote.");
  const requests: ClassificationRequest[] = [];
  const client = createJevClient({ apiKey: "fixture", fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body)) as ClassificationRequest;
    requests.push(request);
    return Response.json({ answers: scriptedAnswers(request, BLOCK, null) });
  } });
  try {
    // Production streams one owned user message (createClaudeSdkTurn).
    expect(typeof prepared.turn.prompt).not.toBe("string");
    const input = recorded(prepared.turn);
    const result = await routePreparedTurn(input.turn, { enabled: true, arm: "hard-prune", client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(result.outcome).toBe("answered");
    expect(input.yielded).toHaveLength(1);
    const sent = messageText(input.yielded[0]!);
    expect(sent.startsWith("Show the mast reminder as a quote.")).toBe(true);
    // The classifier read the message text the provider receives, once.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state.request).toBe(sent);
    const delivered = await expectEquivalentTurn({ ...result.turn, options: input.turn.options }, input.turn, input.yielded);
    expect(delivered.map(messageText)).toEqual([sent]);
  } finally { await prepared.close(); fixture.close(); }
});

test("a multi-message stream is refused unread by the classifier and replayed whole", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Show a quote card.");
  let calls = 0;
  const client = createJevClient({ apiKey: "fixture", fetch: async () => { calls++; return Response.json({ answers: {} }); } });
  const first = userText("Show a quote card."), second = userText("And the mast reminder.");
  const turn = { ...prepared.turn, prompt: messages(first, second) };
  try {
    const result = await routePreparedTurn(turn, { enabled: true, arm: "hard-prune", client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(result.outcome).toBe("unsupported_input");
    expect(calls).toBe(0);
    await expectEquivalentTurn(result.turn, turn, [first, second]);
  } finally { await prepared.close(); fixture.close(); }
});

test("a stream still open at the budget times out and still delivers its late message", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Show a quote card.");
  let calls = 0;
  const client = createJevClient({ apiKey: "fixture", fetch: async () => { calls++; return Response.json({ answers: {} }); } });
  const first = userText("Show a quote card."), late = userText("Also the mast reminder.");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turn = { ...prepared.turn, prompt: (async function* () { yield first; await gate; yield late; })() };
  try {
    const result = await routePreparedTurn(turn, { enabled: true, arm: "hard-prune", client, budgetMs: 8, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(250);
    expect(calls).toBe(0);
    release();
    await expectEquivalentTurn(result.turn, turn, [first, late]);
  } finally { await prepared.close(); fixture.close(); }
});

test("a stream that fails after its first message is refused and the failure reaches the consumer", async () => {
  const fixture = createFixture();
  const prepared = await fixtureTurn(fixture.root, "Show a quote card.");
  const client = createJevClient({ apiKey: "fixture", fetch: async () => Response.json({ answers: {} }) });
  const first = userText("Show a quote card.");
  const turn = { ...prepared.turn, prompt: (async function* () { yield first; throw new Error("fixture stream failure"); })() };
  try {
    const result = await routePreparedTurn(turn, { enabled: true, arm: "hard-prune", client, peers: { "brain-ui": prepared.peer }, skills: fixture.skills });
    expect(result.outcome).toBe("unsupported_input");
    if (typeof result.turn.prompt === "string") throw new Error("expected a stream");
    const iterator = result.turn.prompt[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(first);
    await expect(iterator.next()).rejects.toThrow("fixture stream failure");
  } finally { await prepared.close(); fixture.close(); }
});

test("four arms share six frozen nonempty cases and expose scripted false-negative controls without live metrics", async () => {
  const report = await measureKeyless();
  expect(report.rows).toHaveLength(24);
  expect([...new Set(report.rows.map(row => row.case))].sort()).toEqual(["missed-quote", "needed-quote", "needed-skill", "needless-skill", "prose-only", "wrong-skill"]);
  for (const arm of ["baseline", "hint", "load-set", "hard-prune"]) expect(report.rows.filter(row => row.arm === arm).map(row => row.case)).toEqual(report.rows.filter(row => row.arm === "baseline").map(row => row.case));
  const missed = report.rows.filter(row => row.case === "missed-quote");
  expect(missed.map(row => row.neededToolReachable)).toEqual([true, true, true, false]);
  expect(missed.map(row => row.scriptedValidCalls.length)).toEqual([1, 1, 1, 0]);
  expect(report.rows.filter(row => row.case === "wrong-skill" && row.arm !== "baseline").every(row => row.scriptedWrongSuggestion)).toBe(true);
  expect(report.rows.filter(row => row.case === "needless-skill" && row.arm !== "baseline").every(row => row.scriptedNeedlessSuggestion)).toBe(true);
  expect(Object.keys(report.live)).toHaveLength(6);
  expect(Object.values(report.live).every(value => value === null)).toBe(true);
});
