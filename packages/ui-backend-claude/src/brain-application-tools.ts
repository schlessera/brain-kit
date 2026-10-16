import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { brainApplicationInput, brainReadBaseInput, brainReadBaseResult, BRAIN_APPLICATION_TOOLS, BRAIN_APPLICATION_DESCRIPTIONS,
  BRAIN_READ_BASE_DESCRIPTION, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

/** Register full strict objects: the SDK's raw-shape helper strips extra keys. */
export function registerBrainApplicationTools(
  server: ReturnType<typeof createSdkMcpServer>["instance"],
  bridge: Pick<BackendBridge, "applyBrain" | "readBrainBase">,
  stableRoster = false,
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
  if (stableRoster || bridge.readBrainBase) server.registerTool("brain_read_base", {
    description: BRAIN_READ_BASE_DESCRIPTION,
    inputSchema: brainReadBaseInput,
    _meta: { "anthropic/alwaysLoad": true },
  }, async ({ path, ...range }) => {
    // The bridge returns the whole document and its server hash; only the
    // agent-facing result is paged, so no result outgrows the MCP budget.
    if (!bridge.readBrainBase) return { isError: true, content: [{ type: "text" as const, text: "No server document-base reader is available." }] };
    try { return { content: [{ type: "text" as const, text: JSON.stringify(brainReadBaseResult(await bridge.readBrainBase!(path), range)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Read failed." }] }; }
  });
}
