// `request_image_markup` on Claude (#3975): the in-process tool relays the
// input to the host's operation and its receipt back, and states a refusal.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createBrainUiMcpServer } from "../src/ask-user-tool.js";
import { MARKUP_TOOL_NAME } from "../src/markup-tool.js";

const input = { imagePath: "photos/raft-at-ithaca.jpg", instruction: "mark what should move and where" };
const receipt = { imagePath: input.imagePath, markupPath: ".brain/scratch/markup/raft-at-ithaca.3f9a1c2e.markup.png", width: 3024, height: 4032,
  bytes: 2048, marks: { pen: 0, arrow: 2, ellipse: 1, text: 1 }, notes: ["move the raft here"], note: "Pass this layer to brain image --markup." };

async function call(handlers: Parameters<typeof createBrainUiMcpServer>[0], args: Record<string, unknown> = input) {
  const server = createBrainUiMcpServer(handlers);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "markup", version: "1" });
  await (server as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(serverSide);
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    const result = await client.callTool({ name: "request_image_markup", arguments: args });
    return { names, result: result as { content: { text: string }[]; isError?: boolean } };
  } finally { await client.close(); }
}

test("the tool relays the input to the host's operation and returns its receipt", async () => {
  expect(MARKUP_TOOL_NAME).toBe("mcp__brain-ui__request_image_markup");
  const asked: unknown[] = [];
  const { names, result } = await call({ requestImageMarkup: async request => { asked.push(request); return receipt; } });
  expect(names).toContain("request_image_markup");
  expect(asked).toEqual([input]);
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0]!.text)).toEqual(receipt);
});

test("a refusal is a tool error in the host's own words", async () => {
  const { result } = await call({ requestImageMarkup: async () => { throw new Error("The user closed the markup editor"); } });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe("The user closed the markup editor");
});

test("the stable roster registers it without a handler, and calling it refuses", async () => {
  const { names, result } = await call({ stableRoster: true });
  expect(names).toContain("request_image_markup");
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe("This tool has no available host handler in this turn.");
});

test("an over-long instruction is refused before the host is asked", async () => {
  const asked: unknown[] = [];
  const { result } = await call({ requestImageMarkup: async request => { asked.push(request); return receipt; } }, { ...input, instruction: "x".repeat(201) });
  expect(result.isError).toBe(true);
  expect(asked).toEqual([]);
});
