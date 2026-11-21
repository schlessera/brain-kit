/** Real core MCP registrations; the marker emulates metadata before #4306. */
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpServer } from "../../../core/src/mcp-server.js";
const register = McpServer.prototype.registerTool;
if (existsSync(process.argv[2]!)) McpServer.prototype.registerTool = function(this: McpServer, name: string, config: any, handler: any) {
  const { _meta: _old, ...legacy } = config;
  return register.call(this, name, legacy, handler);
} as typeof register;
// A controlled slow project-MCP startup: release on the first model request,
// proving the non-blocking production race without a fixed startup delay.
if (process.argv[3]) while (!existsSync(process.argv[3]!)) await Bun.sleep(10);
await startMcpServer();
