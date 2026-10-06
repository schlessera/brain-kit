import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserListSpec } from "@schlessera/brain-ui-sdk";
import {
  ASK_USER_LIST_DESCRIPTION,
  ASK_USER_LIST_INPUT_SCHEMA,
  ASK_USER_LIST_TOOL_NAME as SHARED_TOOL_NAME,
  type AskUserListResult,
  type BackendBridge,
} from "@schlessera/brain-ui-sdk/server";
import { BRIDGE_TOOL_POSTURE, handleAskUserList } from "@schlessera/brain-ui-sdk/internal";
import { askRequestId } from "./tool-use-id.js";

/** Bridges the tool to the host's list provider (`BackendBridge.askUserList`). */
export type AskUserListHandler = (
  requestId: string,
  request: AskUserListSpec
) => Promise<AskUserListResult>;

/**
 * `ask_user_list`: one scale applied to a list of items, answered in one card
 * (#583). Routed like `ask_user` — the request id is the tool_use id (`askRequestId`), the host
 * bridge carries the card to the client, and the tool resolves when the user
 * submits. A dismissal rejects, and the model reads it as a tool error.
 */
export function createAskUserListTool(handler: AskUserListHandler) {
  return tool(
    SHARED_TOOL_NAME,
    ASK_USER_LIST_DESCRIPTION,
    ASK_USER_LIST_INPUT_SCHEMA.shape,
    async (input, extra) => {
      const requestId = askRequestId(extra);
      try {
        const parsed = ASK_USER_LIST_INPUT_SCHEMA.parse(input);
        const payload = await handleAskUserList(
          parsed,
          { askUserList: handler } as BackendBridge,
          requestId
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "ask_user_list failed",
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { ASK_USER_LIST_DESCRIPTION, ASK_USER_LIST_INPUT_SCHEMA };

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const ASK_USER_LIST_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
