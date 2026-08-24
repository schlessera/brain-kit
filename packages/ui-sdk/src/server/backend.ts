/**
 * AgentBackend — the seam between the brain-ui server and whatever agent
 * runtime drives a conversation. Two first-party implementations exist:
 * @schlessera/brain-backend-pi (upstream pi SDK, OSS default) and
 * @schlessera/brain-backend-claude (Claude Agent SDK, flat-rate-subscription
 * path). One backend is active per deployment (v1).
 *
 * ## startTurn contract (rev 2 — parallel sessions)
 *
 * - Resolves when the turn has fully ended: after the backend emitted its
 *   terminal frame (`result`, or `status: cancelled`).
 * - The backend MUST emit `session_info` as soon as the session identity is
 *   known, before any content frames for a new session.
 * - Multi-session servers require every session-scoped frame to carry
 *   `sessionId` (backends emit it whenever the session identity is known).
 * - Abort: the host owns the AbortController (user cancel + timeout). On
 *   abort the backend stops work, emits `status: cancelled`, and RESOLVES.
 * - Runtime failures (agent crashed, provider unreachable) are emitted as an
 *   `error` frame and the promise RESOLVES — the wire consumer needs the
 *   frame either way. The promise REJECTS only for caller errors: a turn on a
 *   session that is already running (BackendBusyError), an unknown profileId,
 *   or resume without `capabilities.resume` (BackendRequestError).
 * - Concurrency: busy-ness is PER SESSION. When `capabilities.concurrentSessions`
 *   is true, turns on different sessions run in parallel (the host enforces
 *   its own deployment-time cap); when false, the backend is a single-turn
 *   instance and the host serializes.
 * - Follow-up: when `capabilities.followUp` is true the backend implements
 *   `followUp()` — the host delivers mid-turn user messages into the RUNNING
 *   turn (frames keep flowing through the original turn's bridge). When
 *   false the host queues the message and starts it as the session's next
 *   turn after the current one resolves (`status: queued` on the wire).
 * - Shared-repo safety: backends serialize MUTATING tool executions across
 *   all their sessions through a WriteLock (see write-lock.ts) — two agents
 *   editing one working tree must never interleave writes/git operations.
 */

import type {
  AskUserAnnotation,
  AskUserQuestion,
  ChatImageAttachment,
  ChatSession,
  ClientEnvironment,
  GeoCoords,
  GeoRequestOptions,
  ProviderInfo,
  ServerMessage,
  SessionHistoryMessage,
} from "../protocol.js";

export interface BackendCapabilities {
  /** Can continue an existing session (startTurn with sessionId). */
  resume: boolean;
  /** Emits tool_approval_request round-trips via bridge.requestPermission. */
  permissions: boolean;
  /** Emits thinking_delta frames. */
  thinking: boolean;
  /** Accepts image attachments on startTurn. */
  attachments: boolean;
  /** Routes clarifying questions via bridge.askUser. */
  askUser: boolean;
  /** result.costUsd is meaningful (0 otherwise). */
  costReporting: boolean;
  /** Turns on different sessions may run in parallel (busy-ness is per session). */
  concurrentSessions: boolean;
  /**
   * Mid-turn user messages are injected into the running turn via followUp().
   * false → the host queues them as the session's next turn (status: queued).
   */
  followUp: boolean;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}

export interface AskUserResult {
  answers: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
}

export interface LocationFix {
  coords: GeoCoords;
  /** Epoch millis when the fix was taken. */
  timestamp: number;
}

/**
 * Host plumbing handed to the backend for one turn. `emit` delivers protocol
 * frames to the client; the request/response methods resolve when the user
 * answers and REJECT on cancel/disconnect — backends must translate a
 * rejection into the agent-appropriate tool error, never crash the turn.
 *
 * Optional members signal host capability: a backend only registers its
 * ask-user / location tooling when the corresponding method is present.
 */
export interface BackendBridge {
  emit(msg: ServerMessage): void;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  askUser?(requestId: string, questions: AskUserQuestion[]): Promise<AskUserResult>;
  getLocation?(options?: GeoRequestOptions): Promise<LocationFix>;
  /**
   * Ask the user to paint a mask over an image. Resolves with a PNG whose
   * fully transparent pixels mark the editable region; rejects if the user
   * cancels or no client is connected.
   */
  requestMask?(imagePath: string, instruction?: string): Promise<Uint8Array>;
  /**
   * Side channel for activity enrichment the wire protocol deliberately does
   * not carry to chat clients (subagent lifecycle/usage, transcript
   * excerpts). Present only when the host records activity; backends treat
   * it as fire-and-forget and MUST NOT let a throwing reporter fail a turn.
   */
  activity?(event: BackendActivityEvent): void;
  /**
   * Read the host's activity record — the same data the UI reads — so the
   * agent can answer "what ran / what is running?" from the record instead
   * of log forensics. Present only when the host records activity; backends
   * expose it as a read-only tool.
   */
  queryActivity?(query: ActivityQuery): Promise<ActivityQueryResult>;
}

/** A read over the activity record, shaped for model consumption. */
export interface ActivityQuery {
  scope: "running" | "recent" | "run" | "rollups" | "inbox";
  /** Required for scope "run". */
  runId?: string;
  /** Window for "recent"/"rollups", in hours back from now (default 24). */
  hoursBack?: number;
  limit?: number;
}

/** JSON-serializable result; the exact shape is the host's and may grow. */
export type ActivityQueryResult = Record<string, unknown>;

/**
 * Backend-reported activity enrichment. The host derives baseline spans from
 * the frames it already relays; these events add what only the backend sees.
 */
export type BackendActivityEvent =
  | {
      kind: "subagent_started";
      /** The Agent tool call that spawned this subagent. */
      toolUseId: string;
      taskId?: string;
      subagentType?: string;
      description?: string;
      /** 1 for a top-level subagent, N+1 nested. */
      depth?: number;
    }
  | {
      kind: "subagent_status";
      toolUseId: string;
      status: "running" | "completed" | "failed" | "killed" | "paused";
      usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
      summary?: string;
    }
  | {
      kind: "subagent_transcript";
      toolUseId: string;
      role: "assistant" | "user";
      text: string;
    };

export interface StartTurnRequest {
  prompt: string;
  attachments?: ChatImageAttachment[];
  /** Resume this session (requires capabilities.resume). Absent = new session. */
  sessionId?: string;
  /**
   * Opaque profile id from listProfiles(). Travels the wire as `providerId`
   * (historical name). Only honored on new sessions — resumed sessions stay
   * pinned to their original profile.
   */
  profileId?: string;
  /** Host-owned cancellation (user cancel + host timeout). */
  signal: AbortSignal;
  /**
   * The host's per-turn timeout for THIS turn, in ms — the budget after which
   * `signal` fires. Advisory: backends that build a per-turn system prompt
   * should surface it (`buildSystemPromptAppend({ turnBudgetMs })`) so the
   * model can size its work to the cap instead of discovering it mid-flight.
   */
  turnBudgetMs?: number;
  bridge: BackendBridge;
  /**
   * What the reader is on, as the browser measured it at send time. Absent
   * when the client is older or headless. Backends that can vary their system
   * prompt per turn should feed it to `buildSystemPromptAppend()`; it is
   * advisory and never required.
   */
  client?: ClientEnvironment;
}

/** Mid-turn user message for a RUNNING session (capabilities.followUp). */
export interface FollowUpRequest {
  sessionId: string;
  prompt: string;
  attachments?: ChatImageAttachment[];
}

export interface AgentBackend {
  /** Stable identity, e.g. "pi" | "claude". Persisted per session (backend_id). */
  id: string;
  capabilities: BackendCapabilities;
  /** Model/endpoint profiles this backend can run. Never exposes keys. */
  listProfiles(): ProviderInfo[] | Promise<ProviderInfo[]>;
  startTurn(req: StartTurnRequest): Promise<void>;
  /**
   * Inject a user message into a session's RUNNING turn (only when
   * capabilities.followUp). Frames keep flowing through that turn's bridge;
   * rejects with BackendRequestError when the session has no running turn.
   */
  followUp?(req: FollowUpRequest): Promise<void>;
  /** Sessions this backend owns (its own transcript store). */
  listSessions(): Promise<ChatSession[]>;
  /** Normalized-at-read history; backends own raw transcripts. */
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
}

/**
 * A startTurn for a session that already has a running turn (or, for
 * single-turn backends, any concurrent turn). The host queues instead.
 */
export class BackendBusyError extends Error {
  constructor(backendId: string, sessionId?: string) {
    super(
      sessionId
        ? `Backend "${backendId}" already has an active turn for session ${sessionId}`
        : `Backend "${backendId}" already has an active turn`
    );
    this.name = "BackendBusyError";
  }
}

/** Invalid startTurn request (unknown profile, unsupported resume, …). */
export class BackendRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendRequestError";
  }
}
