import type { z } from "zod";
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { GOOGLE_TOOL_CONTRACTS, handleGoogleTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/**
 * The host Gmail tools (#4207), forwarded to the host, which binds the turn,
 * holds the Google credential, decides every call under the turn's frozen
 * policy and records the session's taint before a content view returns.
 * Registered as full strict objects (the SDK's raw-shape helper strips extra
 * keys), all six in the contract's fixed order and always loaded (D44). A
 * missing host handler, credential, policy block or connected account is an
 * executable refusal, never a schema removal, so the roster stays fixed
 * whatever the host's configuration or the turn's posture.
 */
export function registerGoogleTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "google">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  for (const contract of GOOGLE_TOOL_CONTRACTS) {
    // One definition feeds both the observed roster and the registration.
    const definition = { description: contract.description, inputSchema: contract.input as z.ZodObject, _meta: { "anthropic/alwaysLoad": true } };
    observe?.(contract.name, definition.description, definition.inputSchema);
    server.registerTool(contract.name, definition, async (input: unknown) => {
      try {
        const result = await handleGoogleTool(contract.name, input, bridge);
        return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The Gmail tool failed." }] };
      }
    });
  }
}
