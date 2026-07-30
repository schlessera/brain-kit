import type { CoreCommand } from "../types";
import { UsageError } from "../io";

export const mcpCommand: CoreCommand = {
  summary: "Start the stdio MCP server",
  helpBlock: `brain mcp — start the stdio MCP server

This command communicates over stdin/stdout and is intended for MCP clients.`,
  async run(args) {
    if (args.length > 0) {
      throw new UsageError("brain mcp does not accept arguments");
    }
    const { startMcpServer } = await import("../../mcp-server");
    await startMcpServer();
    await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  },
};
