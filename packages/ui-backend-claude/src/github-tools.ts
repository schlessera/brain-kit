import type { z } from "zod";
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { GITHUB_READ_TOOL_CONTRACTS, handleGithubTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/**
 * The host GitHub read tools (#3797), forwarded to the host, which binds the
 * turn and holds the dedicated credential. Registered as full strict objects
 * (the SDK's raw-shape helper strips extra keys). A missing host handler or
 * credential is an executable refusal, never a schema removal, so the roster
 * stays fixed whatever the host's configuration.
 */
export function registerGithubTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "github">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  for (const contract of GITHUB_READ_TOOL_CONTRACTS) {
    // One definition feeds both the observed roster and the registration.
    const definition = { description: contract.description, inputSchema: contract.input, _meta: { "anthropic/alwaysLoad": true } };
    observe?.(contract.name, definition.description, definition.inputSchema);
    server.registerTool(contract.name, definition, async (input: unknown) => {
      try {
        const result = await handleGithubTool(contract.name, input, bridge);
        return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The GitHub read failed." }] };
      }
    });
  }
}
