// ============================================================
// brain-kit chat-UI wire protocol
//
// Shared between the brain-ui server and client, and implemented by every
// AgentBackend. This protocol is a COMPATIBILITY CONTRACT (see
// docs/integration-contract.md): it is not pluggable, message types are only
// ever added, and fields are only ever added optionally. It descends from
// brain-ui's shared/protocol.ts with two deliberate cleanups:
//   - ProviderInfo.provider (closed vendor union) → optional `vendor` hint
//   - agent-specific phrasing neutralized (any backend may serve these frames)
//
// Naming note: the wire field `providerId` predates the AgentBackend seam and
// is kept for client compatibility. Server-side it is the opaque `profileId`
// passed to AgentBackend.startTurn — a (backend, model, endpoint) profile from
// listProfiles().
//
// Parallel sessions (protocol rev 2, additive): server frames MAY carry a
// `sessionId` scoping them to one running session; clients demux by it. A
// frame without `sessionId` means "the only running session" (legacy
// single-session servers). `cancel` MAY carry a sessionId; without one it
// cancels the sole running session and is an error when several run.
// ============================================================

/**
 * Mixin for session-scoped server frames. All content/lifecycle frames extend
 * it; `sessionId` is optional for wire compatibility with single-session
 * servers, but multi-session servers MUST set it on every scoped frame.
 */
export interface SessionScoped {
  sessionId?: string;
  /**
   * Host-generated id of the turn this frame belongs to (rev 2, additive).
   * Multi-session hosts stamp it on every scoped frame; clients MAY echo it
   * on interactive replies (approvals, ask-user, location) so round-trips
   * correlate by `turnId + requestId`. RESERVED for now: servers stamp it,
   * but no shipped client echoes it back yet — hosts must not require it.
   */
  turnId?: string;
}

/** Protocol revision spoken by this ui-sdk build. Additions never bump it; only semantics changes do. */
export const PROTOCOL_REV = 2;

/**
 * Composite session identity for multi-backend hosts. The wire keeps plain
 * `sessionId` strings (globally unique per host); this pairs one with the
 * backend that owns its transcript for host-side routing/persistence.
 */
export interface SessionRef {
  backendId: string;
  nativeSessionId: string;
}

// --- Client -> Server ---

export type ClientMessage =
  | ClientChatMessage
  | ClientToolApproval
  | ClientToolDenial
  | ClientCancelRequest
  | ClientSessionResume
  | ClientAskUserResponse
  | ClientAskUserCancel
  | ClientLocationResponse
  | ClientLocationError;

export interface ClientChatMessage {
  type: "chat_message";
  text: string;
  sessionId?: string;
  /**
   * Provider+model profile to run this conversation on. Only honored when
   * starting a new conversation — resumed sessions are pinned server-side
   * to the profile they started on.
   */
  providerId?: string;
  attachments?: ChatImageAttachment[];
}

/** Image attached to a chat message. */
export interface ChatImageAttachment {
  /** base64-encoded image data, without a `data:` URI prefix. */
  data: string;
  mediaType: (typeof ALLOWED_IMAGE_MEDIA_TYPES)[number];
}

export const ALLOWED_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const MAX_IMAGES_PER_MESSAGE = 4;
/** Per-image cap on decoded (not base64) bytes, post-downscale. */
export const MAX_IMAGE_BYTES = 2_000_000;
/** Cap on summed decoded bytes across one message. */
export const MAX_TOTAL_IMAGE_BYTES = 6_000_000;
/** Longest-edge target for client-side downscaling (vision-model optimum). */
export const DOWNSCALE_MAX_EDGE = 1568;

export interface ClientToolApproval {
  type: "tool_approval";
  toolUseId: string;
  updatedInput?: Record<string, unknown>;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

export interface ClientToolDenial {
  type: "tool_denial";
  toolUseId: string;
  message: string;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

export interface ClientCancelRequest {
  type: "cancel";
  /**
   * Session to cancel. Optional for single-session compatibility: without it
   * the server cancels the sole running session, and rejects with an `error`
   * frame when more than one session is running.
   */
  sessionId?: string;
}

export interface ClientSessionResume {
  type: "session_resume";
  sessionId: string;
}

// --- Server -> Client ---

export type ServerMessage =
  | ServerHello
  | ServerTextDelta
  | ServerThinkingDelta
  | ServerToolUseStart
  | ServerToolInputDelta
  | ServerToolUseComplete
  | ServerToolResult
  | ServerToolApprovalRequest
  | ServerResultMessage
  | ServerError
  | ServerStatus
  | ServerSessionInfo
  | ServerSessionHistory
  | ServerAskUserRequest
  | ServerLocationRequest;

/**
 * First frame a server sends after a socket opens (rev 2, additive). Clients
 * that don't know it ignore it; clients that do can gate behavior on
 * `protocolRev` and the coarse capability flags instead of sniffing.
 * ADVISORY for now — no shipped client reads it yet; servers must not gate
 * anything on the client having seen it.
 */
export interface ServerHello {
  type: "server_hello";
  protocolRev: number;
  /** Coarse, additive capability flags (e.g. multiSession, askUser, location). */
  capabilities?: Record<string, boolean>;
}

export interface ServerSessionHistory extends SessionScoped {
  type: "session_history";
  messages: SessionHistoryMessage[];
  /**
   * Chunked replay: a large history is split into byte-bounded frames so one
   * oversized frame can't exceed the socket's per-message limit. The first
   * frame omits `append` (the client replaces its transcript with it);
   * continuation frames set `append: true` (the client concatenates them).
   */
  append?: boolean;
}

/**
 * One chronological segment of an assistant message. `tool` parts reference
 * the message's `toolCalls` array by index so tool state (output, approval)
 * lives in one place while ordering is preserved.
 *
 * `parts` is additive: backends whose transcripts carry richer structure
 * (sub-agent trees, nested tool scopes) flatten into these three kinds.
 */
export type MessagePart =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; toolIndex: number };

export interface SessionHistoryMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output?: string;
    isError?: boolean;
  }>;
  /** Chronological ordering of thinking/text/tool segments. */
  parts?: MessagePart[];
  /** Number of image attachments on a user message (data not replayed). */
  attachmentCount?: number;
}

export interface ServerTextDelta extends SessionScoped {
  type: "text_delta";
  text: string;
}

export interface ServerThinkingDelta extends SessionScoped {
  type: "thinking_delta";
  text: string;
}

export interface ServerToolUseStart extends SessionScoped {
  type: "tool_use_start";
  toolUseId: string;
  toolName: string;
}

export interface ServerToolInputDelta extends SessionScoped {
  type: "tool_input_delta";
  toolUseId: string;
  partialJson: string;
}

export interface ServerToolUseComplete extends SessionScoped {
  type: "tool_use_complete";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ServerToolResult extends SessionScoped {
  type: "tool_result";
  toolUseId: string;
  output: string;
  isError: boolean;
}

export interface ServerToolApprovalRequest extends SessionScoped {
  type: "tool_approval_request";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}

export interface ServerResultMessage {
  type: "result";
  sessionId: string;
  /**
   * The turn's terminal disposition. `result` is THE terminal frame for every
   * turn that has a session identity: exactly one per turn, after any
   * diagnostic `error` / `status: cancelled` frames. (Turns that fail before
   * a session id exists end with a bare `error` frame instead.) Optional for
   * wire compatibility; absent means legacy success/isError semantics.
   */
  outcome?: "success" | "error" | "cancelled";
  /**
   * USD cost of the turn. ABSENT when the backend cannot report cost
   * (capabilities.costReporting=false) or the turn failed before accounting —
   * 0 means "actually free", not "unknown".
   */
  costUsd?: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export interface ServerError extends SessionScoped {
  type: "error";
  code: string;
  message: string;
}

export interface ServerStatus extends SessionScoped {
  type: "status";
  status: "thinking" | "tool_executing" | "idle" | "cancelled" | "queued";
  detail?: string;
  /** @deprecated single-session era; multi-session servers set `sessionId`. */
  activeSessionId?: string;
}

export interface ServerSessionInfo {
  type: "session_info";
  sessionId: string;
  isNew: boolean;
  /** Provider+model profile this session is pinned to. */
  providerId?: string;
}

/** Safe profile metadata exposed to the client (never keys/env). */
export interface ProviderInfo {
  id: string;
  label: string;
  /**
   * Optional vendor hint for client iconography/grouping (e.g. "anthropic",
   * "openrouter", "local"). Free-form — clients must not switch behavior on
   * it, only presentation.
   */
  vendor?: string;
  /**
   * Which AgentBackend serves this profile. Set by a host that aggregates
   * profiles from several backends into one picker, so the client can resolve
   * the selection's per-backend capabilities (e.g. follow-up live vs queued).
   * Absent on single-backend hosts (the sole backend's capabilities apply).
   */
  backendId?: string;
  /** Context window in tokens, when the backend knows it. Presentation only. */
  contextWindow?: number;
  /**
   * Where the profile came from: the backend's own pinned default, a
   * host-declared profile (env/config), or provider-API discovery. Presentation
   * only — the client must not switch behavior on it.
   */
  source?: "builtin" | "declared" | "discovered";
}

// --- Model catalog (HTTP: /api/models) ---

/** One row of the settings-screen model catalog: a profile plus its visibility. */
export interface ModelCatalogEntry extends ProviderInfo {
  /** Hidden profiles are omitted from the picker but still resolve for pinned sessions. */
  hidden: boolean;
}

/** Response of GET /api/models, PUT /api/models/hidden, POST /api/models/refresh. */
export interface ModelCatalogResponse {
  /** Every known profile, hidden ones included (each tagged). */
  models: ModelCatalogEntry[];
  /** When discovery last succeeded; null when it never has. */
  refreshedAt: number | null;
  /** The cached discovery result is older than the TTL. */
  stale: boolean;
  discovery: {
    enabled: boolean;
    /** Last discovery failure, if the current list is being served despite one. */
    error?: string;
  };
}

/** Body of PUT /api/models/hidden — the complete hidden set, not a delta. */
export interface SetHiddenModelsRequest {
  hidden: string[];
}

// --- Shared Types ---

export interface ChatSession {
  id: string;
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
  totalCostUsd: number;
  numTurns: number;
  /**
   * AgentBackend that owns this session's transcript. Set by multi-backend
   * hosts when aggregating each backend's sessions into one list; lets the
   * client group/label sessions and the host route history to the owner.
   */
  backendId?: string;
}

export interface BrainSearchResult {
  path: string;
  title: string;
  type: string;
  relevance: string;
  score: number;
  snippet: string;
}

export interface BrainStats {
  documents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  tags: number;
  links: number;
  brokenLinks: number;
  chunks: number;
}

export interface CronJobStatus {
  name: string;
  lastRunAt: number | null;
  lastStatus: "success" | "error" | "running" | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

export interface SystemStatus {
  healthy: boolean;
  uptime: number;
  version: string;
  lastSync: CronJobStatus | null;
  cronJobs: CronJobStatus[];
  activeSession: boolean;
}

/**
 * Passkey credential summary returned by the /api/auth/passkey/* management
 * routes (ui-server). HTTP surface, not a ws frame — listed here with the
 * other REST payload shapes the client consumes.
 */
export interface PasskeySummary {
  id: string;
  label: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
  deviceType: string | null;
  transports: string[] | null;
  aaguid: string | null;
}

// ============================================================
// Voice (ASR / TTS)
// ============================================================

export type MessageSource = "typed" | "voice-dictate" | "voice-conversation";

export type VoiceMode = "idle" | "dictate" | "conversation";

export interface Keyterm {
  term: string;
  score: number;
  source: "tag" | "title" | "link" | "bold" | "acronym";
}

export interface VoiceKeytermsResponse {
  keyterms: string[];
  generatedAt: number;
  count: number;
}

/**
 * Response of POST /voice/session — everything a client AsrClient needs to
 * open its stream. Supersedes the deepgram-only /voice/token response.
 */
export interface VoiceSessionResponse {
  providerId: string;
  /** wss endpoint the client connects to. */
  url: string;
  /** Omitted for local/browser providers that need no credential. */
  token?: string;
  params?: Record<string, string>;
  expiresAt: number;
  capabilities: SpeechCapabilities;
}

export interface SpeechCapabilities {
  streaming: boolean;
  interimResults: boolean;
  keyterms: boolean;
  endpointing: boolean;
}

/** @deprecated superseded by VoiceSessionResponse; kept for client migration. */
export interface VoiceTokenResponse {
  token: string;
  expiresAt: number;
}

export interface PronunciationOverride {
  match: string;
  replacement: string;
}

export interface AsrPartial {
  type: "partial";
  text: string;
}

export interface AsrFinal {
  type: "final";
  text: string;
  endsTurn: boolean;
}

export type AsrEvent = AsrPartial | AsrFinal;

// ============================================================
// File Manager
// ============================================================

export interface FileEntry {
  name: string;
  path: string; // repo-relative, forward-slash
  type: "dir" | "file";
  size?: number;
  mtime?: number;
}

export interface FileTreeResponse {
  path: string;
  entries: FileEntry[];
}

export type FileContentKind = "markdown" | "html" | "text" | "binary";

export interface FileContentResponse {
  path: string;
  kind: FileContentKind;
  size: number;
  mtime: number;
  mime?: string;
  content?: string; // omitted for binary
}

export interface FileResolveResponse {
  path: string;
  ancestors: string[];
  exists: boolean;
  type?: "dir" | "file";
}

export const FILE_SIZE_CAP_BYTES = 5_242_880;

export interface WikilinkMapResponse {
  generatedAt: number;
  count: number;
  /** Lowercase slug -> repo-relative .md path. */
  slugs: Record<string, string>;
}

// ============================================================
// Ask User (clarifying-question bridge)
// ============================================================

export interface AskUserOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserOption[];
}

export interface AskUserAnnotation {
  preview?: string;
  notes?: string;
}

/**
 * Server → Client. The agent wants to ask the user 1-4 questions.
 * The client must reply with ClientAskUserResponse using the same requestId.
 */
export interface ServerAskUserRequest extends SessionScoped {
  type: "ask_user_request";
  requestId: string;
  questions: AskUserQuestion[];
}

/**
 * Client → Server. User's answers to a previous ask_user_request.
 *
 * `answers` is keyed by the question text. For single-select, the value is
 * the selected option's `label` (or the user's free-text input when "Other"
 * was selected). For multiSelect, it's a comma-separated string of labels.
 * The shape is backend-neutral; backends translate it into whatever their
 * agent's ask-user tool expects.
 */
export interface ClientAskUserResponse {
  type: "ask_user_response";
  requestId: string;
  answers: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

/** Client → Server. User dismissed the ask-user prompt; the agent gets an error. */
export interface ClientAskUserCancel {
  type: "ask_user_cancel";
  requestId: string;
  reason?: string;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

// ============================================================
// Geolocation (get_current_location bridge)
// ============================================================

/**
 * A browser Geolocation fix. Mirrors GeolocationCoordinates, minus the
 * non-serializable bits. Fields beyond lat/long/accuracy are often null on
 * devices without the relevant sensors.
 */
export interface GeoCoords {
  latitude: number;
  longitude: number;
  /** Accuracy of latitude/longitude in metres (68% confidence). */
  accuracy: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

/** Hints forwarded to `navigator.geolocation.getCurrentPosition`. */
export interface GeoRequestOptions {
  enableHighAccuracy?: boolean;
  timeoutMs?: number;
  maximumAgeMs?: number;
}

/**
 * Server → Client. The agent requested the device location; the browser must
 * read `navigator.geolocation` and reply with a ClientLocationResponse (or a
 * ClientLocationError) carrying the same requestId.
 */
export interface ServerLocationRequest extends SessionScoped {
  type: "location_request";
  requestId: string;
  options?: GeoRequestOptions;
}

/** Client → Server. A successful geolocation fix for a location_request. */
export interface ClientLocationResponse {
  type: "location_response";
  requestId: string;
  coords: GeoCoords;
  /** Epoch millis when the fix was taken (GeolocationPosition.timestamp). */
  timestamp: number;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

/**
 * Client → Server. Geolocation failed. `code` mirrors GeolocationPositionError
 * (1 = permission denied, 2 = position unavailable, 3 = timeout); 0 means the
 * API is missing or some other client-side failure.
 */
export interface ClientLocationError {
  type: "location_error";
  requestId: string;
  code: number;
  message: string;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

// ============================================================
// Render endpoint (POST /api/render)
// ============================================================

export type RenderContentType = "markdown" | "html";
export type RenderFormat = "png" | "pdf";

export interface RenderRequest {
  /** Markdown source or full HTML body. */
  content: string;
  contentType: RenderContentType;
  format: RenderFormat;
  /** Optional title — shown in PDF metadata, used for accessibility. */
  title?: string;
}
