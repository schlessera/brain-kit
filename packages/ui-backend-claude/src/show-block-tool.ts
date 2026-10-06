import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_INPUT_SCHEMA,
  SHOW_BLOCK_TOOL_NAME as SHARED_TOOL_NAME,
  handleShowBlock,
} from "@schlessera/brain-ui-sdk/server";
import { BRIDGE_TOOL_POSTURE } from "@schlessera/brain-ui-sdk/internal";

/**
 * `show_block` needs no handler from the host: the block is data the model
 * authored and the surface draws it. The tool validates the argument and
 * echoes it as the payload the client renders, so a call that fits the
 * schema is exactly what appears in the answer.
 */
export function createShowBlockTool() {
  return tool(
    SHARED_TOOL_NAME,
    SHOW_BLOCK_DESCRIPTION,
    SHOW_BLOCK_INPUT_SCHEMA.shape,
    async (input) => {
      try {
        const payload = handleShowBlock(SHOW_BLOCK_INPUT_SCHEMA.parse(input));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "show_block failed",
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { SHOW_BLOCK_DESCRIPTION, SHOW_BLOCK_INPUT_SCHEMA };

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const SHOW_BLOCK_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
