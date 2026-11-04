import type { z } from "zod";
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { APIFY_TOOL_CONTRACTS, handleApifyTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/**
 * The ten fixed Apify operations (#3162), forwarded to the host, which binds
 * principal, session, turn and approvals and holds the credential. Registered
 * as full strict objects (the SDK's raw-shape helper strips extra keys). A
 * missing host handler is an executable refusal, never a schema removal, so
 * the roster stays fixed; choosing an Actor never changes it.
 */
export function registerApifyTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "apify">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  for (const contract of APIFY_TOOL_CONTRACTS) {
    // One definition feeds both the observed roster and the registration.
    const definition = { description: contract.description, inputSchema: contract.input, _meta: { "anthropic/alwaysLoad": true } };
    observe?.(contract.name, definition.description, definition.inputSchema);
    server.registerTool(contract.name, definition, async (input: unknown) => {
      try {
        const result = await handleApifyTool(contract.name, input, bridge);
        return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The Apify operation failed." }] };
      }
    });
  }
}
