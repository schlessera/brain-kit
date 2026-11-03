import type { z } from "zod";
import { tool, type createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { COMPUTE_TOOL_CONTRACTS, handleComputeTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { askRequestId } from "./tool-use-id.js";

/**
 * External compute (#3108), executed on the host: the turn's bridge binds
 * the caller, policy, approval and credentials. The in-worker brain MCP
 * server's `brain_compute_*` tools are disallowed, so these are the only path.
 */
export function createComputeTools(bridge: Pick<BackendBridge, "compute">) {
  return COMPUTE_TOOL_CONTRACTS.map(contract => tool(contract.name, contract.description, contract.input.shape, async (input, extra) => {
    try {
      const result = await handleComputeTool(contract.name, input, bridge, askRequestId(extra));
      return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "External compute refused" }] }; }
  }));
}

/**
 * Register full strict objects, as for the reference tools: the SDK's
 * raw-shape helper strips extra keys, and a forged caller field must refuse
 * rather than vanish. A missing host handler is an executable refusal, so
 * the roster stays fixed whatever the host configured.
 */
export function registerComputeTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "compute">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  const tools = createComputeTools(bridge);
  COMPUTE_TOOL_CONTRACTS.forEach((contract, index) => {
    const definition = { description: contract.description, inputSchema: contract.input, _meta: { "anthropic/alwaysLoad": true } };
    observe?.(contract.name, definition.description, definition.inputSchema);
    server.registerTool(contract.name, definition, tools[index]!.handler);
  });
}
