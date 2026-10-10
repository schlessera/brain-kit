import { ASK_USER_FORM_TOOL_NAME } from "./ask-user-form-tool.js";
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
import { isThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";

import { QUERY_ACTIVITY_TOOL_NAME } from "./activity-tool.js";
import { createBrainUiMcpServer, ASK_USER_TOOL_NAME } from "./ask-user-tool.js";
import { ASK_USER_LIST_TOOL_NAME } from "./ask-user-list-tool.js";
import { ASK_USER_RANK_TOOL_NAME } from "./ask-user-rank-tool.js";
import { envSnapshot, resolveExecConfig } from "./config/env.js";
import { GET_LOCATION_TOOL_NAME } from "./location-tool.js";
import { MASK_TOOL_NAME } from "./mask-tool.js";
import { userMessage } from "./turn-input.js";
import { SHOW_BLOCK_TOOL_NAME } from "./show-block-tool.js";
import type { BackendLogFn, ClaudeBackendOptions } from "./options.js";
import type { InferenceProfile } from "./profiles.js";
import { createPermissionWiring } from "./permission-hooks.js";
import { createWrappedSpawn } from "./spawn-wrapper.js";
import { claudeEffort } from "./effort.js";
import { CLEARED_API_CREDENTIALS, NEUTRALISED_SETTINGS } from "./subscription.js";
import type { TurnLockBinding } from "./turn-lock.js";

export interface ClaudeSdkTurn {
  options: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
  /**
   * The turn is held to the subscription (subscription.ts): its prompt may be
   * released only after the account the CLI selected has been checked.
   */
  subscriptionOnly: boolean;
}

/**
 * One environment for everything a turn on `profile` spawns: the profile's
 * declared credential names are part of the agent audience (config/env.ts),
 * and the rtk hook shells out before the SDK does, so both must see the same
 * filtered set rather than the server's own. The boot probe uses it too.
 */
export function turnEnv(profile: InferenceProfile): Record<string, string | undefined> {
  const env = { ...envSnapshot(profile.requiredEnvKeys), ...profile.buildEnv() };
  // After the profile's own env, so nothing a profile builds can put an API
  // credential back under a turn that is not declared as API-billed.
  if (profile.billing !== "api") Object.assign(env, CLEARED_API_CREDENTIALS);
  return env;
}

export function createClaudeSdkTurn(options: {
  backend: ClaudeBackendOptions;
  req: StartTurnRequest;
  profile: InferenceProfile;
  abortController: AbortController;
  allowedTools: readonly string[];
  confirmPatterns: readonly RegExp[];
  turnLock: TurnLockBinding;
  log: BackendLogFn;
}): ClaudeSdkTurn {
  const { backend, req, profile, abortController, confirmPatterns, turnLock, log } = options;
  // Only wire ask-user / location tools when the host bridge offers them.
  const askUser = req.bridge.askUser;
  const getLocation = req.bridge.getLocation;
  // The mask editor is the one bridge tool that needs EYES: it opens an editor
  // and then blocks on a region someone has to paint. A turn that declared it
  // has no grant surface has nobody to paint it, so the capability is withheld
  // rather than offered and blocked on — and withheld at the append, because
  // the append is what puts it inside the turn's allowlist whatever the
  // posture declared (docs/decisions/voice-permission.md). Location, activity,
  // show_block and ask_user ask nothing of a viewer, so they are unaffected.
  const requestMask = req.noGrantSurface === true ? undefined : req.bridge.requestMask;
  // The list card needs eyes for the same reason: up to thirty rows of chips
  // that someone has to read and tap. It is not in the voice posture, so it is
  // withheld here rather than appended into an allowlist that left it out.
  const askUserList = req.noGrantSurface === true ? undefined : req.bridge.askUserList;
  const askUserRank = req.noGrantSurface === true ? undefined : req.bridge.askUserRank;
  const askUserForm = req.noGrantSurface === true ? undefined : req.bridge.askUserForm;
  const queryActivity = req.bridge.queryActivity;
  const hosted = Boolean(req.bridge.applyBrain);
  const migrations: Record<string, string> = {
    mcp__brain__brain_add: "mcp__brain-ui__brain_add", mcp__brain__brain_update: "mcp__brain-ui__brain_update",
    mcp__brain__brain_archive: "mcp__brain-ui__brain_archive", Write: "mcp__brain-ui__write_file", Edit: "mcp__brain-ui__edit_file",
  };
  const allowed = [...new Set(options.allowedTools.map(name => hosted ? (migrations[name] ?? name) : name))];
  if (req.bridge.readBrainBase) allowed.push("mcp__brain-ui__brain_read_base");
  // Application permission lives in the server. These are callable tools,
  // never authority: every executor goes through the server-owned route.
  if (req.bridge.applyBrain && !req.noGrantSurface) allowed.push(
    "mcp__brain-ui__brain_archive", "mcp__brain-ui__apply_staged_changes");
  // An autonomous roster is exact server authority, including bridge tools.
  if (!req.autonomous) {
    // Auto-allow the in-process MCP tools so they never trip a permission
    // prompt (ask-user is itself the question channel; location consent is
    // handled by the browser's geolocation prompt).
    if (askUser) allowed.push(ASK_USER_TOOL_NAME);
    if (askUserList) allowed.push(ASK_USER_LIST_TOOL_NAME);
    if (askUserRank) allowed.push(ASK_USER_RANK_TOOL_NAME);
    if (askUserForm) allowed.push(ASK_USER_FORM_TOOL_NAME);
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
  }

  const append = req.autonomous?.systemPromptAppend ?? buildAppend(
    backend,
    req.client,
    {
      askUser: Boolean(askUser),
      askUserList: Boolean(askUserList),
      askUserRank: Boolean(askUserRank),
      askUserForm: Boolean(askUserForm),
      location: Boolean(getLocation),
      mask: Boolean(requestMask),
      activity: Boolean(queryActivity),
      block: true,
    },
    req.turnBudgetMs
  );
  const childEnv = turnEnv(profile);
  const subscriptionOnly = profile.billing !== "api";
  const sdkOptions: Options = {
    ...(req.autonomous ? { persistSession: false } : {}),
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
    // Preserve manual approvals across SDK versions that leave an omitted
    // mode to the CLI (claude-code-runtime.md, #1213). Enforcement hooks
    // remain the every-call boundary, including no-grant and voice turns.
    permissionMode: "default",
    allowedTools: allowed,
    // The built-in AskUserQuestion picker needs a TTY; keep it disabled even
    // when no ask-user handler is present.
    disallowedTools: ["AskUserQuestion", ...((hosted || req.autonomous) ? [
      "mcp__brain__brain_add", "mcp__brain__brain_update", "mcp__brain__brain_archive",
    ] : []), ...(hosted ? ["Write", "Edit", "NotebookEdit"] : [])],
    ...createPermissionWiring({
      req,
      allowedTools: allowed,
      confirmPatterns,
      brainPath: backend.brainPath,
      turnLock,
      childEnv,
      log,
    }),
  };

  if (profile.model !== undefined) sdkOptions.model = profile.model;
  const effort = claudeEffort(profile, req.thinkingLevel);
  if (effort !== undefined) sdkOptions.effort = effort;
  if (req.thinkingLevel !== undefined) {
    // Options are a request, not evidence: managed CLI settings can clamp them.
    // Stop reports the main turn's active effort after that clamp. Preserve all
    // permission hooks and never let this observation decide tool permission.
    sdkOptions.hooks = {
      ...sdkOptions.hooks,
      Stop: [...(sdkOptions.hooks?.Stop ?? []), { hooks: [async (input) => {
        const effective = input.effort?.level;
        if (isThinkingLevel(effective)) {
          req.bridge.emit({ type: "status", status: "thinking", sessionId: input.session_id,
            thinkingLevel: req.thinkingLevel, effectiveThinkingLevel: effective });
        }
        return {};
      }] }],
    };
  }
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
      application: req.bridge,
      askUser,
      askUserList,
      askUserRank,
      askUserForm,
      askUserFormLimits: req.bridge.askUserFormLimits,
      getLocation,
      requestMask,
      queryActivity,
      brainPath: backend.brainPath,
    }),
  };
  sdkOptions.env = childEnv;
  if (subscriptionOnly) {
    sdkOptions.settings = { ...NEUTRALISED_SETTINGS, env: { ...NEUTRALISED_SETTINGS.env } };
  }

  return {
    options: sdkOptions,
    subscriptionOnly,
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
    askUserList: boolean;
    askUserRank: boolean;
    askUserForm: boolean;
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
        askUserList: tools.askUserList && ASK_USER_LIST_TOOL_NAME,
        askUserRank: tools.askUserRank && ASK_USER_RANK_TOOL_NAME,
        askUserForm: tools.askUserForm && ASK_USER_FORM_TOOL_NAME,
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
  yield userMessage(text, attachments);
}
