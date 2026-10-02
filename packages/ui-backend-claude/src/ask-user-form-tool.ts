import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserFormSpec } from "@schlessera/brain-ui-sdk";
import {
  ASK_USER_FORM_DESCRIPTION,
  ASK_USER_FORM_INPUT_SCHEMA,
  ASK_USER_FORM_TOOL_NAME as SHARED_TOOL_NAME,
  BRIDGE_TOOL_POSTURE,
  handleAskUserForm,
  type AskUserFormResult,
  type BackendBridge,
  type AskUserFormLimits,
} from "@schlessera/brain-ui-sdk/server";

/** Bridges the tool to the host's ranking provider (`BackendBridge.askUserForm`). */
export type AskUserFormHandler = (
  requestId: string,
  request: AskUserFormSpec,
) => Promise<AskUserFormResult>;

/**
 * `ask_user_form`: conditional questions, answered in one card
 * (#585). Routed like `ask_user` — the request id is minted here, the host
 * bridge carries the card to the client, and the tool resolves when the user
 * submits. A dismissal rejects, and the model reads it as a tool error.
 */
export function createAskUserFormTool(
  handler: AskUserFormHandler,
  limits?: AskUserFormLimits,
) {
  return tool(
    SHARED_TOOL_NAME,
    ASK_USER_FORM_DESCRIPTION,
    ASK_USER_FORM_INPUT_SCHEMA.shape,
    async (input) => {
      const requestId = crypto.randomUUID();
      try {
        const parsed = ASK_USER_FORM_INPUT_SCHEMA.parse(input);
        const payload = await handleAskUserForm(
          parsed,
          { askUserForm: handler, askUserFormLimits: limits } as BackendBridge,
          requestId,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "ask_user_form failed",
            },
          ],
          isError: true,
        };
      }
    },
  );
}

export { ASK_USER_FORM_DESCRIPTION, ASK_USER_FORM_INPUT_SCHEMA };

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const ASK_USER_FORM_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude",
);
