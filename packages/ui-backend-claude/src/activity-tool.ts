import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  QUERY_ACTIVITY_DESCRIPTION,
  QUERY_ACTIVITY_INPUT_SCHEMA,
  QUERY_ACTIVITY_TOOL_NAME as SHARED_TOOL_NAME,
  handleQueryActivity,
  type ActivityQuery,
  type ActivityQueryResult,
  type BackendBridge,
} from "@schlessera/brain-ui-sdk/server";
import { BRIDGE_TOOL_POSTURE } from "@schlessera/brain-ui-sdk/internal";

export type ActivityQueryHandler = (
  query: ActivityQuery
) => Promise<ActivityQueryResult>;

export function createActivityQueryTool(handler: ActivityQueryHandler) {
  return tool(
    SHARED_TOOL_NAME,
    QUERY_ACTIVITY_DESCRIPTION,
    QUERY_ACTIVITY_INPUT_SCHEMA.shape,
    async (input) => {
      try {
        const parsed = QUERY_ACTIVITY_INPUT_SCHEMA.parse(input);
        const text = await handleQueryActivity(
          parsed,
          { queryActivity: handler } as BackendBridge
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "query_activity failed",
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { QUERY_ACTIVITY_DESCRIPTION, QUERY_ACTIVITY_INPUT_SCHEMA };

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const QUERY_ACTIVITY_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
