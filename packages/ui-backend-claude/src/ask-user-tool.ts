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
import { createShowBlockTool } from "./show-block-tool.js";

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
 * Tools are registered only when the host supplies the matching handler;
 * `show_block` needs none, so it is always registered.
 */
export function createBrainUiMcpServer(handlers: {
  askUser?: AskUserHandler;
  getLocation?: LocationHandler;
  requestMask?: MaskHandler;
  queryActivity?: ActivityQueryHandler;
  /** Required alongside requestMask: the mask is written into this repo. */
  brainPath?: string;
}) {
  const tools: SdkMcpToolDefinition<any>[] = [createShowBlockTool()];
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
    // D44. The SDK defers an MCP server's tools behind tool search unless this
    // is set, and a deferred tool is not in the model's context at all until
    // the model decides to go looking for it. Measured over 108 live turns:
    // `show_block` fired on 56% of turns deferred against 78% loaded, and on
    // none at all when the brief that names it was removed — the deferral made
    // a prompt line load-bearing for whether a tool existed. The schemas cost
    // 7335 input tokens per round-trip against 93 deferred, which sounds
    // decisive and is not: the deferred path spends a `ToolSearch` round-trip
    // instead, and that costs more than the schemas save. Like for like the
    // bill rose 6%. Nothing here blocks startup — the SDK's connect-timeout
    // caveat is on the stdio/HTTP/SSE server configs, and an in-process server
    // has nothing to connect to.
    alwaysLoad: true,
  });
}

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const ASK_USER_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
