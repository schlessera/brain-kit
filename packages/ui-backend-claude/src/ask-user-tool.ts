import {
  tool,
  createSdkMcpServer,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
// The SDK uses zod v4 internally, so schema types line up with the SDK's
// `AnyZodRawShape` from a plain `zod` import.
import { z } from "zod";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk";
import type { AskUserResult } from "@schlessera/brain-ui-sdk/server";
import { createLocationTool, type LocationHandler } from "./location-tool.js";
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

const optionSchema = z.object({
  label: z.string().describe("Display text for this option (1-5 words)."),
  description: z
    .string()
    .describe(
      "Explanation of what this option means or the implication of choosing it."
    ),
  preview: z
    .string()
    .optional()
    .describe(
      "Optional preview content rendered when this option is focused. Markdown — code blocks, ASCII mockups, comparison tables."
    ),
});

const questionSchema = z.object({
  question: z
    .string()
    .describe(
      "The complete question to ask. Specific, ends with a question mark. Phrase it for multi-select when applicable."
    ),
  header: z
    .string()
    .max(12)
    .describe('Short chip label, max 12 chars (e.g. "Library").'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe(
      'Choices for this question — 2 to 4 items. The user can always pick "Other" and provide free-text; do not include an Other option yourself.'
    ),
  multiSelect: z
    .boolean()
    .describe(
      "True if the user can pick several options. False for mutually exclusive choices."
    ),
});

export function createAskUserTool(handler: AskUserHandler) {
  return tool(
    "ask_user",
    [
      "Ask the user 1-4 multiple-choice questions when you need information you cannot reasonably infer.",
      "Use this BEFORE finalizing a plan or implementing an ambiguous request — it is the headless replacement for the AskUserQuestion built-in tool.",
      "Each question gets a short chip header, the full question text, and 2-4 mutually exclusive options (or non-exclusive when multiSelect=true). The UI auto-adds an Other option that lets the user supply free-text, so never include an Other option yourself.",
      "Prefer one focused question over many; only batch when the answers are genuinely independent. Do not use this for permission prompts — those go through the existing tool-approval flow.",
    ].join("\n"),
    { questions: z.array(questionSchema).min(1).max(4) },
    async (args) => {
      // The request id is minted here and handed to the bridge so the host can
      // correlate the eventual client response.
      const requestId = crypto.randomUUID();
      try {
        const response = await handler(
          requestId,
          args.questions as AskUserQuestion[]
        );
        // Mirror AskUserQuestionOutput shape so Claude sees a familiar
        // structure: questions array + answers map + optional annotations.
        const payload = {
          questions: args.questions,
          answers: response.answers,
          ...(response.annotations
            ? { annotations: response.annotations }
            : {}),
        };
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

/**
 * The in-process MCP server for this backend's own tools. Registered under the
 * `brain-ui` name, so its tools are exposed to Claude as `mcp__brain-ui__*`.
 * Tools are registered only when the host supplies the matching handler.
 */
export function createBrainUiMcpServer(handlers: {
  askUser?: AskUserHandler;
  getLocation?: LocationHandler;
  requestMask?: MaskHandler;
  /** Required alongside requestMask: the mask is written into this repo. */
  brainPath?: string;
}) {
  const tools: SdkMcpToolDefinition<any>[] = [];
  if (handlers.getLocation) tools.push(createLocationTool(handlers.getLocation));
  if (handlers.askUser) tools.push(createAskUserTool(handlers.askUser));
  if (handlers.requestMask && handlers.brainPath) {
    tools.push(createMaskTool(handlers.requestMask, handlers.brainPath));
  }
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools,
  });
}

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const ASK_USER_TOOL_NAME = "mcp__brain-ui__ask_user";
