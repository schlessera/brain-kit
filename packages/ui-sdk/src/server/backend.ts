/**
 * AgentBackend — the seam between the brain-ui server and whatever agent
 * runtime drives a conversation. Two first-party implementations exist:
 * @brainform/ui-backend-pi (upstream pi SDK, OSS default) and
 * @brainform/ui-backend-claude (Claude Agent SDK, flat-rate-subscription
 * path). One backend is active per deployment (v1).
 *
 * ## startTurn contract
 *
 * - Resolves when the turn has fully ended: after the backend emitted its
 *   terminal frame (`result`, or `status: cancelled`).
 * - The backend MUST emit `session_info` as soon as the session identity is
 *   known, before any content frames for a new session.
 * - Abort: the host owns the AbortController (user cancel + timeout). On
 *   abort the backend stops work, emits `status: cancelled`, and RESOLVES.
 * - Runtime failures (agent crashed, provider unreachable) are emitted as an
 *   `error` frame and the promise RESOLVES — the wire consumer needs the
 *   frame either way. The promise REJECTS only for caller errors: a second
 *   concurrent turn (BackendBusyError), an unknown profileId, or resume
 *   without `capabilities.resume` (BackendRequestError).
 * - One turn at a time per backend instance; the host queues.
 */

import type {
  AskUserAnnotation,
  AskUserQuestion,
  ChatImageAttachment,
  ChatSession,
  GeoCoords,
  GeoRequestOptions,
  ProviderInfo,
  ServerMessage,
  SessionHistoryMessage,
} from "../protocol";

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
}

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
  bridge: BackendBridge;
}

export interface AgentBackend {
  /** Stable identity, e.g. "pi" | "claude". Persisted per session (backend_id). */
  id: string;
  capabilities: BackendCapabilities;
  /** Model/endpoint profiles this backend can run. Never exposes keys. */
  listProfiles(): ProviderInfo[] | Promise<ProviderInfo[]>;
  startTurn(req: StartTurnRequest): Promise<void>;
  /** Sessions this backend owns (its own transcript store). */
  listSessions(): Promise<ChatSession[]>;
  /** Normalized-at-read history; backends own raw transcripts. */
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
}

/** A second startTurn while one is active. The host should queue instead. */
export class BackendBusyError extends Error {
  constructor(backendId: string) {
    super(`Backend "${backendId}" already has an active turn`);
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
