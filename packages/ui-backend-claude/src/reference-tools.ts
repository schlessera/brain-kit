import type { z } from "zod";
import { tool, type createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { REFERENCE_TOOL_CONTRACTS, handleReferenceTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/** Shared reference source and managed worktrees (#2432); the host binds principal, turn and generation. */
export function createReferenceTools(bridge: Pick<BackendBridge, "referenceAccess">) {
  return REFERENCE_TOOL_CONTRACTS.map(contract => tool(contract.name, contract.description, contract.input.shape, async input => {
    try {
      const result = await handleReferenceTool(contract.name, input, bridge);
      return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Reference tool refused" }] }; }
  }));
}

/**
 * Register full strict objects: the SDK's raw-shape helper strips extra keys.
 * A missing host handler is an executable refusal, never a schema removal, so
 * the roster stays fixed.
 */
export function registerReferenceTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "referenceAccess">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  const tools = createReferenceTools(bridge);
  REFERENCE_TOOL_CONTRACTS.forEach((contract, index) => {
    // One definition feeds both the observed roster and the registration.
    const definition = { description: contract.description, inputSchema: contract.input, _meta: { "anthropic/alwaysLoad": true } };
    observe?.(contract.name, definition.description, definition.inputSchema);
    server.registerTool(contract.name, definition, tools[index]!.handler);
  });
}
