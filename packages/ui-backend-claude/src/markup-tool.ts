import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  BRIDGE_TOOL_POSTURE,
  REQUEST_IMAGE_MARKUP_DESCRIPTION,
  REQUEST_IMAGE_MARKUP_INPUT_SCHEMA,
  REQUEST_IMAGE_MARKUP_TOOL_NAME as SHARED_TOOL_NAME,
  handleRequestImageMarkup,
  type BackendBridge,
} from "@schlessera/brain-ui-sdk/server";

/** The host's markup operation (`BackendBridge.requestImageMarkup`, #3975). */
export type MarkupHandler = NonNullable<BackendBridge["requestImageMarkup"]>;

/**
 * `request_image_markup`: the host opens the editor, takes the layer and
 * writes it; this tool only relays the input and the receipt.
 */
export function createMarkupTool(handler: MarkupHandler) {
  return tool(
    SHARED_TOOL_NAME,
    REQUEST_IMAGE_MARKUP_DESCRIPTION,
    REQUEST_IMAGE_MARKUP_INPUT_SCHEMA.shape,
    async (input) => {
      try {
        const payload = await handleRequestImageMarkup(REQUEST_IMAGE_MARKUP_INPUT_SCHEMA.parse(input), { requestImageMarkup: handler });
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    }
  );
}

export const MARKUP_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(SHARED_TOOL_NAME, "claude");
