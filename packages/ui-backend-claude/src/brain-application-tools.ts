import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { brainApplicationInput, BRAIN_APPLICATION_TOOLS, BRAIN_APPLICATION_DESCRIPTIONS, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/** Register full strict objects: the SDK's raw-shape helper strips extra keys. */
export function registerBrainApplicationTools(
  server: ReturnType<typeof createSdkMcpServer>["instance"],
  bridge: Pick<BackendBridge, "applyBrain" | "readBrainBase">,
): void {
  for (const schema of brainApplicationInput.options) {
    const operation = schema.shape.operation.value;
    server.registerTool(BRAIN_APPLICATION_TOOLS[operation], {
      description: BRAIN_APPLICATION_DESCRIPTIONS[operation],
      inputSchema: (schema as z.ZodObject).omit({ operation: true }),
      _meta: { "anthropic/alwaysLoad": true },
    }, async input => {
      if (!bridge.applyBrain) return { isError: true, content: [{ type: "text" as const, text: "No server application route is available." }] };
      const result = await bridge.applyBrain({ ...input, operation } as Parameters<NonNullable<BackendBridge["applyBrain"]>>[0]);
      return { isError: !result.ok, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }
  if (bridge.readBrainBase) server.registerTool("brain_read_base", {
    description: "Read a Markdown document and its exact SHA-256 base for a hosted edit.",
    inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
    _meta: { "anthropic/alwaysLoad": true },
  }, async ({ path }) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await bridge.readBrainBase!(path)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Read failed." }] }; }
  });
}
