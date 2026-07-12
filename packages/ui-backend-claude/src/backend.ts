import {
  query,
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
  type Options,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatImageAttachment, ChatSession, ProviderInfo, SessionHistoryMessage } from "@brainform/ui-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
  PermissionDecision,
  StartTurnRequest,
} from "@brainform/ui-sdk/server";
import { BackendBusyError, BackendRequestError } from "@brainform/ui-sdk/server";
import { StreamAdapter } from "./stream-adapter";
import { createBrainformMcpServer, ASK_USER_TOOL_NAME } from "./ask-user-tool";
import { GET_LOCATION_TOOL_NAME } from "./location-tool";
import {
  DEFAULT_PROFILES,
  getProfile,
  listProfiles,
  type InferenceProfile,
} from "./profiles";
import { createHistory } from "./history";

const BACKEND_ID = "claude";

const DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "LSP",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Skill",
  "NotebookEdit",
];

export interface ClaudeBackendOptions {
  /** Working directory for the agent — the brain repo the model operates on. */
  brainPath: string;
  /**
   * Path to the native `claude` executable. The Agent SDK can't always
   * auto-discover it; pass it explicitly when it isn't on PATH. Omitted =
   * let the SDK locate it.
   */
  claudeCodePath?: string;
  /** Inference profiles this backend can run. Defaults to {@link DEFAULT_PROFILES}. */
  profiles?: InferenceProfile[];
  /**
   * Reserved. The host owns turn timeouts via the StartTurnRequest signal (see
   * the startTurn contract), so this is accepted for forward-compatibility but
   * NOT enforced here.
   */
  defaultTimeoutMs?: number;
  /** Backend-wide tool allowlist; a profile's own `allowedTools` overrides it. */
  allowedTools?: string[];
  /** @internal Test seam — inject the SDK `query` function. Defaults to the real one. */
  queryFn?: typeof query;
  /** @internal Test seam — inject the SDK `listSessions` reader. */
  listSessionsFn?: typeof sdkListSessions;
  /** @internal Test seam — inject the SDK `getSessionMessages` reader. */
  getSessionMessagesFn?: typeof sdkGetSessionMessages;
}

/** Structural translation of a bridge PermissionDecision into the SDK's PermissionResult. */
function toPermissionResult(decision: PermissionDecision): PermissionResult {
  if (decision.behavior === "allow") {
    // Omit updatedInput when the user approved unchanged so the SDK runs the
    // tool with its original input.
    return decision.updatedInput !== undefined
      ? { behavior: "allow", updatedInput: decision.updatedInput }
      : { behavior: "allow" };
  }
  return { behavior: "deny", message: decision.message };
}

function resolveProfile(
  profiles: InferenceProfile[],
  profileId: string | undefined
): InferenceProfile {
  // profileId is only meaningful for new sessions; resumed sessions are pinned
  // host-side and pass their original id back through. Undefined = default.
  if (profileId === undefined) return profiles[0]!;
  const profile = getProfile(profiles, profileId);
  if (!profile) throw new BackendRequestError(`Unknown profile id: ${profileId}`);
  return profile;
}

/**
 * Build an AgentBackend backed by the Claude Agent SDK. The SDK owns session
 * persistence (JSONL under the brain dir), tool execution, and cost reporting;
 * this wrapper maps its streaming output onto the brainform wire protocol and
 * routes permission / ask-user / location round-trips through the host bridge.
 */
export function createClaudeBackend(
  options: ClaudeBackendOptions
): AgentBackend {
  const profiles =
    options.profiles && options.profiles.length > 0
      ? options.profiles
      : DEFAULT_PROFILES;
  const queryFn = options.queryFn ?? query;
  const history = createHistory({
    brainPath: options.brainPath,
    listSessionsFn: options.listSessionsFn,
    getSessionMessagesFn: options.getSessionMessagesFn,
  });

  const capabilities: BackendCapabilities = {
    resume: true,
    permissions: true,
    thinking: true,
    attachments: true,
    askUser: true,
    costReporting: true,
  };

  // One turn at a time per backend instance; a second concurrent startTurn
  // rejects with BackendBusyError (the host queues).
  let activeTurn = false;

  async function startTurn(req: StartTurnRequest): Promise<void> {
    if (activeTurn) throw new BackendBusyError(BACKEND_ID);
    const profile = resolveProfile(profiles, req.profileId);

    activeTurn = true;

    // The host owns cancellation. Mirror its signal onto an internal
    // AbortController that the SDK query listens to.
    const abortController = new AbortController();
    const onHostAbort = () => abortController.abort();
    if (req.signal.aborted) abortController.abort();
    else req.signal.addEventListener("abort", onHostAbort, { once: true });

    const adapter = new StreamAdapter();
    // Only wire ask-user / location tools when the host bridge offers them.
    const askUser = req.bridge.askUser;
    const getLocation = req.bridge.getLocation;

    try {
      const profileEnv = profile.buildEnv();
      const allowedTools =
        profile.allowedTools ?? options.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
      const allowed = [...allowedTools];
      // Auto-allow the in-process MCP tools so they never trip a permission
      // prompt (ask-user is itself the question channel; location consent is
      // handled by the browser's geolocation prompt).
      if (askUser) allowed.push(ASK_USER_TOOL_NAME);
      if (getLocation) allowed.push(GET_LOCATION_TOOL_NAME);

      const sdkOptions: Options = {
        cwd: options.brainPath,
        includePartialMessages: true,
        abortController,
        // Load CLAUDE.md and project skills from the brain repo.
        settingSources: ["project"],
        allowedTools: allowed,
        // The built-in AskUserQuestion picker needs a TTY; keep it disabled
        // even when no ask-user handler is present.
        disallowedTools: ["AskUserQuestion"],
        canUseTool: async (toolName, input, opts) => {
          const decision = await req.bridge.requestPermission({
            toolUseId: opts.toolUseID,
            toolName,
            input,
            description: opts.description,
          });
          return toPermissionResult(decision);
        },
      };

      if (profile.model !== undefined) sdkOptions.model = profile.model;
      if (options.claudeCodePath !== undefined) {
        sdkOptions.pathToClaudeCodeExecutable = options.claudeCodePath;
      }
      if (req.sessionId !== undefined) sdkOptions.resume = req.sessionId;
      if (askUser || getLocation) {
        sdkOptions.mcpServers = {
          brainform: createBrainformMcpServer({ askUser, getLocation }),
        };
      }
      if (Object.keys(profileEnv).length > 0) {
        sdkOptions.env = { ...process.env, ...profileEnv };
      }

      const queryPrompt =
        req.attachments && req.attachments.length > 0
          ? buildAttachmentPrompt(req.prompt, req.attachments)
          : req.prompt;

      const result = queryFn({ prompt: queryPrompt, options: sdkOptions });

      let sessionId: string | null = null;
      let sawResult = false;
      for await (const msg of result) {
        // Emit session_info as soon as the session identity is known, before
        // any content frames (contract requirement).
        if (!sessionId && msg.session_id) {
          sessionId = msg.session_id;
          req.bridge.emit({
            type: "session_info",
            sessionId,
            isNew: !req.sessionId,
            providerId: profile.id,
          });
        }
        for (const serverMsg of adapter.adapt(msg)) {
          if (serverMsg.type === "result") sawResult = true;
          req.bridge.emit(serverMsg);
        }
      }

      // If the host aborted but the SDK ended the stream without throwing,
      // still surface cancellation as the terminal frame.
      if (abortController.signal.aborted && !sawResult) {
        req.bridge.emit({ type: "status", status: "cancelled" });
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        req.bridge.emit({ type: "status", status: "cancelled" });
      } else {
        req.bridge.emit({
          type: "error",
          code: "CLAUDE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      req.signal.removeEventListener("abort", onHostAbort);
      activeTurn = false;
    }
  }

  return {
    id: BACKEND_ID,
    capabilities,
    listProfiles(): ProviderInfo[] {
      return listProfiles(profiles);
    },
    startTurn,
    listSessions(): Promise<ChatSession[]> {
      return history.listSessions();
    },
    getHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
      return history.getHistory(sessionId);
    },
  };
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
    ...(text
      ? [
          {
            type: "text" as const,
            text,
          },
        ]
      : []),
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
