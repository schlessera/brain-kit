/** Offline project MCP fixture: real unhosted legacy tool membership. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "odysseus-legacy", version: "1" });
for (const name of ["brain_add", "brain_update", "brain_archive"]) server.registerTool(name, {
  description: `Odysseus legacy ${name}`, inputSchema: z.object({}), _meta: { "anthropic/alwaysLoad": true },
}, async () => ({ content: [{ type: "text", text: "LEGACY_HANDLER_EXECUTED" }] }));
await server.connect(new StdioServerTransport());
