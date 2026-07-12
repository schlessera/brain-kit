// ============================================================
// brainform chat-UI wire protocol
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
// ============================================================

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
}

export interface ClientToolDenial {
  type: "tool_denial";
  toolUseId: string;
  message: string;
}

export interface ClientCancelRequest {
  type: "cancel";
}

export interface ClientSessionResume {
  type: "session_resume";
  sessionId: string;
}

// --- Server -> Client ---

export type ServerMessage =
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

export interface ServerSessionHistory {
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

export interface ServerTextDelta {
  type: "text_delta";
  text: string;
}

export interface ServerThinkingDelta {
  type: "thinking_delta";
  text: string;
}

export interface ServerToolUseStart {
  type: "tool_use_start";
  toolUseId: string;
  toolName: string;
}

export interface ServerToolInputDelta {
  type: "tool_input_delta";
  toolUseId: string;
  partialJson: string;
}

export interface ServerToolUseComplete {
  type: "tool_use_complete";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ServerToolResult {
  type: "tool_result";
  toolUseId: string;
  output: string;
  isError: boolean;
}

export interface ServerToolApprovalRequest {
  type: "tool_approval_request";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}

export interface ServerResultMessage {
  type: "result";
  sessionId: string;
  /** 0 when the backend cannot report cost (capabilities.costReporting=false). */
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export interface ServerError {
  type: "error";
  code: string;
  message: string;
}

export interface ServerStatus {
  type: "status";
  status: "thinking" | "tool_executing" | "idle" | "cancelled";
  detail?: string;
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
}

// --- Shared Types ---

export interface ChatSession {
  id: string;
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
  totalCostUsd: number;
  numTurns: number;
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
export interface ServerAskUserRequest {
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
}

/** Client → Server. User dismissed the ask-user prompt; the agent gets an error. */
export interface ClientAskUserCancel {
  type: "ask_user_cancel";
  requestId: string;
  reason?: string;
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
export interface ServerLocationRequest {
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
