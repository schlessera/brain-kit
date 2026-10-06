import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  REQUEST_IMAGE_MASK_DESCRIPTION,
  REQUEST_IMAGE_MASK_INPUT_SCHEMA,
  REQUEST_IMAGE_MASK_TOOL_NAME as SHARED_TOOL_NAME,
  handleRequestImageMask,
  type BackendBridge,
} from "@schlessera/brain-ui-sdk/server";
import {
  BRIDGE_TOOL_POSTURE,
  claudeMaskFilename,
  claudeReportedMaskPath,
} from "@schlessera/brain-ui-sdk/internal";

/** Bridges the tool to the host's mask provider (`BackendBridge.requestMask`). */
export type MaskHandler = (
  imagePath: string,
  instruction?: string
) => Promise<Uint8Array>;

export function createMaskTool(handler: MaskHandler, brainPath: string) {
  return tool(
    SHARED_TOOL_NAME,
    REQUEST_IMAGE_MASK_DESCRIPTION,
    REQUEST_IMAGE_MASK_INPUT_SCHEMA.shape,
    async (input) => {
      try {
        const parsed = REQUEST_IMAGE_MASK_INPUT_SCHEMA.parse(input);
        const payload = await handleRequestImageMask(
          parsed,
          { requestMask: handler } as BackendBridge,
          {
            brainPath,
            maskFilename: claudeMaskFilename,
            reportMaskPath: claudeReportedMaskPath,
          }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: (err as Error).message,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { REQUEST_IMAGE_MASK_DESCRIPTION, REQUEST_IMAGE_MASK_INPUT_SCHEMA };

export const MASK_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
