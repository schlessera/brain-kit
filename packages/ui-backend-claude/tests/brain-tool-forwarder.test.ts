import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainToolForwarder } from "../src/brain-tool-forwarder.js";
import { brainReadDefinitions } from "@schlessera/brain/internal";

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "odysseus", version: "1" });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}

test("an early core read waits for readiness, then forwards unchanged; ready reads reuse the one process", async () => {
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = new McpServer({ name: "brain", version: "1" });
  const result = { content: [{ type: "text" as const, text: "Odysseus repairs the raft." }] };
  stdio.registerTool("brain_read", brainReadDefinitions().brain_read, async () => result);
  await stdio.connect(serverTransport);
  let starts = 0, closes = 0;
  const errors: unknown[] = [];
  const forward = createBrainToolForwarder(async () => {
    starts++; started.resolve(); await gate.promise;
    return { transport, async close() { closes++; await transport.close(); } };
  }, new AbortController().signal, error => errors.push(error));
  const client = await connect(forward.server.instance);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name).sort()).toEqual(["brain_context", "brain_graph", "brain_list", "brain_read", "brain_read_many", "brain_search"]);
    expect(tools.filter(tool => tool._meta?.["anthropic/alwaysLoad"]).map(tool => tool.name).sort()).toEqual(["brain_context", "brain_list", "brain_read", "brain_read_many", "brain_search"]);
    forward.start(); await started.promise;
    let completed = false;
    const early = client.callTool({ name: "brain_read", arguments: { path: "notes/raft.md" } }).then(value => { completed = true; return value; });
    // Give a call that did not wait every chance to finish first (#4325 F16).
    await Bun.sleep(50);
    expect(completed, "READ_CANNOT_COMPLETE_BEFORE_SANDBOX_READY").toBe(false);
    gate.resolve();
    expect(await early).toEqual(result);
    expect(await client.callTool({ name: "brain_read", arguments: { path: "notes/raft.md" } })).toEqual(result);
    expect(starts, "EXACTLY_ONE_FORWARDING_PROCESS").toBe(1);
    expect(errors).toEqual([]);
  } finally { gate.resolve(); await client.close(); await forward.close(); await stdio.close(); }
  expect(closes).toBe(1);
});

test("a failed forwarding process returns a named tool error without disabling the bridge", async () => {
  const errors: unknown[] = [];
  const forward = createBrainToolForwarder(async () => { throw new Error("Odysseus cannot start the sandbox."); },
    new AbortController().signal, error => errors.push(error));
  forward.server.instance.registerTool("raft_status", { description: "The host's own status." }, async () => ({ content: [{ type: "text", text: "Athena can still answer." }] }));
  const client = await connect(forward.server.instance);
  try {
    expect(await client.callTool({ name: "brain_read", arguments: { path: "notes/raft.md" } })).toEqual({ isError: true,
      content: [{ type: "text", text: "brain_tool_unavailable: the sandboxed brain server could not complete this call. Other tools remain available." }] });
    expect(await client.callTool({ name: "raft_status", arguments: {} })).toEqual({ content: [{ type: "text", text: "Athena can still answer." }] });
    expect(errors.map(String)).toContain("Error: Odysseus cannot start the sandbox.");
  } finally { await client.close(); await forward.close(); }
});

test("a readiness timeout returns a named error and a later ready call recovers", async () => {
  const gate = Promise.withResolvers<void>();
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = new McpServer({ name: "brain", version: "1" });
  stdio.registerTool("brain_read", brainReadDefinitions().brain_read, async () => ({ content: [{ type: "text", text: "Odysseus can read again." }] }));
  await stdio.connect(serverTransport);
  // Exercise the actual product timer with a short test configuration. The test
  // awaits its error, never races a sleep or asserts a scheduler-dependent time.
  const forward = createBrainToolForwarder(async () => { await gate.promise; return { transport, async close() { await transport.close(); } }; },
    new AbortController().signal, () => {}, 10);
  const client = await connect(forward.server.instance);
  try {
    const timedOut = await client.callTool({ name: "brain_read", arguments: { path: "notes/raft.md" } });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.content).toEqual([{ type: "text", text: "brain_tool_timeout: the sandboxed brain server could not complete this call. Other tools remain available." }]);
    gate.resolve();
    expect(await client.callTool({ name: "brain_read", arguments: { path: "notes/raft.md" } })).toEqual({ content: [{ type: "text", text: "Odysseus can read again." }] });
  } finally { gate.resolve(); await client.close(); await forward.close(); await stdio.close(); }
});

test("native settings that re-enable the project brain process withhold only that prompt", async () => {
  const { promptGateCheck } = await import("../src/turn-prompt-gate.js");
  for (const disabled of [undefined, [], ["brain"]]) {
    const terminal = { refused: undefined as unknown, withhold: () => false };
    const query = { getSettings: async () => ({ effective: { env: { ENABLE_TOOL_SEARCH: "true" }, disabledMcpjsonServers: disabled } }) };
    const check = promptGateCheck({ queryHandle: Promise.resolve(query) as never,
      initialize: async () => ({ account: {} }) as never, sdkTurn: { subscriptionOnly: false, pinnedSettingsEnv: { ENABLE_TOOL_SEARCH: "true" },
        options: { mcpServers: { brain: { type: "sdk" } } } as never },
      relay: undefined, terminal: terminal as never, runtimeRequirements: [], phase: "fixture", abortController: new AbortController(),
      profileId: "fixture", log() {}, reportActivity() {}, reportRuntime() {} });
    expect(await check(), "ONLY_THE_QUALIFIED_BRAIN_PROCESS_SELECTION_RELEASES_INPUT").toBe(disabled?.includes("brain") === true);
    expect(terminal.refused).toEqual(disabled?.includes("brain") ? undefined : expect.objectContaining({
      failure: expect.objectContaining({ errorClass: "settings_conflict" }),
      message: expect.stringContaining("project brain stdio entry is not disabled"),
    }));
  }
});
