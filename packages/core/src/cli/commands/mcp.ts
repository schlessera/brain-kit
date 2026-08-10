import type { CoreCommand } from "../types.js";
import { UsageError } from "../io.js";

export const mcpCommand: CoreCommand = {
  summary: "Start the stdio MCP server",
  helpBlock: `brain mcp — start the stdio MCP server

This command communicates over stdin/stdout and is intended for MCP clients.`,
  async run(args, cli) {
    if (args.length > 0) {
      throw new UsageError("brain mcp does not accept arguments");
    }
    const { startMcpServer } = await import("../../mcp-server.js");
    await startMcpServer(cli.brain, cli.configError);
    await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  },
};
