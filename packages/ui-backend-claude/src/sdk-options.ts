import type {
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatImageAttachment,
  ClientEnvironment,
  StartTurnRequest,
} from "@schlessera/brain-ui-sdk/server";
import { buildSystemPromptAppend } from "@schlessera/brain-ui-sdk/server";

import { QUERY_ACTIVITY_TOOL_NAME } from "./activity-tool.js";
import { createBrainUiMcpServer, ASK_USER_TOOL_NAME } from "./ask-user-tool.js";
import { envSnapshot, resolveExecConfig } from "./config/env.js";
import { GET_LOCATION_TOOL_NAME } from "./location-tool.js";
import { MASK_TOOL_NAME } from "./mask-tool.js";
import { SHOW_BLOCK_TOOL_NAME } from "./show-block-tool.js";
import type { ClaudeBackendOptions } from "./options.js";
import type { InferenceProfile } from "./profiles.js";
import { createPermissionWiring } from "./permission-hooks.js";
import { createWrappedSpawn } from "./spawn-wrapper.js";
import type { TurnLockBinding } from "./turn-lock.js";

export interface ClaudeSdkTurn {
  options: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
}

export function createClaudeSdkTurn(options: {
  backend: ClaudeBackendOptions;
  req: StartTurnRequest;
  profile: InferenceProfile;
  abortController: AbortController;
  allowedTools: readonly string[];
  confirmPatterns: readonly RegExp[];
  turnLock: TurnLockBinding;
}): ClaudeSdkTurn {
  const { backend, req, profile, abortController, confirmPatterns, turnLock } = options;
  // Only wire ask-user / location tools when the host bridge offers them.
  const askUser = req.bridge.askUser;
  const getLocation = req.bridge.getLocation;
  const requestMask = req.bridge.requestMask;
  const queryActivity = req.bridge.queryActivity;
  const allowed = [...options.allowedTools];
  // Auto-allow the in-process MCP tools so they never trip a permission
  // prompt (ask-user is itself the question channel; location consent is
  // handled by the browser's geolocation prompt).
  if (askUser) allowed.push(ASK_USER_TOOL_NAME);
  if (getLocation) allowed.push(GET_LOCATION_TOOL_NAME);
  // Auto-allowed like the other bridge tools: the approval is the editor
  // itself — nothing happens unless the user paints and confirms.
  if (requestMask) allowed.push(MASK_TOOL_NAME);
  // Read-only over the host's own record — strictly narrower than the
  // file/tool access the model already has.
  if (queryActivity) allowed.push(QUERY_ACTIVITY_TOOL_NAME);
  // No side effect and no host handler: the block is part of the answer, and
  // an approval card for drawing a table would be the surface asking
  // permission to answer.
  allowed.push(SHOW_BLOCK_TOOL_NAME);

  const append = buildAppend(
    backend,
    req.client,
    {
      askUser: Boolean(askUser),
      location: Boolean(getLocation),
      mask: Boolean(requestMask),
      activity: Boolean(queryActivity),
      block: true,
    },
    req.turnBudgetMs
  );
  // One environment for everything this turn spawns: the profile's declared
  // credential names are part of the agent audience (config/env.ts), and the
  // rtk hook shells out before the SDK does, so both must see the same filtered
  // set rather than the server's own.
  const childEnv = { ...envSnapshot(profile.requiredEnvKeys), ...profile.buildEnv() };
  const sdkOptions: Options = {
    cwd: backend.brainPath,
    includePartialMessages: true,
    // Forward subagent text/thinking tagged with parent_tool_use_id so
    // drill-in views get full transcripts. The adapter keeps this OFF the
    // chat surface (activity side channel only) — a regression here degrades
    // gracefully to activity-only subagent visibility.
    forwardSubagentText: true,
    abortController,
    // Load CLAUDE.md and project skills from the brain repo.
    settingSources: ["project"],
    // The brain repo's CLAUDE.md says what the agent is working ON; this says
    // what it is rendering INTO. Appended to the preset rather than replacing
    // it, so tool discipline and safety text stay intact.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(append ? { append } : {}),
    },
    allowedTools: allowed,
    // The built-in AskUserQuestion picker needs a TTY; keep it disabled even
    // when no ask-user handler is present.
    disallowedTools: ["AskUserQuestion"],
    ...createPermissionWiring({
      req,
      allowedTools: allowed,
      confirmPatterns,
      brainPath: backend.brainPath,
      turnLock,
      childEnv,
    }),
  };

  if (profile.model !== undefined) sdkOptions.model = profile.model;
  if (backend.claudeCodePath !== undefined) {
    sdkOptions.pathToClaudeCodeExecutable = backend.claudeCodePath;
  }
  // Only when the host configured one: with no wrapper the SDK spawns exactly
  // as it always has, which is the path every existing deployment is on.
  const exec = resolveExecConfig();
  if (exec.wrapper !== undefined) {
    sdkOptions.spawnClaudeCodeProcess = createWrappedSpawn(exec);
  }
  if (req.sessionId !== undefined) sdkOptions.resume = req.sessionId;
  // The bridge tools are registered only when the bridge provides their
  // handler, each together with its allowlist entry; `show_block` needs no
  // handler, so the server itself is always present.
  sdkOptions.mcpServers = {
    "brain-ui": createBrainUiMcpServer({
      askUser,
      getLocation,
      requestMask,
      queryActivity,
      brainPath: backend.brainPath,
    }),
  };
  sdkOptions.env = childEnv;

  return {
    options: sdkOptions,
    prompt:
      req.attachments && req.attachments.length > 0
        ? buildAttachmentPrompt(req.prompt, req.attachments)
        : req.prompt,
  };
}

function buildAppend(
  options: ClaudeBackendOptions,
  client: ClientEnvironment | undefined,
  tools: {
    askUser: boolean;
    location: boolean;
    mask: boolean;
    activity: boolean;
    block: boolean;
  },
  turnBudgetMs: number | undefined
): string {
  // An explicit override is used verbatim; the default is rebuilt per turn so
  // it can describe the device the CURRENT message came from.
  return (
    options.systemPromptAppend ??
    buildSystemPromptAppend({
      ...(client ? { client } : {}),
      ...(turnBudgetMs ? { turnBudgetMs } : {}),
      tools: {
        askUser: tools.askUser && ASK_USER_TOOL_NAME,
        location: tools.location && GET_LOCATION_TOOL_NAME,
        mask: tools.mask && MASK_TOOL_NAME,
        activity: tools.activity && QUERY_ACTIVITY_TOOL_NAME,
        block: tools.block && SHOW_BLOCK_TOOL_NAME,
      },
    })
  );
}

/**
 * Fold a text prompt plus image attachments into the single streamed
 * SDKUserMessage the SDK accepts for multimodal turns.
 */
async function* buildAttachmentPrompt(
  text: string,
  attachments: ChatImageAttachment[]
): AsyncIterable<SDKUserMessage> {
  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...attachments.map((attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: attachment.mediaType,
        data: attachment.data,
      },
    })),
  ];
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: content as SDKUserMessage["message"]["content"],
    },
    session_id: "",
  };
}
