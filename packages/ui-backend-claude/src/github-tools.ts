import type { z } from "zod";
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { GITHUB_TOOL_CONTRACTS, handleGithubTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/**
 * The host GitHub tools, reads (#3797) and writes (#3798), forwarded to the
 * host, which binds the turn, holds the dedicated credential, checks a
 * write's repository against the policy allow-list and shows its approval
 * card. Registered as full strict objects (the SDK's raw-shape helper strips
 * extra keys), all four in the contract's fixed order. A missing host
 * handler, credential, policy entry or grant surface is an executable
 * refusal, never a schema removal, so the roster stays fixed whatever the
 * host's configuration or the turn's posture.
 */
export function registerGithubTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "github">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  for (const contract of GITHUB_TOOL_CONTRACTS) {
    // One definition feeds both the observed roster and the registration.
    const definition = { description: contract.description, inputSchema: contract.input, _meta: { "anthropic/alwaysLoad": true } };
    observe?.(contract.name, definition.description, definition.inputSchema);
    server.registerTool(contract.name, definition, async (input: unknown) => {
      try {
        const result = await handleGithubTool(contract.name, input, bridge);
        return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The GitHub tool failed." }] };
      }
    });
  }
}
