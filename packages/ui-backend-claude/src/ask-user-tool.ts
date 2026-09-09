import {
  tool,
  createSdkMcpServer,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk";
import {
  ASK_USER_DESCRIPTION,
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_TOOL_NAME as SHARED_TOOL_NAME,
  BRIDGE_TOOL_POSTURE,
  handleAskUser,
  type AskUserResult,
  type BackendBridge,
} from "@schlessera/brain-ui-sdk/server";
import { createLocationTool, type LocationHandler } from "./location-tool.js";
import { createActivityQueryTool, type ActivityQueryHandler } from "./activity-tool.js";
import { createMaskTool, type MaskHandler } from "./mask-tool.js";

/**
 * Bridge for the built-in `AskUserQuestion` tool.
 *
 * The Claude Agent SDK's built-in AskUserQuestion is executed inside the
 * spawned `claude` CLI binary, which needs a TTY to render its picker. This
 * backend runs the CLI headless, so the built-in hangs. We disable it via
 * `disallowedTools` and expose this in-process MCP tool with an equivalent
 * schema instead. Claude calls `mcp__brain-ui__ask_user`; the handler routes
 * the request over the host bridge (`BackendBridge.askUser`) and awaits the
 * user's answer.
 *
 * Schema mirrors AskUserQuestionInput / AskUserQuestionOutput from
 * @anthropic-ai/claude-agent-sdk/sdk-tools.d.ts.
 */

/** Bridges the tool to the host's ask-user provider (`BackendBridge.askUser`). */
export type AskUserHandler = (
  requestId: string,
  questions: AskUserQuestion[]
) => Promise<AskUserResult>;

/** MCP server name; its tools surface to Claude as `mcp__brain-ui__*`. */
const MCP_SERVER_NAME = "brain-ui";

export function createAskUserTool(handler: AskUserHandler) {
  return tool(
    SHARED_TOOL_NAME,
    ASK_USER_DESCRIPTION,
    ASK_USER_INPUT_SCHEMA.shape,
    async (input) => {
      // The request id is minted here and handed to the bridge so the host can
      // correlate the eventual client response.
      const requestId = crypto.randomUUID();
      try {
        const parsed = ASK_USER_INPUT_SCHEMA.parse(input);
        const payload = await handleAskUser(
          parsed,
          { askUser: handler } as BackendBridge,
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
              text: err instanceof Error ? err.message : "ask_user failed",
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { ASK_USER_DESCRIPTION, ASK_USER_INPUT_SCHEMA };

/**
 * The in-process MCP server for this backend's own tools. Registered under the
 * `brain-ui` name, so its tools are exposed to Claude as `mcp__brain-ui__*`.
 * Tools are registered only when the host supplies the matching handler.
 */
export function createBrainUiMcpServer(handlers: {
  askUser?: AskUserHandler;
  getLocation?: LocationHandler;
  requestMask?: MaskHandler;
  queryActivity?: ActivityQueryHandler;
  /** Required alongside requestMask: the mask is written into this repo. */
  brainPath?: string;
}) {
  const tools: SdkMcpToolDefinition<any>[] = [];
  if (handlers.getLocation) tools.push(createLocationTool(handlers.getLocation));
  if (handlers.askUser) tools.push(createAskUserTool(handlers.askUser));
  if (handlers.requestMask && handlers.brainPath) {
    tools.push(createMaskTool(handlers.requestMask, handlers.brainPath));
  }
  if (handlers.queryActivity) {
    tools.push(createActivityQueryTool(handlers.queryActivity));
  }
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools,
  });
}

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const ASK_USER_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
