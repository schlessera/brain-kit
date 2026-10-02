/** Keyless estimates of the actual always-loaded bridge schemas; never executes a tool. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainUiMcpServer } from "../packages/ui-backend-claude/src/ask-user-tool.js";
import {
  BRIDGE_TOOL_CONTRACTS,
  toolBriefLines,
  visibleToolName,
} from "../packages/ui-sdk/src/tool-contracts/index.js";

const unreachable = () =>
  Promise.reject(new Error("Measurement never executes tools"));
const server = createBrainUiMcpServer({
  askUser: unreachable,
  askUserList: unreachable,
  askUserRank: unreachable,
  askUserForm: unreachable,
  getLocation: unreachable,
  requestMask: unreachable,
  queryActivity: unreachable,
  brainPath: "/nonexistent",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "form-schema-cost", version: "0.1.0" }, {});
try {
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = (await client.listTools()).tools;
  if (
    listed.length !== BRIDGE_TOOL_CONTRACTS.length ||
    listed.some((tool) => tool._meta?.["anthropic/alwaysLoad"] !== true)
  )
    throw new Error("Measurement requires the complete always-loaded roster");
  const definitions = listed.map((tool) => ({
    name: visibleToolName(tool.name, "claude"),
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  const chars = (value: unknown) => JSON.stringify(value).length;
  const allChars = chars(definitions);
  const briefs = toolBriefLines(BRIDGE_TOOL_CONTRACTS, (contract) =>
    visibleToolName(contract.name, "claude"),
  ).join("\n");
  console.log(
    JSON.stringify(
      {
        method:
          "Actual MCP-listed schemas serialized as Anthropic tool definitions. Tokens are ceil(characters/4) estimates, not count_tokens or model measurements.",
        rows: definitions.map((definition) => ({
          name: definition.name,
          characters: chars(definition),
          estimatedTokens: Math.ceil(chars(definition) / 4),
        })),
        combined: {
          definitions: definitions.length,
          characters: allChars,
          estimatedTokens: Math.ceil(allChars / 4),
        },
        briefs: {
          characters: briefs.length,
          estimatedTokens: Math.ceil(briefs.length / 4),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await server.instance.close();
}
