import type { z } from "zod";
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { READ_ATTACHMENT_CONTRACT, handleReadAttachment, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/**
 * `read_attachment` (#3154), forwarded to the host, which binds the calling
 * session, principal and turn, re-checks the reference and digest and
 * enforces every bound. Registered as the full strict object (the SDK's
 * raw-shape helper strips extra keys). A missing host handler is an
 * executable refusal, never a schema removal, so an upload never changes the
 * roster.
 */
export function registerReadAttachmentTool(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "readAttachment">,
  observe?: (name: string, description: string, schema: z.ZodObject) => void) {
  const contract = READ_ATTACHMENT_CONTRACT;
  const definition = { description: contract.description, inputSchema: contract.input, _meta: { "anthropic/alwaysLoad": true } };
  observe?.(contract.name, definition.description, definition.inputSchema);
  server.registerTool(contract.name, definition, async (input: unknown) => {
    try {
      const result = await handleReadAttachment(input, bridge);
      return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The attachment read failed." }] };
    }
  });
}
