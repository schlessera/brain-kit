import {
  query,
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
  type Options,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatImageAttachment,
  ChatSession,
  ProviderInfo,
  ServerMessage,
  SessionHistoryMessage,
} from "@endoxa/ui-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
  PermissionDecision,
  StartTurnRequest,
  WriteLock,
} from "@endoxa/ui-sdk/server";
import {
  BackendBusyError,
  BackendRequestError,
  createWriteLock,
} from "@endoxa/ui-sdk/server";
import { StreamAdapter } from "./stream-adapter.js";
import { createEndoxaMcpServer, ASK_USER_TOOL_NAME } from "./ask-user-tool.js";
import { GET_LOCATION_TOOL_NAME } from "./location-tool.js";
import {
  DEFAULT_PROFILES,
  getProfile,
  listProfiles,
  type InferenceProfile,
} from "./profiles.js";
import { createHistory } from "./history.js";

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

/**
 * Tools whose execution mutates the shared working tree (file writes, git
 * operations). These are serialized across all sessions through the backend's
 * WriteLock; every other tool (Read/Glob/Grep/WebFetch/WebSearch and the
 * in-process endoxa MCP tools, which only bridge to the browser) runs fully
 * parallel. Bash is mutating conservatively — it can write or run git. A
 * subagent's own Bash/Edit/Write calls surface here under their own names and
 * are gated individually. Add write-capable MCP tools here as they appear.
 *
 * The lock is acquired in a PreToolUse hook, NOT in canUseTool: the SDK
 * auto-allows tools listed in `allowedTools` without ever consulting
 * canUseTool, while PreToolUse fires (and is awaited) before every tool
 * execution regardless of how it was permitted.
 */
const MUTATING_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);

const MUTATING_TOOL_MATCHER = `^(${[...MUTATING_TOOLS].join("|")})$`;

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
  /**
   * Serializes MUTATING tool executions across every session this backend
   * runs, so two parallel turns never interleave writes/git ops in the shared
   * working tree. Defaults to a fresh per-instance lock; inject a shared one to
   * coordinate with other writers of the same repo (or to observe it in tests).
   */
  writeLock?: WriteLock;
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

/** Per-turn mutable state tracked while a session's turn is running. */
interface ActiveTurn {
  /**
   * Write-lock releases held by a mutating tool, keyed by the toolUseId that
   * acquired them; released when that tool's result frame streams, or all at
   * once by the turn-end backstop.
   */
  pendingReleases: Map<string, () => void>;
  /** Set in the turn's finally, so a lock acquired after teardown self-releases. */
  ended: boolean;
}

/**
 * Build an AgentBackend backed by the Claude Agent SDK. The SDK owns session
 * persistence (JSONL under the brain dir), tool execution, and cost reporting;
 * this wrapper maps its streaming output onto the endoxa wire protocol and
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

  const writeLock = options.writeLock ?? createWriteLock();

  const capabilities: BackendCapabilities = {
    resume: true,
    permissions: true,
    thinking: true,
    attachments: true,
    askUser: true,
    costReporting: true,
    // Each turn is its own `query()` subprocess with per-turn closure state, so
    // turns on different sessions run in parallel; busy-ness is per session.
    concurrentSessions: true,
    // The Agent SDK has no mid-turn message injection, so the host queues
    // follow-ups as the session's next turn (status: queued) rather than us
    // delivering them into the running one.
    followUp: false,
  };

  // Busy-ness is PER SESSION: one running turn per session key. Resuming a
  // session that already has a running turn rejects BackendBusyError; a NEW
  // turn (no sessionId yet) gets a unique placeholder key, so two concurrent
  // new-session turns always coexist. The slot is re-keyed to the real session
  // id once the SDK reports it.
  const activeTurns = new Map<string, ActiveTurn>();

  async function startTurn(req: StartTurnRequest): Promise<void> {
    const profile = resolveProfile(profiles, req.profileId);

    if (req.sessionId !== undefined && activeTurns.has(req.sessionId)) {
      throw new BackendBusyError(BACKEND_ID, req.sessionId);
    }

    const turn: ActiveTurn = { pendingReleases: new Map(), ended: false };

    // Write-lock bookkeeping, keyed by toolUseId and idempotent per key: the
    // PreToolUse hook and the canUseTool re-acquire can both run for one tool
    // use, and a release must be safe when nothing is held.
    const acquireForTool = async (toolUseId: string): Promise<void> => {
      if (turn.pendingReleases.has(toolUseId)) return;
      const release = await writeLock.acquire();
      if (turn.ended || turn.pendingReleases.has(toolUseId)) {
        // Turn drained while queued, or a concurrent acquire won: never runs.
        release();
        return;
      }
      turn.pendingReleases.set(toolUseId, release);
    };
    const releaseForTool = (toolUseId: string): void => {
      const release = turn.pendingReleases.get(toolUseId);
      if (release) {
        release();
        turn.pendingReleases.delete(toolUseId);
      }
    };
    // Placeholder key for a new session; the real id (a resume's requested id,
    // or the SDK-minted id for a new session) replaces it below.
    let turnKey = req.sessionId ?? `new:${crypto.randomUUID()}`;
    activeTurns.set(turnKey, turn);

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

    // Scope every frame to its session once the identity is known. For a
    // resume that is up front (the requested id); for a new session it is null
    // until the SDK reports it, so the only pre-identity frames (status/
    // thinking) go out unscoped, then everything after is scoped. result and
    // session_info already carry their own sessionId; the spread is a no-op on
    // them.
    let sessionId: string | null = req.sessionId ?? null;
    const emit = (msg: ServerMessage): void => {
      // The cast is safe: backends never emit the (unscoped) server_hello
      // frame, and every other ServerMessage accepts a sessionId.
      req.bridge.emit(sessionId !== null ? ({ ...msg, sessionId } as ServerMessage) : msg);
    };
    const startedAt = Date.now();
    // Hoisted: the catch/finally paths must know whether the stream already
    // produced its terminal result — a stream that yields a result and THEN
    // throws must not get a second one.
    let sawResult = false;
    /**
     * Unified terminal frame for cancelled/failed turns. With a session
     * identity that is a `result`; WITHOUT one (an abort or failure before
     * the SDK reported a session) the contract's terminal is a bare `error`,
     * so a client keying on result/error is never left hanging.
     */
    const emitTerminal = (outcome: "error" | "cancelled"): void => {
      if (sawResult) return;
      sawResult = true;
      if (sessionId === null) {
        emit({
          type: "error",
          code: outcome === "cancelled" ? "CANCELLED" : "CLAUDE_ERROR",
          message:
            outcome === "cancelled"
              ? "Turn cancelled before the session was established"
              : "Turn failed before the session was established",
        });
        return;
      }
      // costUsd deliberately absent (unknown); duration is real, numTurns 0 =
      // "no completed turns" for a turn that never finished.
      emit({
        type: "result",
        sessionId,
        outcome,
        durationMs: Date.now() - startedAt,
        numTurns: 0,
        isError: outcome === "error",
      });
    };

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
          // The PreToolUse hook below may already hold the write lock for this
          // tool use (it fires before permission evaluation). Don't keep the
          // lock across the (possibly long) approval wait — release it now and
          // re-acquire only once the tool is actually approved.
          releaseForTool(opts.toolUseID);
          const decision = await req.bridge.requestPermission({
            toolUseId: opts.toolUseID,
            toolName,
            input,
            description: opts.description,
          });
          // A mutating tool runs inside this subprocess the moment we return
          // "allow", so take the shared write lock BEFORE allowing and hold it
          // until the tool's result frame is observed (see the stream loop) or
          // the turn ends. Denials and read-only tools take nothing.
          if (decision.behavior === "allow" && MUTATING_TOOLS.has(toolName)) {
            await acquireForTool(opts.toolUseID);
          }
          return toPermissionResult(decision);
        },
        hooks: {
          // The write lock CANNOT live in canUseTool alone: the SDK
          // auto-allows every tool listed in `allowedTools` without invoking
          // the callback (it warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and the
          // default allowlist contains all mutating tools. PreToolUse fires
          // before every tool execution — auto-allowed or approved — and the
          // SDK awaits it, so acquiring here serializes writes across turns
          // no matter which permission path admitted the tool.
          PreToolUse: [
            {
              matcher: MUTATING_TOOL_MATCHER,
              hooks: [
                async (hookInput) => {
                  if (
                    hookInput.hook_event_name === "PreToolUse" &&
                    MUTATING_TOOLS.has(hookInput.tool_name)
                  ) {
                    await acquireForTool(hookInput.tool_use_id);
                  }
                  return { continue: true };
                },
              ],
            },
          ],
          // A deny decided outside canUseTool (settings deny rules, other
          // hooks) must still free a lock the PreToolUse hook took; our own
          // canUseTool deny releases up front.
          PermissionDenied: [
            {
              hooks: [
                async (_hookInput, toolUseID) => {
                  if (toolUseID) releaseForTool(toolUseID);
                  return { continue: true };
                },
              ],
            },
          ],
        },
      };

      if (profile.model !== undefined) sdkOptions.model = profile.model;
      if (options.claudeCodePath !== undefined) {
        sdkOptions.pathToClaudeCodeExecutable = options.claudeCodePath;
      }
      if (req.sessionId !== undefined) sdkOptions.resume = req.sessionId;
      if (askUser || getLocation) {
        sdkOptions.mcpServers = {
          endoxa: createEndoxaMcpServer({ askUser, getLocation }),
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

      let announced = false;
      for await (const msg of result) {
        // Emit session_info as soon as the session identity is known, before
        // any content frames (contract requirement).
        if (!announced && msg.session_id) {
          announced = true;
          if (sessionId === null) {
            // New session: adopt the SDK-minted id for scoping and re-key the
            // busy slot from its placeholder, so a resume of this session while
            // it still runs is detected as busy.
            sessionId = msg.session_id;
            activeTurns.delete(turnKey);
            activeTurns.set(sessionId, turn);
            turnKey = sessionId;
          }
          emit({
            type: "session_info",
            sessionId: sessionId,
            isNew: !req.sessionId,
            providerId: profile.id,
          });
        }
        for (const serverMsg of adapter.adapt(msg)) {
          // Exactly one terminal frame per turn, whatever the stream does:
          // a second SDK result is dropped rather than forwarded.
          if (serverMsg.type === "result") {
            if (sawResult) continue;
            sawResult = true;
          }
          // Release the write lock the moment a mutating tool's result frame
          // lands (the turn-end backstop covers anything still held).
          if (serverMsg.type === "tool_result") {
            releaseForTool(serverMsg.toolUseId);
          }
          emit(serverMsg);
        }
      }

      // Stream ended without its terminal result: aborted → cancelled; not
      // aborted → an abnormal end the client must still be released from.
      if (!sawResult) {
        if (abortController.signal.aborted) {
          emit({ type: "status", status: "cancelled" });
          emitTerminal("cancelled");
        } else {
          emit({
            type: "error",
            code: "CLAUDE_NO_RESULT",
            message: "Backend stream ended without a result",
          });
          emitTerminal("error");
        }
      }
    } catch (err) {
      // error/cancelled frames are diagnostics; the terminal frame is the
      // result with an outcome (for turns that have a session identity —
      // a turn that died before any session id ends on the bare error).
      // emitTerminal itself no-ops when the stream already delivered its
      // result before throwing.
      // Diagnostics only make sense BEFORE the terminal frame; when the
      // stream already delivered its result, the turn is over and nothing
      // may follow it.
      if (sawResult) {
        // Terminal frame already sent — swallow the late failure.
      } else if (abortController.signal.aborted) {
        emit({ type: "status", status: "cancelled" });
        emitTerminal("cancelled");
      } else {
        emit({
          type: "error",
          code: "CLAUDE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
        emitTerminal("error");
      }
    } finally {
      req.signal.removeEventListener("abort", onHostAbort);
      // Backstop: release any write lock still held (a mutating tool whose
      // result never streamed, e.g. an aborted turn) and free the busy slot.
      turn.ended = true;
      for (const release of turn.pendingReleases.values()) release();
      turn.pendingReleases.clear();
      activeTurns.delete(turnKey);
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
