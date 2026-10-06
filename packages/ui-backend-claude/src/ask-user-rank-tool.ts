import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserRankSpec } from "@schlessera/brain-ui-sdk";
import {
  ASK_USER_RANK_DESCRIPTION,
  ASK_USER_RANK_INPUT_SCHEMA,
  ASK_USER_RANK_TOOL_NAME as SHARED_TOOL_NAME,
  type AskUserRankResult,
  type BackendBridge,
} from "@schlessera/brain-ui-sdk/server";
import { BRIDGE_TOOL_POSTURE, handleAskUserRank } from "@schlessera/brain-ui-sdk/internal";
import { askRequestId } from "./tool-use-id.js";

/** Bridges the tool to the host's ranking provider (`BackendBridge.askUserRank`). */
export type AskUserRankHandler = (
  requestId: string,
  request: AskUserRankSpec
) => Promise<AskUserRankResult>;

/**
 * `ask_user_rank`: one order of preference over a list of items, answered in one card
 * (#584). Routed like `ask_user` — the request id is the tool_use id (`askRequestId`), the host
 * bridge carries the card to the client, and the tool resolves when the user
 * submits. A dismissal rejects, and the model reads it as a tool error.
 */
export function createAskUserRankTool(handler: AskUserRankHandler) {
  return tool(
    SHARED_TOOL_NAME,
    ASK_USER_RANK_DESCRIPTION,
    ASK_USER_RANK_INPUT_SCHEMA.shape,
    async (input, extra) => {
      const requestId = askRequestId(extra);
      try {
        const parsed = ASK_USER_RANK_INPUT_SCHEMA.parse(input);
        const payload = await handleAskUserRank(
          parsed,
          { askUserRank: handler } as BackendBridge,
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
              text: err instanceof Error ? err.message : "ask_user_rank failed",
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { ASK_USER_RANK_DESCRIPTION, ASK_USER_RANK_INPUT_SCHEMA };

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const ASK_USER_RANK_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
