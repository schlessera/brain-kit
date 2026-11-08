/**
 * Claude's host-executed compute tools (#3108) through the real in-process MCP
 * server: a forged caller field refuses instead of being stripped, the parsed
 * input and the model's tool_use id reach the host, and a turn without a host
 * handler refuses while the tool stays registered.
 */
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ComputeToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createBrainUiMcpServer } from "../src/ask-user-tool.js";

async function connect(compute?: (call: ComputeToolCall) => Promise<{ ok: true }>) {
  const server = createBrainUiMcpServer({ stableRoster: true, compute: compute ? { compute } : {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "compute", version: "1" });
  await (server as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("a forged caller field refuses before the host; a valid call carries only input and tool_use id", async () => {
  const calls: ComputeToolCall[] = [];
  const client = await connect(async call => { calls.push(call); return { ok: true }; });
  try {
    const forged = await client.callTool({ name: "brain_compute_run", arguments: { provider: "boat-small", argv: ["true"], principal: "penelope" },
      _meta: { "claudecode/toolUseId": "toolu_forged" } });
    expect(forged.isError, "CLAUDE_FORGED_FIELD_REFUSED").toBe(true);
    expect(calls, "CLAUDE_FORGED_FIELD_NEVER_REACHES_HOST").toEqual([]);
    const valid = await client.callTool({ name: "brain_compute_status", arguments: { job: "cj_ithaca" }, _meta: { "claudecode/toolUseId": "toolu_ithaca" } });
    expect(valid.isError).toBeFalsy();
    expect(calls, "CLAUDE_HOST_RECEIVES_PARSED_INPUT").toEqual([{ tool: "brain_compute_status", input: { job: "cj_ithaca" }, toolUseId: "toolu_ithaca" }]);
  } finally { await client.close(); }
});

test("without a host handler the tools stay registered and refuse", async () => {
  const client = await connect();
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["brain_compute_health", "brain_compute_run", "brain_compute_collect"]));
    const refused = await client.callTool({ name: "brain_compute_run", arguments: { provider: "boat-small", argv: ["true"] } });
    expect(refused.isError, "CLAUDE_NO_HANDLER_REFUSES").toBe(true);
    expect(JSON.stringify(refused.content)).toContain("compute_disabled");
  } finally { await client.close(); }
});
