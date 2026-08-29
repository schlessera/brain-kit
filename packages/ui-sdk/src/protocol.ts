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
export const PROTOCOL_REV = 3;

/**
 * What each revision added, and what a peer declaring it promises.
 *
 * - **2** — parallel sessions, host-minted `turnId`, `server_hello`.
 * - **3** — the client half: `client_hello`, and `turnId` echoed on every
 *   interactive reply. A client declaring 3 is REQUIRED to echo, which is what
 *   lets a host reject a reply it cannot correlate instead of guessing. A
 *   client that declares nothing is treated as rev 2 and stays tolerated.
 */
export const PROTOCOL_REV_CLIENT_ECHO = 3;

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
  | ClientHello
  | ClientChatMessage
  | ClientToolApproval
  | ClientToolDenial
  | ClientCancelRequest
  | ClientSessionResume
  | ClientAskUserResponse
  | ClientAskUserCancel
  | ClientLocationResponse
  | ClientLocationError
  | ClientMaskResponse
  | ClientMaskError
  | ClientActivitySubscribe
  | ClientActivityUnsubscribe;

/**
 * Client → Server. First frame a client sends after the socket opens (rev 3,
 * additive).
 *
 * The protocol had no client→server handshake, so a host could not tell a
 * current client from one two versions old — which meant no field could ever
 * be made mandatory without breaking the old one. Declaring a revision here is
 * what creates the deprecation window: a host applies rev-3 rules only to
 * clients that say they speak rev 3, and keeps tolerating everyone else.
 *
 * A host must not REQUIRE this frame. Its absence means "rev 2".
 */
export interface ClientHello {
  type: "client_hello";
  protocolRev: number;
  /** Coarse, additive capability flags. */
  capabilities?: Record<string, boolean>;
}

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
  /**
   * Client-minted correlation id for a NEW conversation (rev 2, additive).
   *
   * A client that starts a conversation has no session id yet, so it cannot
   * tell which `session_info` announces ITS turn — it previously adopted the
   * first one that arrived for an unknown session, which could belong to an
   * older background turn or another client entirely. Send an opaque id here
   * and the server echoes it on `session_info`; ignore any frame that does not
   * carry yours. Meaningless on a resumed session, and servers that do not
   * understand it simply omit the echo.
   */
  draftId?: string;
  /**
   * What the reader is holding, measured by the browser. Sent per message
   * rather than once per connection because it genuinely changes mid-session:
   * a phone rotates, a PWA gets installed, a laptop is plugged into a monitor.
   */
  client?: ClientEnvironment;
}

/**
 * Feature-detected client capabilities, reported by the browser.
 *
 * Every field is a detection result, never a user-agent guess. This reaches
 * the agent's system prompt, so it is deliberately a CLOSED shape of enums,
 * booleans and tightly-bounded strings — a free-text field here would be a
 * prompt-injection channel from anything that can open a socket.
 */
export interface ClientEnvironment {
  formFactor: "phone" | "tablet" | "desktop";
  /** Launched from the home screen / app shell rather than a browser tab. */
  standalone?: boolean;
  /** Primary input is a coarse pointer. */
  touch?: boolean;
  /** A camera can be opened (not whether permission was granted). */
  camera?: boolean;
  /** A microphone can be opened — the precondition for voice dictation. */
  microphone?: boolean;
  /** navigator.geolocation exists in a secure context. */
  geolocation?: boolean;
  /** The OS share sheet is reachable (navigator.share). */
  share?: boolean;
  /** The share sheet accepts files, not just text/URLs. */
  shareFiles?: boolean;
  /** CSS pixels across the reading column. */
  viewportWidth?: number;
  /** BCP-47 tag, e.g. "en-GB". */
  locale?: string;
  /** IANA zone, e.g. "Europe/Berlin". */
  timeZone?: string;
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
/**
 * Per-image cap on decoded (not base64) bytes, post-downscale.
 *
 * Mostly governs GIFs. Everything else is downscaled to DOWNSCALE_MAX_EDGE and
 * re-encoded to JPEG client-side, which lands far below this; a GIF passes
 * through untouched so its animation survives, and is only size-checked.
 */
export const MAX_IMAGE_BYTES = 4_000_000;
/**
 * Cap on summed decoded bytes across one message.
 *
 * Bounded by the frame budget rather than by taste: base64 inflates 4/3, so
 * this must stay under MAX_CLIENT_FRAME_BYTES with room for the JSON envelope.
 * 8MB decoded is ~10.7MB encoded against a 12MB frame.
 */
export const MAX_TOTAL_IMAGE_BYTES = 8_000_000;
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
  | ServerLocationRequest
  | ServerMaskRequest
  | ServerActivitySnapshot
  | ServerActivityDelta;

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
  /**
   * Set when this tool call runs INSIDE a subagent (rev 3, additive): the
   * `toolUseId` of the Agent call that spawned the subagent. Clients render
   * such calls nested under that Agent entry rather than at the top level.
   */
  parentToolUseId?: string;
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
  /** See ServerToolUseStart.parentToolUseId (rev 3, additive). */
  parentToolUseId?: string;
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
  /**
   * Token usage for the turn (rev 3, additive). Absent on backends that
   * cannot report it; absent cost inside means "unknown", never zero.
   */
  usage?: TurnUsage;
  /**
   * Finer disposition under `outcome: "error"` (rev 3, additive) — e.g.
   * "timeout" for a max-turns/max-budget stop. A new VALUE here never breaks
   * an old client because the field is free-form and advisory; the precise
   * taxonomy lives in the server's activity record.
   */
  outcomeDetail?: string;
}

/**
 * Per-model token/cost breakdown, mirroring provider accounting. Cumulative
 * for the TURN (not the session); cost only where the backend can price it.
 */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

/** Turn-level usage: totals plus an optional per-model breakdown (rev 3, additive). */
export interface TurnUsage extends ModelUsage {
  perModel?: Record<string, ModelUsage>;
}

/**
 * Fold a per-model breakdown into the turn-level totals. Which fields roll
 * up is part of the wire contract, so the arithmetic lives here beside the
 * types rather than once per backend. Cost is deliberately not summed into
 * the top level — `costUsd` stays whatever the backend's authoritative
 * accounting says (a per-model sum can disagree with it).
 */
export function sumModelUsage(perModel: Record<string, ModelUsage>): TurnUsage {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const usage of Object.values(perModel)) {
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
    totals.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  }
  return { ...totals, perModel };
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
  /**
   * Backend that owns this session (rev 3, additive). Lets the client scope
   * tool-call rendering per backend without deriving it from `providerId`,
   * which fails for profiles the user has since hidden from the picker.
   */
  backendId?: string;
  /**
   * Echo of the `draftId` the client sent on the `chat_message` that started
   * this conversation (rev 2, additive). Absent on a resumed session, and on
   * any turn whose client did not send one.
   */
  draftId?: string;
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
  /**
   * Resolved billing classification for runs on this profile (additive) —
   * declared-credential and settings-override rules already applied. Absent
   * when the host cannot classify the profile.
   */
  billingMode?: BillingMode;
}

// --- Model catalog (HTTP: /api/models) ---

/** One row of the settings-screen model catalog: a profile plus its visibility. */
export interface ModelCatalogEntry extends ProviderInfo {
  /** Hidden profiles are omitted from the picker but still resolve for pinned sessions. */
  hidden: boolean;
  /**
   * Explicit billing override stored for this profile (additive), when one is
   * set. Absent = auto — `billingMode` then reflects the derived
   * classification rather than a user choice.
   */
  billingOverride?: BillingMode;
}

/** Response of GET /api/models, PUT /api/models/hidden, POST /api/models/refresh. */
export interface ModelCatalogResponse {
  /** Every known profile, hidden ones included (each tagged). */
  models: ModelCatalogEntry[];
  /** Stored default-model choice; null = auto. */
  defaultModelId?: string | null;
  /** What the default currently RESOLVES to (stored choice or the auto rule). */
  resolvedDefaultId?: string;
  /** User-managed OpenRouter model ids (Settings → Models). */
  customModels?: string[];
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

/**
 * Body of PUT /api/models/billing — the complete override record, not a
 * delta. A profile absent from the record is "auto" (derived classification).
 */
export interface SetBillingOverridesRequest {
  billing: Record<string, BillingMode>;
}

/** Body of PUT /api/models/default — a profile id, or null for auto. */
export interface SetDefaultModelRequest {
  defaultId: string | null;
}

/** Body of PUT /api/models/custom — the complete OpenRouter list, not a delta. */
export interface SetCustomModelsRequest {
  models: string[];
}

/**
 * Strip a dated snapshot suffix from a model id:
 * `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. The API lists some models
 * only under a dated id; the undated alias is the public name (and the API
 * resolves it back). Shared here so model discovery and pricing canonicalize
 * identically.
 */
export function canonicalModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
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

/**
 * Cap for serving a file, on BOTH paths: the JSON preview and the `?raw=1`
 * byte stream each 413 above it. That includes images and PDFs in the viewer,
 * and the `<img>` sources the chat rewrites to this endpoint.
 */
export const FILE_SIZE_CAP_BYTES = 10_485_760;

export interface WikilinkMapResponse {
  generatedAt: number;
  count: number;
  /** Lowercase slug -> repo-relative .md path. */
  slugs: Record<string, string>;
}

// ============================================================
// Share intake (system share sheet -> staged for the agent)
// ============================================================

/**
 * Staging root for an incoming share, relative to the brain root. Dot-prefixed
 * on purpose: `.brain-ui/` is gitignored in a brain repo and the file browser's
 * walker hides dot-directories, so a staged share is neither committed by a
 * routine `git add -A` nor listed in the file tree before the agent has decided
 * where it belongs. It is not sealed off: an authenticated request that already
 * knows the id can still read the bytes back through the raw file route, which
 * serves them under a `default-src none` CSP.
 */
export const SHARE_STAGING_DIR = ".brain-ui/inbox";

/** Files accepted in a single share. */
export const SHARE_MAX_FILES = 10;

/**
 * Per-file cap. Deliberately larger than FILE_SIZE_CAP_BYTES: staging is a
 * one-off streamed write, not a payload the viewer has to hold in memory.
 */
export const SHARE_MAX_FILE_BYTES = 25_000_000;

/** Cap across every file in one share. */
export const SHARE_MAX_TOTAL_BYTES = 50_000_000;

/** Cap for each of the title/text/url fields, in UTF-8 bytes. */
export const SHARE_MAX_TEXT_BYTES = 200_000;

/**
 * How many staged shares may sit in the inbox at once.
 *
 * The per-file and per-share caps bound one upload; nothing bounds the sum, and
 * filling the volume the brain repo lives on breaks git, the search index and
 * the session store — a far wider blast radius than the inbox itself.
 */
export const SHARE_MAX_STAGED = 50;

/**
 * How many intakes may be staged at once. Each one holds its whole payload in
 * memory while the multipart parser runs, so unbounded concurrency multiplies
 * the per-share cap by however many clients ask at the same time.
 */
export const SHARE_MAX_CONCURRENT_INTAKE = 3;

/**
 * Shared text at or below this length is inlined into the chat prompt; longer
 * text stays in meta.json and the agent reads it from there.
 */
export const SHARE_MAX_INLINE_TEXT = 2_000;

/** How long a staged share survives on the server before it is pruned (7 days). */
export const SHARE_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a share stashed in the BROWSER survives before it is dropped.
 *
 * Same 7 days as the server side, deliberately. A stash is normally a hand-off
 * of a few seconds, which argues for something much shorter — but a share made
 * offline waits in the stash for as long as the device stays offline, and a
 * stash that expires first turns "queued rather than lost" into a lie.
 */
export const SHARE_STASH_TTL_MS = SHARE_STAGING_TTL_MS;

export interface SharedFileMeta {
  /** File name as stored, after sanitizing whatever the sharing app supplied. */
  name: string;
  /** Repo-relative path, e.g. `.brain-ui/inbox/<id>/photo.jpg`. */
  path: string;
  mediaType: string;
  bytes: number;
}

/** Answer to POST /api/share: where the payload was staged. */
export interface ShareIntakeResult {
  /** Server-minted. The client never supplies a path component. */
  id: string;
  /** Repo-relative staging directory. */
  dir: string;
  receivedAt: number;
  title?: string;
  text?: string;
  url?: string;
  files: SharedFileMeta[];
  /**
   * Names the server could not write (a full disk, a filesystem that refused
   * the name). Recorded rather than fatal: one unwritable file must not throw
   * away the rest of the share, and the agent should know something is missing.
   */
  skipped?: string[];
}

/** `meta.json`, written next to the staged files for the agent to read. */
export interface ShareStagingManifest extends ShareIntakeResult {
  source: "web-share-target";
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

/**
 * Server → Client. The agent needs a mask painted over an image before it can
 * edit part of it. The browser opens an editor on `imagePath`, and replies with
 * a ClientMaskResponse (or a ClientMaskError) carrying the same requestId.
 *
 * Same shape as the location bridge, and for the same reason: the information
 * only exists on the client. A mask is a human pointing at a region, and there
 * is no server-side substitute for that.
 */
export interface ServerMaskRequest extends SessionScoped {
  type: "mask_request";
  requestId: string;
  /** Repo-relative path of the image to paint over. */
  imagePath: string;
  /** What the agent intends to change, shown to the user as guidance. */
  instruction?: string;
}

/**
 * Client → Server. The painted mask as a base64 PNG, matching the source
 * image's dimensions, where **fully transparent pixels mark the editable
 * region** — the convention OpenAI's edit endpoint expects, so the bytes can
 * be passed through unmodified.
 */
export interface ClientMaskResponse {
  type: "mask_response";
  requestId: string;
  /** base64-encoded PNG, no data: prefix. */
  maskPng: string;
  turnId?: string;
}

/** Client → Server. The user closed the editor, or it could not run. */
export interface ClientMaskError {
  type: "mask_error";
  requestId: string;
  /** `cancelled` = the user declined; `failed` = the editor could not produce a mask. */
  code: "cancelled" | "failed";
  message: string;
  turnId?: string;
}

// ============================================================
// Graph (HTTP: /api/graph/*)
//
// REST payloads for the knowledge-graph view. The graph itself is derived from
// the wiki-link structure of the brain repo and precomputed into brain.db by
// the `brain` CLI; the server only reads it. Node ids are `documents.id`, which
// makes edges cheap (two integers) and lets clients index nodes by id.
//
// Availability is not guaranteed: a repo indexed by an older CLI has no graph
// tables, and a fresh v8 db has them but empty. Clients read GraphMetaResponse
// first and degrade per `reason`. The neighborhood endpoint is the exception —
// it runs off the raw `links` table and works against any indexed repo.
// ============================================================

/**
 * One node of a graph response. Analytical fields are present only when the
 * mode (and the precomputed tables) supply them, so a neighborhood over an
 * un-precomputed repo still yields usable nodes with degrees of 0.
 */
export interface GraphNodePayload {
  /** `documents.id`. The synthesized root of a virtual-root discovery uses 0. */
  id: number;
  path: string;
  title: string;
  type: string;
  inDegree: number;
  outDegree: number;
  /** Louvain community id; absent until the graph has been computed. */
  community?: number;
  pagerank?: number;
  /** Precomputed cluster-layout coordinates — clusters mode only. */
  x?: number;
  y?: number;
  /** Hops from the root (discovery) or the center (neighborhood). */
  distance?: number;
  /** True for the synthesized root node standing in for an unindexed entry file. */
  virtual?: boolean;
}

/** A directed wiki link between two nodes, by `documents.id`. */
export interface GraphEdgePayload {
  source: number;
  target: number;
}

/** A wiki link whose target resolved to no document — a maintenance finding. */
export interface GraphBrokenLink {
  sourcePath: string;
  /** The unresolved link text, as written in the source note. */
  target: string;
}

export interface GraphCommunityPayload {
  community: number;
  size: number;
  label: string | null;
  topTerms: string[];
}

/**
 * Response of GET /graph/meta — whether a graph is available, how fresh it is,
 * and the legend/root data every mode needs before it fetches a subgraph.
 */
export interface GraphMetaResponse {
  available: boolean;
  /**
   * Why the graph is unavailable. "schema" = the repo was indexed by a CLI
   * older than schema v8; "not_computed" = the tables exist but no index run
   * has filled them yet.
   */
  reason?: "schema" | "not_computed";
  schemaVersion: number;
  computedAt: string | null;
  /** The graph predates the newest index run — recompute to refresh it. */
  stale: boolean;
  nodeCount: number;
  edgeCount: number;
  communities: GraphCommunityPayload[];
  defaultRoot: { path: string; virtual: boolean } | null;
  /** The corpus exceeded the layout cap, so clusters carry no x/y. */
  layoutSkipped?: boolean;
}

/** Shared response of the clusters / neighborhood / discovery endpoints. */
export interface GraphSubgraphResponse {
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
  /** A server cap dropped the lowest-ranked nodes or edges from this response. */
  truncated: boolean;
  /**
   * Notes reachable from the root, counted over the WHOLE graph — discovery
   * only. This is deliberately not derivable from `nodes`, which holds just the
   * scene: a depth-limited or truncated response shows fewer notes than the
   * root actually reaches, and a virtual root contributes a node that is no
   * document. Both counts cover documents only, and are omitted when no root
   * was resolved (nothing to be reachable from).
   */
  reachableCount?: number;
  /** Notes the root reaches by no path at all — discovery only. */
  unreachableCount?: number;
}

export interface GraphMaintenanceResponse {
  /** Markdown notes with no links in or out. */
  orphans: GraphNodePayload[];
  /** Notes not reachable from the graph root. */
  unreachable: GraphNodePayload[];
  brokenLinks: GraphBrokenLink[];
  /** Notes untouched for longer than `staleDays`, oldest first. */
  stale: (GraphNodePayload & { updated: string })[];
  staleDays: number;
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

// ============================================================
// Activity stream (rev 3, additive)
// ============================================================
//
// The live face of the server's activity record: spans (turn / tool /
// subagent / cron) forming a tree per run, streamed snapshot-then-delta.
// View-scoped by subscription — a server never sends activity frames to a
// connection that has not subscribed, and `server_hello` advertises
// `capabilities.activity` so clients know whether subscribing is worthwhile.
//
// Ordering contract (AE6): a snapshot carries the run's high-water `seq`;
// every delta carries its `seq`; the client DISCARDS any delta at or below
// the snapshot's high-water for that run. Deltas are append-only increments —
// a span-state delta carries the span's current (small) row, an event delta
// carries exactly one new event — so no delta grows with run length.

/** What a subscription watches. `index` = all runs; others narrow. */
export type ActivityView = "index" | "session" | "run";

export interface ClientActivitySubscribe {
  type: "activity_subscribe";
  view: ActivityView;
  /** Required when `view` is "session". */
  sessionId?: string;
  /** Required when `view` is "run". */
  runId?: string;
}

export interface ClientActivityUnsubscribe {
  type: "activity_unsubscribe";
  view: ActivityView;
  sessionId?: string;
  runId?: string;
}

export type ActivitySpanKind = "turn" | "tool" | "subagent" | "cron";
export type ActivitySpanOrigin = "session" | "cron";
/**
 * Terminal dispositions. `denied` is an approval declined by the user —
 * distinct from `error` by design. `interrupted` means a process died with
 * the span open (assigned only by server-side sweepers).
 */
export type ActivitySpanOutcome =
  | "success"
  | "error"
  | "timeout"
  | "cancelled"
  | "denied"
  | "interrupted";

/**
 * THE failure predicate for the outcome taxonomy — one definition, imported
 * by server aggregation and client rendering alike (it was independently
 * re-decided at seven call sites during development, with three different
 * answers). `cancelled` and `denied` are user decisions, not failures;
 * `interrupted` is a failure — the work did not finish and nobody chose that.
 */
export function isFailureOutcome(outcome: ActivitySpanOutcome | string | null | undefined): boolean {
  return outcome === "error" || outcome === "timeout" || outcome === "interrupted";
}

/**
 * The span-naming convention (OTel GenAI operation names), shared by every
 * producer and un-parser: the recorder and span-sink write these names, the
 * server stream and the client's span labels parse them back out. One
 * definition — the convention was independently restated in three files.
 */
export const SPAN_OP_EXECUTE_TOOL = "execute_tool";
export const SPAN_OP_INVOKE_AGENT = "invoke_agent";
/** A tool span's name is `execute_tool <toolName>`; slice this off to get the tool. */
export const SPAN_TOOL_NAME_PREFIX = `${SPAN_OP_EXECUTE_TOOL} `;

/** One span as it crosses the wire. Field names track the OTel GenAI shape. */
export interface ActivitySpan {
  spanId: string;
  runId: string;
  parentSpanId?: string;
  name: string;
  /**
   * The bare tool name for tool/subagent spans ("Read", "Agent"), lifted
   * out of `name` server-side so clients never parse the span-naming
   * convention.
   */
  toolName?: string;
  kind: ActivitySpanKind;
  origin: ActivitySpanOrigin;
  sessionId?: string;
  jobName?: string;
  startedAt: number;
  /** Approval-wait boundary: time before this was waiting, not executing. */
  waitUntil?: number;
  endedAt?: number;
  outcome?: ActivitySpanOutcome;
  outcomeReason?: string;
  usage?: ModelUsage & { model?: string };
  /**
   * Typed subagent enrichment for kind "subagent" spans. Promoted onto the
   * wire so clients depend on a contract, not on server-minted attr keys.
   */
  subagent?: {
    type?: string;
    description?: string;
    summary?: string;
    totalTokens?: number;
  };
  attrs?: Record<string, unknown>;
}

/** One append-only span event (transcript excerpt, progress note). */
export interface ActivitySpanEvent {
  spanId: string;
  eventIndex: number;
  ts: number;
  eventType: string;
  payload?: unknown;
  /** The stored payload was capped at persist time. */
  truncated?: boolean;
}

/**
 * Snapshot answering a subscribe. Run/session views carry the full span tree
 * and events (chunked via `append` like `session_history`); the index view
 * carries open root spans only — history comes from the REST activity API.
 */
export interface ServerActivitySnapshot {
  type: "activity_snapshot";
  view: ActivityView;
  sessionId?: string;
  runId?: string;
  spans: ActivitySpan[];
  events: ActivitySpanEvent[];
  /** Per-run high-water seq at snapshot time, keyed by runId. */
  highWaterSeq: Record<string, number>;
  /** True when this frame continues the previous snapshot frame. */
  append?: boolean;
}

/** One committed change. Exactly one of `span` / `event` is present. */
export interface ServerActivityDelta {
  type: "activity_delta";
  runId: string;
  seq: number;
  span?: ActivitySpan;
  event?: ActivitySpanEvent;
}

// ============================================================
// Activity REST contract (GET/POST /api/activity/*, /api/push/*)
// ============================================================
//
// The HTTP half of the activity contract, beside its WS half above — shared
// types live here per repo convention, never re-declared in a client.

/**
 * How a run's inference was billed: `subscription` (a seat plan — marginal
 * cost genuinely $0) or `api` (pay-as-you-go at list price). Resolved once
 * at run start from the run's inference profile; absent means unknown.
 */
export type BillingMode = "subscription" | "api";

/** THE membership check for {@link BillingMode} — one definition for every
 *  boundary that validates an untrusted value (settings rows, request bodies,
 *  span attrs). */
export function isBillingMode(v: unknown): v is BillingMode {
  return v === "subscription" || v === "api";
}

export interface ActivityRunSummary {
  runId: string;
  origin: ActivitySpanOrigin;
  name: string;
  sessionId: string | null;
  jobName: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: ActivitySpanOutcome | null;
  running: boolean;
  durationMs: number | null;
  /** List-price cost as the backend reported it. NULL = unknown, never $0. */
  costUsd: number | null;
  /**
   * What the run actually cost (additive) — $0 for subscription-billed work,
   * list price for API-billed. NULL/absent = unknown, 0 = genuinely free;
   * frozen at first rollup, so later pricing-table changes never rewrite it.
   */
  effectiveCostUsd?: number | null;
  /** Billing classification behind `effectiveCostUsd`; absent = unknown. */
  billingMode?: BillingMode;
  /** True when the effective cost was computed from estimated rates. */
  pricingEstimate?: boolean;
  failureReason: string | null;
  detailPruned: boolean;
}

export interface ActivityRunRollup {
  origin: string;
  name: string;
  sessionId: string | null;
  jobName: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: ActivitySpanOutcome | null;
  durationMs: number | null;
  spanCount: number;
  /** List-price cost as the backend reported it. NULL = unknown, never $0. */
  costUsd: number | null;
  /** Effective cost (additive) — same semantics as `ActivityRunSummary`. */
  effectiveCostUsd?: number | null;
  /** Billing classification behind `effectiveCostUsd`; absent = unknown. */
  billingMode?: BillingMode;
  /** True when the effective cost was computed from estimated rates. */
  pricingEstimate?: boolean;
  failureReason: string | null;
}

export interface ActivityRunDetail {
  runId: string;
  detailPruned: boolean;
  spans?: ActivitySpan[];
  events?: ActivitySpanEvent[];
  highWaterSeq?: number;
  rollup?: ActivityRunRollup;
}

export interface ActivityAggregate {
  runs: number;
  failures: number;
  /**
   * Sum of KNOWN list-price costs. Unknown-cost runs simply contribute
   * nothing — no accompanying unknown count exists for this field (only
   * `effectiveCostUsd` has `unpricedRuns`), so read it as a floor.
   */
  costUsd: number;
  /**
   * Sum of KNOWN effective costs; the excluded runs are `unpricedRuns`.
   * Optional on the wire (additive — a pre-pricing server omits it); the
   * current server always emits both.
   */
  effectiveCostUsd?: number;
  /** Runs with unknown effective cost — render "≥ $X · N unpriced" when nonzero. */
  unpricedRuns?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
}

export interface ActivityRollups {
  timeZone: string;
  days: Array<ActivityAggregate & { day: string }>;
  jobs: Array<ActivityAggregate & { jobName: string }>;
  sessions: Array<ActivityAggregate & { sessionId: string }>;
}

/** The while-you-were-away digest (see the ui-server digest job). */
export interface ActivityDigest {
  generatedAt: number;
  windowStart: number;
  windowEnd: number;
  runs: number;
  failures: number;
  /**
   * Sum of KNOWN list-price costs. Unknown-cost runs simply contribute
   * nothing — no accompanying unknown count exists for this field (only
   * `effectiveCostUsd` has `unpricedRuns`), so read it as a floor.
   */
  costUsd: number;
  /** Sum of KNOWN effective costs (additive — absent on digests persisted before pricing shipped). */
  effectiveCostUsd?: number;
  /** Runs with unknown effective cost in the window (additive, same vintage). */
  unpricedRuns?: number;
  inputTokens: number;
  outputTokens: number;
  notable: Array<{
    runId: string;
    name: string;
    jobName: string | null;
    sessionId: string | null;
    outcome: ActivitySpanOutcome | null;
    failureReason: string | null;
    startedAt: number;
  }>;
}

/** One notification intent, as the inbox lists it. */
export interface ActivityIntent {
  id: number;
  runId: string;
  spanId: string | null;
  kind: "failure" | "completion" | "stuck";
  tag: string;
  title: string;
  body: string;
  status: "pending" | "sent" | "send_failed" | "suppressed";
  acknowledged: boolean;
  createdAt: number;
}
