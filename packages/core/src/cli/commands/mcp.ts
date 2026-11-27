import { timeMcpStartup } from "../mcp-startup-timing.js";
import type { CoreCommand } from "../types.js";
import { UsageError } from "../io.js";

export const mcpCommand: CoreCommand = {
  summary: "Start the stdio MCP server",
  flags: { boolean: [], value: [] },
  helpBlock: `brain mcp — start the stdio MCP server

This command communicates over stdin/stdout and is intended for MCP clients.`,
  async run(args, cli) {
    if (args.length > 0) {
      throw new UsageError("brain mcp does not accept arguments");
    }
    const imported = timeMcpStartup("import");
    const { startMcpServer } = await import("../../mcp-server.js");
    imported();
    await startMcpServer(cli.brain, cli.configError);
    await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  },
};
