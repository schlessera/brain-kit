// ============================================================
// brain-kit chat-UI wire protocol
//
// Shared between the brain-ui server and client, and implemented by every
// AgentBackend. This protocol is a COMPATIBILITY CONTRACT (see
// docs/integration-contract.md): it is not pluggable, message types are only
// ever added, and fields are only ever added optionally. It descends from
// the chat UI's original protocol, with two deliberate cleanups:
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
import type { ImportedTrack, TrackFormat, TrackSummary } from "@schlessera/brain-geo";
import type { AskUserFormSpec } from "./tool-contracts/form.js";
import type { Block } from "./tool-contracts/blocks.js";

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
export const PROTOCOL_REV = 5;

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
 * Rev 5 (#910): ask answers carry a `submissionId`, and the host acknowledges
 * each one with an `ask_answer_receipt`. Liveness probes (`ping`/`pong`) come
 * with it.
 *
 * Unlike rev 3's echo, this is NOT negotiated per connection. A host that
 * advertises {@link ASK_RECEIPTS_CAPABILITY} refuses EVERY ask answer without a
 * `submissionId`, whatever revision the client declared. The refusal is an
 * `error` frame with {@link ASK_ANSWER_UPDATE_REQUIRED}, and the tool is not
 * settled. A client must not submit an ask answer to a host that does not
 * advertise the capability; it shows an update-required state instead. This
 * break is scoped to the four ask answers: every other frame keeps its
 * tolerance (docs/integration-contract.md, "Interactive answer receipts").
 */
export const PROTOCOL_REV_ASK_RECEIPTS = 5;

/** `server_hello`/`client_hello` capability: ask answers use receipts. */
export const ASK_RECEIPTS_CAPABILITY = "askReceipts";

/** `server_hello` capability: the host answers `ping` with `pong`. */
export const LIVENESS_CAPABILITY = "liveness";

/**
 * `server_hello`/`client_hello` capability (additive, #1002): the host sends
 * `session_queue` frames, and only to connections that declared the flag.
 */
export const FOLLOW_UP_QUEUE_CAPABILITY = "followUpQueue";

/** `error.code` for an ask answer the host refused because it carried no `submissionId`. */
export const ASK_ANSWER_UPDATE_REQUIRED = "ASK_ANSWER_UPDATE_REQUIRED";

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
  | ClientRetryTurn
  | ClientRetryStatus
  | ClientChatMessage
  | ClientToolApproval
  | ClientToolDenial
  | ClientCancelRequest
  | ClientSessionResume
  | ClientAskUserResponse
  | ClientAskUserCancel
  | ClientAskUserListResponse
  | ClientAskUserRankResponse
  | ClientAskUserFormResponse
  | ClientAskAnswerStatus
  | ClientPing
  | ClientLocationResponse
  | ClientLocationError
  | ClientMaskResponse
  | ClientMaskError
  | ClientActivitySubscribe
  | ClientActivityUnsubscribe
  | ClientLocalExchange
  | ClientHandoffPrepare
  | ClientHandoffPrepareCancel
  | ClientHandoffStatus
  | ClientInboxResolve
  | ClientInboxSnooze
  | ClientInboxSubscribe
  | ClientInboxUnsubscribe
  | ClientConversationStart
  | ClientConversationAudio
  | ClientConversationEndpoint
  | ClientConversationCommit
  | ClientConversationPlayback
  | ClientConversationStop;

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
  /** Coarse, additive capability flags. `toolResolution: true` asks for
   * `tool_resolution` frames; a client that omits it never receives one. */
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
  /** Server validates these staged file references and derives their measurements. */
  files?: ChatFileAttachment[];
  /** Reasoning effort for this message only; absent uses the current profile default. */
  thinkingLevel?: ThinkingLevel;
  /** Correlates acceptance/refusal of this message, including queued follow-ups. */
  requestId?: string;
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
  /**
   * How the user produced this message (additive). The host keeps it beside
   * the session and returns it on the replayed message, so a dictated
   * message still reads as dictated after a reload or on another device.
   * Absent means `typed`, which is what every older client meant.
   */
  source?: MessageSource;
  /**
   * Locally answered commands the user ran in this conversation before it
   * had a session (additive). Only meaningful on a message that starts a
   * new conversation: the host records them against the session this
   * message creates and gives the agent their `context` with this prompt.
   * An existing session records them with `local_exchange` instead.
   */
  localExchanges?: LocalExchange[];
  /**
   * Start this NEW conversation as a handoff from another session (additive;
   * #61). `text` is the reviewed summary, at most `HANDOFF_MAX_CHARS`; the
   * host appends the references block (`composeHandoffText`), so the first
   * user message is exactly the reviewed text plus its references. Refused
   * on a message that names a `sessionId`.
   */
  handoff?: HandoffRequest;
  /**
   * The saved composer draft this message was sent from (additive; #979).
   * When the host accepts the message (`session_info` for its turn, or
   * `status: queued`), it deletes that draft only if `revision` is still the
   * draft's current revision and the draft belongs to this message's
   * session (or is unbound, for a new conversation). Edits saved after
   * submitting are a later revision and survive. Ignored by hosts that do
   * not advertise `capabilities.sessionDrafts`, and on a `handoff` message,
   * whose text is a reviewed summary rather than a composer draft.
   */
  draftRef?: DraftRef;
}

/** Most characters a reviewed handoff summary may carry (#61). */
export const HANDOFF_MAX_CHARS = 4000;
/** Most brain files a handoff may reference (#61). */
export const HANDOFF_MAX_REFERENCES = 8;
/** Settled messages the deterministic fallback draft is built from (#61). */
export const HANDOFF_DRAFT_MESSAGES = 6;
/** The heading that opens a handoff's references block in its first message. */
export const HANDOFF_REFERENCES_HEADING = "References:";

/**
 * A new session seeded from another one (#61). `handoffId` is minted by the
 * client once per review and is the idempotency key: a host that already
 * created the destination for it returns that session instead of a second.
 */
export interface HandoffRequest {
  handoffId: string;
  sourceSessionId: string;
  /** Brain-relative file paths the host checks and lists after the text. */
  references: string[];
}

/**
 * The first user message of a handoff destination: the reviewed summary,
 * then one `- path` line per reference under `HANDOFF_REFERENCES_HEADING`.
 * Shared so the host that writes it and the client that draws it as a card
 * cannot disagree about its shape.
 */
export function composeHandoffText(summary: string, references: readonly string[]): string {
  if (references.length === 0) return summary;
  return `${summary}\n\n${HANDOFF_REFERENCES_HEADING}\n${references.map((path) => `- ${path}`).join("\n")}`;
}

/** Split a handoff message back into its summary and references. */
export function parseHandoffText(text: string): { summary: string; references: string[] } {
  const marker = `\n\n${HANDOFF_REFERENCES_HEADING}\n`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return { summary: text, references: [] };
  const lines = text.slice(at + marker.length).split("\n");
  if (!lines.every((line) => line.startsWith("- ") && line.length > 2)) return { summary: text, references: [] };
  return { summary: text.slice(0, at), references: lines.map((line) => line.slice(2)) };
}

/**
 * Client → Server. Draft a handoff summary with a model on the source
 * session's own backend (additive; #61). One run, attributed to the source
 * session; the host answers with `handoff_draft`.
 */
export interface ClientHandoffPrepare {
  type: "handoff_prepare";
  /** Names this run; its `handoff_draft` carries it back. Mint one per run. */
  handoffId: string;
  sourceSessionId: string;
  /**
   * The snapshot boundary, in turns: summarize the replayed history up to,
   * not including, its (turns + 1)th user message. Counted in user messages
   * because a live client and a replay may group one reply's steps into a
   * different number of assistant messages.
   */
  turns: number;
}

/** Client → Server. Stop a running `handoff_prepare` (additive; #61). */
export interface ClientHandoffPrepareCancel {
  type: "handoff_prepare_cancel";
  handoffId: string;
}

/**
 * Client → Server. Ask what became of a handoff without creating anything
 * (additive; #61). Answered with `handoff_receipt`.
 */
export interface ClientHandoffStatus {
  type: "handoff_status";
  handoffId: string;
}

/**
 * Server → Client. The outcome of `handoff_prepare` (additive; #61).
 * `ready` carries the model's summary, at most `HANDOFF_MAX_CHARS`;
 * `failed` and `cancelled` carry none, and the client falls back to its
 * deterministic draft. `costUsd` is absent when the cost is unknown.
 */
export interface ServerHandoffDraft {
  type: "handoff_draft";
  handoffId: string;
  state: "ready" | "failed" | "cancelled";
  text?: string;
  message?: string;
  /** The Activity run that drafted it, on the source session. */
  runId?: string;
  costUsd?: number;
}

/**
 * Server → Client. What the host knows about a handoff (additive; #61).
 * `created` names the destination session; `pending` means a creation is in
 * flight and has no session yet; `none` means nothing was created for it.
 */
export interface ServerHandoffReceipt {
  type: "handoff_receipt";
  handoffId: string;
  state: "created" | "pending" | "none";
  sessionId?: string;
}

/**
 * A command the client answered itself, without a turn (`/stats`), kept as
 * part of the session (additive; #582). The host stores it beside the
 * session, gives the agent `context` with the session's next prompt, and
 * replays the exchange at that position as a `prompt` user message and an
 * assistant message carrying `localAnswer`.
 */
export interface LocalExchange {
  /** Client-minted, unique within the session. Letters, digits, `-` and `_`. */
  id: string;
  /** The command that produced it, e.g. `stats`. Lowercase, digits and `-`. */
  command: string;
  /** What the transcript shows as the user's side of the exchange, e.g. `Stats`. */
  prompt: string;
  /**
   * What the client drew, as JSON the command owns. The host stores and
   * replays it without reading it; a client that does not know the command
   * ignores it.
   */
  answer: unknown;
  /**
   * The same figures as plain text, for the agent. It reaches the model, so
   * it is bounded and may not contain {@link LOCAL_ANSWER_CLOSE}.
   */
  context: string;
}

/** Client → Server. Record a locally answered command against an existing session (additive; #582). */
export interface ClientLocalExchange {
  type: "local_exchange";
  sessionId: string;
  exchange: LocalExchange;
}

/** Cap on `LocalExchange.context`, in characters. */
export const MAX_LOCAL_CONTEXT_CHARS = 4_000;
/** Cap on the serialized `LocalExchange.answer`, in characters. */
export const MAX_LOCAL_ANSWER_CHARS = 64_000;
/** Cap on `ClientChatMessage.localExchanges`. */
export const MAX_LOCAL_EXCHANGES_PER_MESSAGE = 8;
/**
 * The line that closes the block a local exchange's context travels in on
 * the prompt. The host finds and strips the block on replay by it, so a
 * context may never contain it.
 */
export const LOCAL_ANSWER_CLOSE = "</local-answer>";

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

// ============================================================
// Session drafts (additive; #979, design D52 §5–6)
// ============================================================

/**
 * Host draft storage bounds, advertised as `server_hello.sessionDraftLimits`
 * beside `capabilities.sessionDrafts: true`. Byte counts are UTF-8 text plus
 * decoded attachment bytes. The existing per-image bounds
 * (`ALLOWED_IMAGE_MEDIA_TYPES`, `MAX_IMAGES_PER_MESSAGE`, `MAX_IMAGE_BYTES`,
 * `MAX_TOTAL_IMAGE_BYTES`) apply to a draft's attachments as well.
 */
export interface SessionDraftLimits {
  /** Most UTF-8 bytes of draft text. */
  maxTextBytes: number;
  /** Most bytes in one draft, text and attachments together. */
  maxDraftBytes: number;
  /** Most live (not deleted) drafts one host keeps. */
  maxDrafts: number;
  /** Most bytes of draft text and attachments one host keeps. */
  maxTotalBytes: number;
}

/** The limits a host ships with (the #943 R2 ruling). */
export const SESSION_DRAFT_LIMITS: Readonly<SessionDraftLimits> = Object.freeze({
  maxTextBytes: 65_536,
  maxDraftBytes: 8_388_608,
  maxDrafts: 100,
  maxTotalBytes: 268_435_456,
});

/** Names one saved revision of one draft. */
export interface DraftRef {
  draftId: string;
  revision: number;
}

/** One row of `GET /api/drafts`. */
export interface DraftSummary {
  draftId: string;
  /** The session the draft belongs to; null for a draft with no session yet. */
  sessionId: string | null;
  revision: number;
  /** Milliseconds since epoch of the last saved change. */
  updatedAt: number;
  /** The first non-empty line of the text, at most `DRAFT_PREVIEW_CHARS`. */
  preview: string;
  attachmentCount: number;
}

/** Characters a `DraftSummary.preview` carries at most. */
export const DRAFT_PREVIEW_CHARS = 200;

/** One stored draft image. */
export interface DraftAttachment {
  attachmentId: string;
  mime: (typeof ALLOWED_IMAGE_MEDIA_TYPES)[number];
  /** The decoded image bytes, base64-encoded without a `data:` prefix. */
  bytes: string;
  /** The name the uploader gave, or null. */
  name: string | null;
}

/** `GET /api/drafts/:draftId`, and the `current` of a `DRAFT_CONFLICT`. */
export interface Draft {
  draftId: string;
  sessionId: string | null;
  revision: number;
  updatedAt: number;
  text: string;
  /** In the order the saved revision lists them. */
  attachments: DraftAttachment[];
}

export interface DraftListResponse {
  /** Every live draft, newest change first; bounded by `maxDrafts`. */
  drafts: DraftSummary[];
}

/** Body of `PUT /api/drafts/:draftId` (headers `If-Match`, `Idempotency-Key`). */
export interface DraftSaveRequest {
  sessionId: string | null;
  text: string;
  /** Attachments uploaded to this draft, in display order. */
  attachmentIds: string[];
}

export interface DraftSaveResponse {
  revision: number;
  updatedAt: number;
}

/** `POST /api/drafts/:draftId/attachments` (raw image bytes, `Idempotency-Key`). */
export interface DraftAttachmentResponse {
  attachmentId: string;
}

/** Body of `POST /api/drafts/:draftId/bind`. */
export interface DraftBindRequest {
  sessionId: string;
  /** The `requestId` of the accepted first message of that session. */
  requestId: string;
}

export interface DraftBindResponse {
  revision: number;
}

/** Machine codes in the `error` field of a draft route's failure body. */
export type DraftErrorCode =
  | "DRAFT_CONFLICT"
  | "DRAFT_DELETED"
  | "DRAFT_TOO_LARGE"
  | "DRAFT_CAPACITY"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_INVALID"
  | "DRAFT_PRECONDITION_REQUIRED"
  | "DRAFT_KEY_REUSED"
  | "DRAFT_NOT_ACCEPTED";

/** A draft route's failure body, discriminated by `error`. */
export type DraftErrorResponse =
  /** 409: the draft changed; `current` is the host's version. */
  | { error: "DRAFT_CONFLICT"; message: string; current: Draft }
  /** 410: deleted or sent; save the local content as a new draft. */
  | { error: "DRAFT_DELETED"; message: string; tombstoneRevision: number }
  /** 413: over `limit` (`bound` names which). Nothing was stored. */
  | { error: "DRAFT_TOO_LARGE"; message: string; limit: number; bound: "text" | "draft" | "image" | "images" | "imageCount" }
  /** 507: the host holds `limit` drafts or bytes already. Nothing was stored. */
  | { error: "DRAFT_CAPACITY"; message: string; limit: number; bound: "drafts" | "total" }
  | { error: "DRAFT_NOT_FOUND"; message: string }
  | { error: "DRAFT_INVALID"; message: string }
  /** 428: `If-Match` is missing. */
  | { error: "DRAFT_PRECONDITION_REQUIRED"; message: string }
  /** 409: this `Idempotency-Key` already named a different request. */
  | { error: "DRAFT_KEY_REUSED"; message: string }
  /** 409: no accepted message of that session carried this draft and request. */
  | { error: "DRAFT_NOT_ACCEPTED"; message: string };

// ============================================================
// Session recovery (additive; #964, design D52 §4 and §6)
// ============================================================

/**
 * `server_hello` capability: the host answers
 * `GET /api/sessions/:id/recovery` with a {@link SessionRecovery}, and its
 * replayed history may carry a host-proven `SessionHistoryMessage.turnId`.
 * A client reads the route only when this is advertised as `true`.
 */
export const SESSION_RECOVERY_CAPABILITY = "sessionRecovery";

/** Where the latest accepted request of a session stands, as the host can prove it. */
export type SessionRecoveryState = "queued" | "running" | "terminal" | "unknown";

/** The interaction kinds a recovery envelope can list as pending. */
export type SessionRecoveryPendingKind =
  | "approval"
  | "ask_user"
  | "ask_user_list"
  | "ask_user_rank"
  | "ask_user_form";

export interface SessionRecoveryLatest {
  /** The client's `chat_message.requestId`, when it sent one. */
  requestId: string | null;
  /** The host turn that runs the request; null until a queued request is dispatched. */
  turnId: string | null;
  /**
   * `queued`: accepted, not dispatched. `running`: its turn is executing in
   * this host process. `terminal`: the Activity record holds its outcome.
   * `unknown`: the read succeeded but the host cannot prove more, for example
   * after a restart lost the queue, for imported history, or when Activity
   * holds no outcome for the turn.
   */
  state: SessionRecoveryState;
  /** The Activity outcome; non-null exactly when `state` is `terminal`. */
  outcome: ActivitySpanOutcome | null;
  /** Host clock, milliseconds since epoch, when the turn started; null while unknown. */
  startedAt: number | null;
  /** Host clock when the turn ended; non-null only when `state` is `terminal`. */
  endedAt: number | null;
}

/**
 * One interaction waiting on a person. The identities are the original
 * ones; the payload rehydrates through the existing scoped interaction
 * frames. Listing one grants nothing.
 */
export interface SessionRecoveryPending {
  kind: SessionRecoveryPendingKind;
  /** The approval's `toolUseId`, or the ask's `requestId`. */
  requestId: string;
  /** The turn that raised it, which may be older than `latest.turnId`. */
  turnId: string;
}

/** `GET /api/sessions/:id/recovery` (additive; #964). Read-only. */
export interface SessionRecovery {
  sessionId: string;
  backendId: string | null;
  /**
   * The host's persisted accepted-work ordering for this session: it grows
   * by one each time the host accepts a request. 0 means the host has no
   * acceptance on record. A lower value than one already seen is a rollback.
   */
  revision: number;
  latest: SessionRecoveryLatest;
  pending: SessionRecoveryPending[];
}

/** The `error` code of a recovery read for a session the host does not know. */
export const SESSION_NOT_FOUND = "SESSION_NOT_FOUND";

/** The `error` code of a recovery read the host could not complete. */
export const SESSION_RECOVERY_FAILED = "SESSION_RECOVERY_FAILED";

/**
 * Why a recovery read gave no envelope, as D52 §6 maps the response:
 * 401/403 → `unauthorized`; 404 `SESSION_NOT_FOUND` → `session_not_found`;
 * any other 404 → `host_too_old`; 5xx, a network failure or an unreadable
 * body → `host_unreachable`.
 */
export type SessionRecoveryUnavailable =
  | "unauthorized"
  | "session_not_found"
  | "host_too_old"
  | "host_unreachable";

export type SessionRecoveryResult =
  | { ok: true; recovery: SessionRecovery }
  | { ok: false; reason: SessionRecoveryUnavailable };

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

/**
 * How an approval decision reached the host (additive): "card" — a person on
 * an approval card (a click or its keys); "voice" — a phrase a microphone
 * heard. Absent means a client that does not say, which is every decision
 * made before the field existed. The host refuses a voice-attributed grant
 * (docs/decisions/voice-permission.md: voice may deny, never grant) and
 * records the channel on the `approval_decision` activity event.
 */
export type ApprovalChannel = "card" | "voice";

export interface ClientToolApproval {
  type: "tool_approval";
  toolUseId: string;
  updatedInput?: Record<string, unknown>;
  /**
   * Also remember this tool as auto-allowed: the host stores the tool name
   * and answers future requests for it without a card (additive; ignored for
   * kind "command" requests, which stay per-use).
   */
  always?: boolean;
  /** The channel the grant was made on. "voice" is refused by the host. */
  channel?: ApprovalChannel;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

export interface ClientToolDenial {
  type: "tool_denial";
  toolUseId: string;
  message: string;
  /** The channel the denial was made on; any channel may deny. */
  channel?: ApprovalChannel;
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

/** Exact retry of a host-retained failed request. A repeated requestId never starts another turn. */
export interface ClientRetryTurn {
  type: "retry_turn";
  sessionId: string;
  failedTurnId: string;
  requestId: string;
}

/** Reconcile delivery without submitting another turn. */
export interface ClientRetryStatus {
  type: "retry_status";
  sessionId: string;
  requestId: string;
}

export interface ServerRetryReceipt extends SessionScoped {
  sessionId: string;
  type: "retry_receipt";
  requestId: string;
  state: "accepted" | "refused" | "unknown";
  /** Neutral refusal or reconciliation guidance; inert text. */
  message?: string;
  /** Original user text for the accepted new turn's local row. */
  text?: string;
  files?: SharedFileMeta[];
  attachmentCount?: number;
  source?: MessageSource;
  thinkingLevel?: ThinkingLevel;
}

// --- Server -> Client ---

export type ServerMessage =
  | ServerHello
  | ServerRetryReceipt
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
  | ServerAskUserListRequest
  | ServerAskUserRankRequest
  | ServerAskUserFormRequest
  | ServerAskAnswerReceipt
  | ServerPong
  | ServerLocationRequest
  | ServerMaskRequest
  | ServerActivitySnapshot
  | ServerActivityDelta
  | ServerMessageBlocks
  | ServerLocalExchangeResult
  | ServerHandoffDraft
  | ServerHandoffReceipt
  | InboxSnapshot
  | InboxDelta
  | ServerToolResolution
  | ServerSessionQueue
  | ServerConversationOpened
  | ServerConversationClosed
  | ServerConversationEvent
  | ServerConversationWork
  | ServerConversationOutput
  | ServerConversationPermission;

/**
 * First frame a server sends after a socket opens (rev 2, additive). Clients
 * that don't know it ignore it; clients that do can gate behavior on
 * `protocolRev` and the coarse capability flags instead of sniffing.
 * Capabilities gate their documented opt-in features. Servers must not gate
 * existing chat flow on the client having seen this frame.
 */
export interface ServerHello {
  type: "server_hello";
  protocolRev: number;
  /**
   * Rev 5 (#910): an opaque, stable key for the principal this connection
   * authenticated as. A client files queued ask answers under it and never
   * replays one over a connection with a different key. It identifies
   * nothing by itself.
   */
  principalKey?: string;
  /** Coarse, additive flags. `inbox: true` advertises durable Queue/Actions;
   * absent/false means unsupported. Delivery still requires `inbox_subscribe`.
   * `toolResolution: true` offers `tool_resolution` to clients that declare
   * the same flag; `liveConversation: true` means a conversation provider is
   * registered and the `conversation_*` frames are accepted.
   * `sessionDrafts: true` means the `/api/drafts` routes store drafts;
   * `sessionDraftLimits` then carries their bounds. `sessionRecovery: true`
   * means `GET /api/sessions/:id/recovery` answers (#964). */
  capabilities?: Record<string, boolean>;
  /**
   * Draft storage bounds (additive; #979). Present exactly when
   * `capabilities.sessionDrafts` is true. A separate field because
   * `capabilities` values are booleans on every shipped client: an object
   * there would make an older client drop the whole frame.
   */
  sessionDraftLimits?: SessionDraftLimits;
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
  /** Validated staged-file metadata recorded by the host, without original contents. */
  files?: SharedFileMeta[];
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
  /**
   * Blocks the surface classified out of this message's text (rev 4,
   * additive; D42). Persisted server-side and joined back on replay, so
   * history renders as the live turn did without a second pass.
   */
  blocks?: MessageBlock[];
  /**
   * How a `user` message was produced, as its client reported it on
   * `chat_message` (additive). Absent means `typed`: the message was typed,
   * was sent by a client that did not say, or was replayed by its backend
   * as text the host cannot match to what was sent.
   */
  source?: MessageSource;
  /** Explicit effort requested for this user message. Absent means the default was used. */
  thinkingLevel?: ThinkingLevel;
  /** Runtime-confirmed effort, when the backend can report it. */
  effectiveThinkingLevel?: ThinkingLevel;
  /**
   * On an `assistant` message: the answer of a locally answered command
   * (additive; #582), replayed from what the host recorded. `content` is
   * empty; the client draws `answer`. The user message before it is the
   * exchange's `prompt`.
   */
  localAnswer?: LocalAnswer;
  /**
   * On an `assistant` message: the provider failure that ended its turn
   * (additive; #575), as the live `result` carried it where the transcript
   * keeps enough to tell. Its text is not repeated in `content`, which holds
   * whatever the turn answered before it failed.
   */
  failure?: TurnFailure;
  /** Host-held exact original request, present only on an eligible latest failure. */
  retryOfTurnId?: string;
  /**
   * On an `assistant` message: the host turn whose answer ends here
   * (additive; #964). Present only when the host observed this message
   * appear as that turn's last answer and the transcript before it is
   * unchanged since; never inferred from timestamps or content.
   */
  turnId?: string;
}

/** A replayed local exchange's answer, as `SessionHistoryMessage.localAnswer` carries it. */
export interface LocalAnswer {
  exchangeId: string;
  command: string;
  answer: unknown;
}

/**
 * Whether the host recorded a local exchange (additive; #582). Sent to the
 * connection that sent `local_exchange`, and to every client once a new
 * conversation's `localExchanges` are recorded. `saved: false` means the
 * exchange is not part of the session and the agent will not see it.
 */
export interface ServerLocalExchangeResult extends SessionScoped {
  type: "local_exchange_result";
  sessionId: string;
  exchangeId: string;
  saved: boolean;
  /** Why it was not saved. */
  reason?: string;
}

/**
 * One block the surface drew in place of a span of markdown (D42). Anchored
 * to a TEXT part by its ordinal among the message's text parts and to the
 * character span inside that part's text; the client cuts the part at the
 * span and renders the block there. `block` is the same union `show_block`
 * carries, so one renderer draws both.
 */
export interface MessageBlock {
  /** Ordinal among the message's `text` parts, 0-based. */
  partIndex: number;
  /** Character offset in the part's text where the replaced span starts. */
  start: number;
  /** Character offset where it ends, exclusive. */
  end: number;
  block: Block;
  /** The classifier's confidence in the shape, 0–1. */
  confidence: number;
}

/**
 * The blocks classified out of the turn's assistant message (rev 4,
 * additive; D42). Sent AFTER the turn's `result`, never before, and only
 * when the pass yielded at least one block: an answer never waits on it, and
 * a client that does not know the frame renders the markdown it already
 * has.
 */
export interface ServerMessageBlocks extends SessionScoped {
  type: "message_blocks";
  sessionId: string;
  blocks: MessageBlock[];
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
  /**
   * What is being approved (additive). "tool" (default) — running a tool
   * that is not auto-allowed; the client may offer "always allow".
   * "command" — a destructive-pattern confirmation for an otherwise
   * auto-allowed tool (bash); always per-use, never rememberable.
   */
  kind?: "tool" | "command";
  /**
   * Whether the host will keep an "always allow" given on this card (rev 4,
   * additive). Sent as `false` when the host will refuse to remember the
   * grant — the request is for a tool outside the turn's enforced allowlist
   * (a grant made inside that narrower posture must not widen the others),
   * or the host has no grant store at all. The call itself can still be
   * allowed; only the memory is refused, so the client must not offer
   * "always allow". Absent means `kind` alone decides,
   * as it did before this field existed. Advisory: the host enforces the
   * refusal whatever the client sends.
   */
  rememberable?: boolean;
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
  /**
   * The provider failure that ended the turn (additive; #575), on
   * `outcome: "error"` only. Absent means the backend reported none — the
   * turn failed for another reason, or the backend predates the field.
   */
  failure?: TurnFailure;
  /** Host-retained original request; absent when an exact retry is unavailable. */
  retryOfTurnId?: string;
}

/**
 * A provider or API failure that ended a turn (additive; #575), normalised
 * across backends. It rides the turn's terminal frame — `result`, or the bare
 * `error` of a turn that failed before it had a session — and the replayed
 * assistant message the failure ended.
 */
export interface TurnFailure {
  /**
   * The failure's class, in the Claude Agent SDK's vocabulary where the
   * backend can tell (`authentication_failed`, `rate_limit`, `overloaded`,
   * `invalid_request`, `model_not_found`, `server_error`, …), plus
   * `subscription_required` for a turn refused before it was sent. Free-form:
   * a new value never breaks a client. `unknown` when the backend cannot
   * tell, which is never a guess.
   */
  errorClass: string;
  /** HTTP status the provider answered with. Absent means unknown, not "no status". */
  status?: number;
  /** Observed retries before this terminal failure; absent when none were reported. */
  attempts?: number;
  /** Observed subscription limit reset, in epoch milliseconds; absent means unknown. */
  resetsAt?: number;
  /** The failure as the runtime worded it. */
  message: string;
  /**
   * For a Claude subscription's auth failure: what the operator does about it
   * (#254). Absent on every other failure, including an auth failure on a
   * profile that bills its own API credential.
   */
  authAction?: SubscriptionAuthAction;
}

/**
 * A model call that failed and will be retried (additive; #575), on a
 * `status: thinking` frame while the turn is still running. Every field but
 * `attempt` is present only when the runtime reported it; nothing is
 * estimated.
 */
export interface TurnRetry {
  /** Which retry this is, 1-based. */
  attempt: number;
  /** The most retries the runtime will make. */
  maxAttempts?: number;
  /** How long the runtime waits before this attempt, in milliseconds. */
  delayMs?: number;
  /** The failed call's class, as {@link TurnFailure.errorClass}. */
  errorClass?: string;
  /** The failed call's HTTP status. */
  status?: number;
}

/**
 * What an operator does about a subscription auth failure (#254): mint a new
 * token; look at the account itself, which a new token will not fix; or fix
 * the host's Claude configuration, which kept the turn off the subscription
 * before anything was sent.
 *
 * @experimental
 */
export type SubscriptionAuthAction = "relogin" | "check_account" | "check_config";

/** @experimental How to mint and install a new subscription token. */
export const SUBSCRIPTION_RELOGIN_PROCEDURE =
  "Mint a new token with `claude setup-token` on a machine with a browser, put it in the host's secret store as " +
  "CLAUDE_CODE_OAUTH_TOKEN with today's date as BRAIN_UI_CLAUDE_TOKEN_MINTED_AT, and redeploy " +
  '(docs/hosting/README.md, "Claude subscription login").';

/** @experimental The instruction an operator is given for each action. */
export const SUBSCRIPTION_AUTH_INSTRUCTIONS: Readonly<Record<SubscriptionAuthAction, string>> = Object.freeze({
  relogin: `The Claude subscription token was rejected. ${SUBSCRIPTION_RELOGIN_PROCEDURE}`,
  check_account:
    "The Claude account itself was refused (organisation not allowed, account on hold, or billing). " +
    "A new token will not help: check the account at claude.ai, then send a turn to confirm.",
  check_config:
    "Claude Code was not set to run on the subscription, so the turn was refused before anything was sent. " +
    "Check that CLAUDE_CODE_OAUTH_TOKEN is set, and that no Claude settings on the host select another " +
    "credential or provider (apiKeyHelper, policyHelper, a stored API key, a third-party provider). The " +
    "refusal names which.",
});

const ACCOUNT_CLASSES: ReadonlySet<string> = new Set(["oauth_org_not_allowed", "account_on_hold", "billing_error"]);

/**
 * The action for an auth failure class: the account classes need the account
 * looked at; `subscription_required` (the backend refused the turn before
 * sending it) needs the configuration fixed; anything else — a rejected
 * token — needs a new token.
 *
 * @experimental
 */
export function subscriptionAuthAction(errorClass: string): SubscriptionAuthAction {
  if (ACCOUNT_CLASSES.has(errorClass)) return "check_account";
  return errorClass === "subscription_required" ? "check_config" : "relogin";
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
  /**
   * The provider failure behind it (additive; #575). Set when this bare
   * `error` is the terminal frame of a turn that failed before it had a
   * session, so it is the only frame that can carry it.
   */
  failure?: TurnFailure;
  /** Correlation of a refused chat message, when the client supplied it. */
  requestId?: string;
}

export interface ServerStatus extends SessionScoped {
  type: "status";
  status: "thinking" | "tool_executing" | "idle" | "cancelled" | "queued";
  detail?: string;
  /**
   * On `thinking`: a failed model call the runtime is about to retry
   * (additive; #575). `detail` says the same in words for a client that does
   * not read this.
   */
  retry?: TurnRetry;
  /** @deprecated single-session era; multi-session servers set `sessionId`. */
  activeSessionId?: string;
  /** On queued: acknowledgement that this chat request was accepted. */
  requestId?: string;
  /** Explicit effort requested for the current message, when reported. */
  thinkingLevel?: ThinkingLevel;
  /** Runtime-confirmed effort; never inferred merely from the requested option. */
  effectiveThinkingLevel?: ThinkingLevel;
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
  /** Acknowledgement of the chat request that started this turn. */
  requestId?: string;
  thinkingLevel?: ThinkingLevel;
  effectiveThinkingLevel?: ThinkingLevel;
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
   * Effective profile default for models that support reasoning effort.
   * A saved unsupported level is resolved against supportedThinkingLevels.
   */
  thinkingLevel?: ThinkingLevel;
  /** Supported choices, in increasing effort order, when the backend knows them. */
  supportedThinkingLevels?: ThinkingLevel[];
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
  /**
   * Which catalog runs on this profile are billed through (additive), when the
   * backend can say. Absent when the route is unknown — a proxy the backend
   * does not recognise, or a backend that does not classify routes. Server
   * side it selects the pricing catalog; the client must not switch behavior
   * on it, only presentation.
   */
  pricingRoute?: PricingRoute;
}

/**
 * Why a configured profile cannot run now (additive, #1044). A closed set: the
 * client owns the copy (`needs-credentials` reads `needs credentials`), so a
 * backend never sends free text and no configuration detail, such as an
 * environment key name, leaves the host. A new reason is an additive contract
 * change; a client shows a reason it does not know as a generic one.
 */
export const PROFILE_UNAVAILABLE_REASONS = ["needs-credentials"] as const;
export type ProfileUnavailableReason = (typeof PROFILE_UNAVAILABLE_REASONS)[number];

export function isProfileUnavailableReason(value: unknown): value is ProfileUnavailableReason {
  return typeof value === "string" && (PROFILE_UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

/**
 * A profile that is configured but cannot run now (additive, #1044). Listed
 * apart from the runnable roster (`GET /api/providers`' `unavailable`), so the
 * roster keeps meaning "runnable now"; it is never a valid `providerId`.
 */
export interface UnavailableProfileInfo {
  id: string;
  label: string;
  reason: ProfileUnavailableReason;
  /** Which AgentBackend reported it; set by the aggregating host, as on ProviderInfo. */
  backendId?: string;
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
  /**
   * Explicit reasoning-effort override stored for this profile, when one is
   * set. Absent = the profile's configured default — `thinkingLevel` then
   * reflects that default rather than a user choice.
   */
  thinkingOverride?: ThinkingLevel;
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

/** Reasoning-effort levels (mirror of the pi SDK's ThinkingLevel union). */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** THE membership check for {@link ThinkingLevel} at validation boundaries. */
export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/**
 * Body of PUT /api/models/thinking — the complete override record, not a
 * delta. A profile absent from the record uses its configured default.
 */
export interface SetThinkingOverridesRequest {
  thinking: Record<string, ThinkingLevel>;
}

/** Body of PUT /api/models/default — a profile id, or null for auto. */
export interface SetDefaultModelRequest {
  defaultId: string | null;
}

/** Body of PUT /api/models/custom — the complete OpenRouter list, not a delta. */
export interface SetCustomModelsRequest {
  models: string[];
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
  /**
   * The session this one was handed off from (additive; #61). Its first
   * user message is the reviewed handoff. A source's forward links are the
   * sessions whose `handoffFrom` names it; `afterTurns` is how many user
   * messages (turns) the source had when it was handed off, absent when
   * unknown.
   */
  handoffFrom?: { sessionId: string; title: string | null; backendId?: string; afterTurns?: number };
  /**
   * A few words saying what the session's latest request is about (additive,
   * #1004), written by the host's label model when a turn starts and kept
   * until the next request is labelled. Absent until then, or when the host
   * labels nothing: a working-session pill prints `title` instead. Plain text,
   * at most {@link PILL_LABEL_MAX_CHARS} characters. Not a title: it never
   * renames the session.
   */
  label?: string;
}

/** The longest pill label a host sends (#1004). */
export const PILL_LABEL_MAX_CHARS = 32;

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
  /** The configured source commit (`"dev"` by default), never a release. */
  version: string;
  /** The server's package release and the same source commit as `version`. */
  software: { release: string; sourceCommit: string };
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

export type MessageSource = "typed" | "voice-dictate" | "voice-conversation" | "handoff";

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

/** Read-only provider discovery; never mints a streaming credential. */
export interface VoiceCapabilitiesResponse {
  providerId: string;
  capabilities: SpeechCapabilities;
}

export type TranscriptionFailureReason = "provider_error" | "rate_limit" | "provider_timeout" | "media" | "parameters" | "validation" | "authentication" | "outcome_unknown";
export interface TranscriptionFailure {
  reason: TranscriptionFailureReason;
  retryable: boolean;
  providerStatus?: number;
}
export interface RecordingTranscription {
  recordingId: string;
  sha256: string | null;
  providerId: string | null;
  status: "transcribing" | "done" | "failed" | "outcome_unknown" | "consumed";
  attemptId: string;
  retryCount: number;
  text?: string;
  failure?: TranscriptionFailure;
  failures: Array<TranscriptionFailure & { attemptId: string }>;
  disposition?: "accepted" | "discarded";
}
export interface TranscriptionErrorResponse {
  error: string;
  message: string;
  receipt?: RecordingTranscription;
}

export interface SpeechCapabilities {
  streaming: boolean;
  interimResults: boolean;
  keyterms: boolean;
  endpointing: boolean;
  /** Absent/false means saved recordings cannot be transcribed. Derived from the optional server method. */
  savedAudio?: boolean;
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
// Live conversation (additive, #957)
//
// A separately registered conversation runs beside dictation; nothing above
// changes meaning. The host owns commit, admission, tools, permissions,
// cancellation and correlation. A provider's evidence is published as it is:
// "unproven" is never promoted to "supported" by the host or by a client.
// docs/integration-contract.md "Live conversation" is the normative text.
// ============================================================

/** What a provider can show about one capability. Missing evidence is "unproven". */
export type ConversationEvidence = "supported" | "unsupported" | "unproven";

/** The closed capability profile a live-conversation provider publishes. */
export interface ConversationCapabilities {
  /** Conversation continues while host work is pending. */
  nonblockingWork: ConversationEvidence;
  /** The host can mark an utterance's end itself. */
  manualEndpoint: ConversationEvidence;
  /** The provider can say an input transcript is final. */
  finalTranscript: ConversationEvidence;
  /** The provider acknowledges a remote output cancellation. */
  remoteOutputCancelAck: ConversationEvidence;
  /** Host-approved permission copy can be rendered exactly as audio. */
  exactPermissionSpeech: ConversationEvidence;
  /** Input recognition is isolated from the assistant's own playback. */
  echoIsolatedInput: ConversationEvidence;
  /** Output transcript words align with played audio samples. */
  outputWordAlignment: ConversationEvidence;
}

/** Every `ConversationCapabilities` key, in a fixed order. */
export const CONVERSATION_CAPABILITY_KEYS = [
  "nonblockingWork",
  "manualEndpoint",
  "finalTranscript",
  "remoteOutputCancelAck",
  "exactPermissionSpeech",
  "echoIsolatedInput",
  "outputWordAlignment",
] as const satisfies readonly (keyof ConversationCapabilities)[];

/**
 * Where a conversation's data goes, shown before capture starts. The host
 * relay and the agent backend are named by the host, not by the provider.
 */
export interface ConversationDisclosure {
  /** Voice service and model, e.g. "Example Voice API, example-live-1". */
  voiceService: string;
  /** Plain statements of each destination: audio, transcripts, reviewed facts. */
  destinations: string[];
}

/** Mono 16-bit little-endian PCM at one sample rate. */
export interface ConversationAudioFormat {
  encoding: "pcm16";
  sampleRate: number;
  channels: 1;
}

/**
 * Fixed per-conversation bounds. Exceeding one is never a silent drop: the
 * host refuses the commit with a `refused` work receipt, or closes the epoch
 * with reason `backpressure`, and says so.
 */
export const CONVERSATION_LIMITS = {
  /** Decoded bytes in one `conversation_audio` or provider audio chunk. */
  maxAudioChunkBytes: 65_536,
  /** Utterances whose provenance an epoch keeps; the oldest settled one is evicted first. */
  maxUtterances: 16,
  /** Input fragments kept for one utterance. */
  maxFragmentsPerUtterance: 128,
  /** Characters in one input fragment or output transcript fragment. */
  maxFragmentChars: 2_000,
  /** Characters of recognized text one utterance keeps, all fragments joined. */
  maxUtteranceChars: 16_000,
  /** Characters of generated transcript one output record keeps. */
  maxGeneratedChars: 16_000,
  /** Characters of reviewed text in one `conversation_commit`. */
  maxCommitChars: 8_000,
  /** Committed work held by one conversation, the running item included. */
  maxQueuedWork: 4,
  /** Advisory provider work requests not yet bound to committed work. */
  maxPendingNativeRequests: 8,
  /** Characters of host facts returned to the provider for one request. */
  maxFactChars: 4_000,
  /** Output streams whose provenance an epoch keeps. */
  maxOutputs: 32,
  /** Live conversations on one connection. */
  maxConversationsPerConnection: 1,
} as const;

/** The limits a host applies, as published on `conversation_opened`. */
export type ConversationLimits = { -readonly [K in keyof typeof CONVERSATION_LIMITS]: number };

/** Milliseconds from the start of an utterance or output stream. */
export interface ConversationInterval {
  startMs: number;
  endMs: number;
}

/**
 * Normalized provider evidence the host forwards. Every value is a fact the
 * provider reported; none is authority. `input_fragment` text is recognized,
 * not submitted; `output_transcript` text is generated, not heard.
 */
export type ConversationWireEvent =
  | {
      kind: "ready";
      /** Resolved model/API the provider reports for this epoch. */
      model?: string;
      api?: string;
      input: ConversationAudioFormat;
      output: ConversationAudioFormat;
    }
  | {
      kind: "input_fragment";
      utteranceId: string;
      sequence: number;
      /** Original recognized text, before any pronunciation mapping. */
      text: string;
      interval?: ConversationInterval;
      finalization: "interim" | "final" | "unknown";
      /** `known` only when the provider reported a calibrated `confidence`. */
      certainty: "known" | "unknown";
      confidence?: number;
      /** Whose voice the provider attributes it to. Synthetic tags prove routing, not isolation. */
      origin: "user" | "assistant" | "unknown";
    }
  | {
      kind: "output_transcript";
      outputId: string;
      sequence: number;
      text: string;
      interval?: ConversationInterval;
    }
  | {
      kind: "audio";
      outputId: string;
      sequence: number;
      format: ConversationAudioFormat;
      /** Base64 PCM. */
      pcm: string;
    }
  | {
      /** The provider reported that it stopped output. Only sent when observed. */
      kind: "interrupted";
      outputId?: string;
    };

/** Host-side state of one committed request. */
export type ConversationWorkState =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "error"
  | "refused";

/**
 * Whether a request's result reached the voice service. `discarded` means
 * the host kept the outcome but the epoch, conversation or native request
 * it belonged to had ended, or the work was cancelled.
 */
export type ConversationDelivery = "pending" | "returned" | "discarded";

/**
 * One committed request: what was recognized, what the user submitted, and
 * what the host did with it. Host authority, keyed by host identities only.
 */
export interface ConversationWorkReceipt {
  conversationId: string;
  /** The epoch the request was committed in. */
  epoch: number;
  utteranceId: string;
  requestId: string;
  /** Host turn identity, once the turn started. */
  turnId?: string;
  /** Chat session, once known. */
  sessionId?: string;
  state: ConversationWorkState;
  delivery: ConversationDelivery;
  /** Original recognized fragments of the utterance, joined in sequence order. */
  recognized: string;
  /** The reviewed text the user committed — what the agent received. */
  submitted: string;
  reason?: string;
}

/** Playback evidence a client reports for one output stream. */
export type ConversationPlayback = "played" | "discarded" | "unknown";

/** One output stream: generated text and what the client says it played. */
export interface ConversationOutputRecord {
  /** The epoch the output was generated in; output ids are scoped to it. */
  epoch: number;
  outputId: string;
  /** Generated transcript, bounded; not a verbatim record of what was heard. */
  generated: string;
  playback: ConversationPlayback;
  /** Samples the client reports as audible, when it reported a range. */
  playedSamples?: { start: number; end: number };
}

/** Client → Server. Open a conversation, or a new epoch of an existing one. */
export interface ClientConversationStart {
  type: "conversation_start";
  /** Resume this conversation as a new epoch. Absent starts a new one. */
  conversationId?: string;
  /** Chat session the conversation's work runs in. Absent: the first commit creates one. */
  sessionId?: string;
}

/** Client → Server. One chunk of captured microphone audio. */
export interface ClientConversationAudio {
  type: "conversation_audio";
  conversationId: string;
  epoch: number;
  /** Client-minted utterance the chunk belongs to. */
  utteranceId: string;
  /** Strictly increasing within an epoch. */
  sequence: number;
  /** Sample rate of `pcm`; mono PCM16. */
  rate: number;
  /** Base64 PCM16, at most `CONVERSATION_LIMITS.maxAudioChunkBytes` decoded. */
  pcm: string;
}

/** Client → Server. The client marks the end of one utterance's capture. */
export interface ClientConversationEndpoint {
  type: "conversation_endpoint";
  conversationId: string;
  epoch: number;
  utteranceId: string;
}

/**
 * Client → Server. Semantic commit: the user's reviewed text for one
 * utterance becomes host work. Nothing runs before this frame.
 */
export interface ClientConversationCommit {
  type: "conversation_commit";
  conversationId: string;
  epoch: number;
  utteranceId: string;
  /** Client-minted, unique per conversation; a repeat replays its receipt. */
  requestId: string;
  text: string;
}

/** Client → Server. What the client actually played of one output stream. */
export interface ClientConversationPlayback {
  type: "conversation_playback";
  conversationId: string;
  epoch: number;
  outputId: string;
  playback: ConversationPlayback;
  playedSamples?: { start: number; end: number };
}

/** Client → Server. End the conversation. Submitted host work keeps running. */
export interface ClientConversationStop {
  type: "conversation_stop";
  conversationId: string;
}

/**
 * Server → Client. A conversation epoch opened. It is followed, before any
 * event of the epoch, by one `conversation_work` per retained receipt and one
 * `conversation_output` per retained output record — `resync` says how many,
 * so a client knows when it holds the whole picture. Nothing is resubmitted,
 * re-executed or re-announced. One frame per record keeps every record whole:
 * a single snapshot frame could outgrow the per-frame cap and be clipped.
 */
export interface ServerConversationOpened {
  type: "conversation_opened";
  conversationId: string;
  epoch: number;
  /** Chat session, once known. */
  sessionId?: string;
  providerId: string;
  capabilities: ConversationCapabilities;
  disclosure: ConversationDisclosure;
  limits: ConversationLimits;
  resync: { work: number; outputs: number };
}

/** Server → Client. One retained output record, resent after `conversation_opened`. */
export interface ServerConversationOutput extends ConversationOutputRecord {
  type: "conversation_output";
  conversationId: string;
}

export type ConversationCloseReason =
  | "stopped"
  | "replaced"
  | "disconnected"
  | "provider_closed"
  | "provider_error"
  | "backpressure"
  | "correlation"
  | "refused";

/** Server → Client. A conversation epoch ended. Capture must restart explicitly. */
export interface ServerConversationClosed {
  type: "conversation_closed";
  conversationId: string;
  epoch: number;
  reason: ConversationCloseReason;
  message?: string;
}

/** Server → Client. Normalized provider evidence for the current epoch. */
export interface ServerConversationEvent {
  type: "conversation_event";
  conversationId: string;
  epoch: number;
  event: ConversationWireEvent;
}

/** Server → Client. A committed request changed state or delivery. */
export interface ServerConversationWork extends ConversationWorkReceipt {
  type: "conversation_work";
}

/**
 * Server → Client. A permission request is pending in the conversation's
 * session. `announce` is true at most once per (session, turn, toolUseId) for
 * the conversation's lifetime, and only when the provider has proven exact
 * permission speech. Never a grant path: voice may refuse, never grant.
 */
export interface ServerConversationPermission {
  type: "conversation_permission";
  conversationId: string;
  epoch: number;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  announce: boolean;
}

/**
 * Host outcome of one permission request (additive, #957). Sent only to
 * connections whose `client_hello` declared `capabilities.toolResolution`.
 * `expired` means the turn ended first; `unknown` means the host holds no
 * outcome the reply could have applied to. Sending a denial is not
 * confirmation of one — this frame is.
 */
export type ToolResolutionOutcome = "granted" | "denied" | "expired" | "unknown";

export interface ServerToolResolution extends SessionScoped {
  type: "tool_resolution";
  toolUseId: string;
  outcome: ToolResolutionOutcome;
  /** Channel of the decision that settled it, when one did. */
  channel?: ApprovalChannel;
  reason?: string;
}

/**
 * One message the host accepted while its session was busy and has not yet
 * handed to the agent (additive, #1002). `id` is host-minted and stable while
 * the entry waits; `requestId` is the sender's `chat_message` correlation id,
 * when it sent one. Attachments are counted, never repeated.
 */
export interface QueuedFollowUpView {
  id: string;
  requestId?: string;
  text: string;
  /** `text` is the head of a longer message; history holds the whole of it. */
  textTruncated?: boolean;
  /** Images the message carries. */
  attachmentCount?: number;
  /** Shared files the message carries. */
  fileCount?: number;
  source?: MessageSource;
  /** Host clock when the entry was queued. */
  queuedAt: number;
  /**
   * A few words saying what the message is about (additive, #1004), from the
   * host's label model. Absent until it arrives, which is reported as a
   * change to the queue, or when the host labels nothing: the pill prints
   * the start of `text` instead. Plain text, at most
   * {@link PILL_LABEL_MAX_CHARS} characters.
   */
  label?: string;
}

/**
 * Server → Client (additive, #1002). The session's pending follow-ups, whole
 * and in send order, so a client that reloads or reconnects rebuilds them.
 * Sent only to connections whose `client_hello` declared
 * {@link FOLLOW_UP_QUEUE_CAPABILITY}: after that hello for every session with
 * a non-empty queue, after every `session_resume`, and on every change.
 *
 * `started` names the entry that just became the session's turn, with that
 * turn's id, before any of the turn's own frames. `dropped` names entries that
 * left without running (cancelled, revoked, the session ended), each with the
 * host's reason. Neither repeats in a later frame.
 */
export interface ServerSessionQueue {
  type: "session_queue";
  sessionId: string;
  followUps: QueuedFollowUpView[];
  started?: QueuedFollowUpView & { turnId: string };
  dropped?: Array<{ id: string; requestId?: string; reason: string }>;
}

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

/** Validated track input cap, matching the shared geo parser. */
export const TRACK_MAX_FILE_BYTES = 20 * 1024 * 1024;

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

/** Unit-bearing shared measurements, without the potentially large display geometry. */
export type TrackFileSummary = Omit<TrackSummary, "geometry"> & { waypointCount: number; waypointOmitted: number };

export interface TrackFileView extends ImportedTrack { file: SharedFileMeta }

export interface ChatFileAttachment { kind: "file"; path: string }

export interface SharedFileMeta {
  /** Bounded, visible incoming display name; separate from the sanitized stored name. */
  incomingName?: string;
  /** SHA-256 of a validated original; exact retries refuse changed files. */
  sha256?: string;
  /** Format established from validated contents, never from a name or MIME claim. */
  detected?: TrackFormat;
  summary?: TrackFileSummary;
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
export interface ClientAskUserResponse extends AskAnswerBinding {
  type: "ask_user_response";
  requestId: string;
  answers: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

/**
 * Delivery fields on all four ask answers (rev 5, #910).
 *
 * `submissionId` names ONE explicitly submitted answer. The client mints it
 * when the user submits and reuses it for every retry of that same answer, so
 * the host can settle the request at most once and repeat its receipt. A host
 * advertising `askReceipts` refuses an answer without it
 * ({@link ASK_ANSWER_UPDATE_REQUIRED}). Optional in the type only so the
 * schema can still parse an older client's frame and refuse it with that
 * error instead of a parse error.
 */
export interface AskAnswerBinding {
  /** 1–128 characters, client-minted, unique per submitted answer. */
  submissionId?: string;
  /** The session the client bound the answer to. A different session is refused. */
  sessionId?: string;
}

/** Client → Server. Where does this submitted answer stand? Settles nothing. */
export interface ClientAskAnswerStatus {
  type: "ask_answer_status";
  requestId: string;
  submissionId: string;
  sessionId?: string;
}

/**
 * Server → Client. The host's authoritative word on one submitted ask answer,
 * sent to the socket that asked: in reply to an answer frame, or to
 * `ask_answer_status`.
 *
 * - `accepted` — this `submissionId` settled the request. Repeating the same
 *   submission repeats this receipt and settles nothing again.
 * - `pending` — status replies only: the request is still waiting and has not
 *   received this submission. `sessionId`/`turnId` name its binding, so the
 *   client can send (or resend) the answer.
 * - `closed` — the request will not take this answer. `reason` says why:
 *   `ended` (the turn ended, failed, timed out or was cancelled), `cancelled`
 *   (the question was dismissed), `answered_elsewhere` (another submission
 *   settled it), `not_recognized` (the host does not know the request, or the
 *   receipt belongs to another principal), `refused` (the answer's turn,
 *   session or kind does not match the request).
 *
 * A receipt is about delivery to the host, not about what the agent does with
 * the answer. A host restart forgets receipts: afterwards every request is
 * `not_recognized`.
 */
export interface ServerAskAnswerReceipt extends SessionScoped {
  type: "ask_answer_receipt";
  requestId: string;
  submissionId: string;
  state: "accepted" | "pending" | "closed";
  reason?: "ended" | "cancelled" | "answered_elsewhere" | "not_recognized" | "refused";
}

/**
 * Client → Server. An application-level liveness probe (rev 5). Browser
 * WebSocket ping/pong frames are not exposed to scripts, so a client that
 * suspects a half-open socket asks the host directly. Only send it to a host
 * advertising `liveness`.
 */
export interface ClientPing {
  type: "ping";
  /** 1–128 characters; the `pong` echoes it. */
  probeId: string;
}

/** Server → Client. The reply to `ping`, sent immediately to the same socket. */
export interface ServerPong {
  type: "pong";
  probeId: string;
}

/**
 * Client → Server. User dismissed the ask-user prompt; the agent gets an error.
 * Cancels `ask_user_list_request`, `ask_user_rank_request` and `ask_user_form_request` too: ids are unique across all
 * kinds, so one dismissal frame serves any card.
 */
export interface ClientAskUserCancel {
  type: "ask_user_cancel";
  requestId: string;
  reason?: string;
  /** Echo of the request's turnId (rev 2, additive) for host-side correlation. */
  turnId?: string;
}

// ============================================================
// Ask User List (one scale over many items — ask_user_list bridge)
// ============================================================

/** One option of the scale every item of an `ask_user_list` is placed on. */
export interface AskUserListOption {
  label: string;
  description?: string;
}

/** One item to place on the scale. `id` is the key its answer comes back under. */
export interface AskUserListItem {
  id: string;
  label: string;
  /** A one-line gloss: a year, a size, why it is on the list. */
  detail?: string;
  /** An http(s) URL for the item. The host shown is the client's, never the agent's. */
  link?: string;
}

/** What an `ask_user_list` asks, with its defaults applied. */
export interface AskUserListSpec {
  prompt: string;
  scale: AskUserListOption[];
  items: AskUserListItem[];
  /** Submit may leave items unanswered. */
  allowSkip: boolean;
  /** Each item may carry a short free-text note. */
  notes: boolean;
}

/**
 * Server → Client. The agent wants one scale applied to a list of items,
 * answered in one card. Reply with ClientAskUserListResponse (or
 * ClientAskUserCancel to dismiss) using the same requestId.
 */
export interface ServerAskUserListRequest extends SessionScoped, AskUserListSpec {
  type: "ask_user_list_request";
  requestId: string;
}

/**
 * Client → Server. The answers to an `ask_user_list_request`.
 *
 * `answers` is keyed by item **id** and each value is a scale option's
 * `label`. A skipped item is ABSENT from `answers`, never an empty string.
 * `notes` is keyed by item id too and is separate from `answers`, so a note on
 * a skipped item still reaches the agent while the item stays skipped.
 */
export interface ClientAskUserListResponse extends AskAnswerBinding {
  type: "ask_user_list_response";
  requestId: string;
  answers: Record<string, string>;
  notes?: Record<string, string>;
  /** Echo of the request's turnId for host-side correlation. */
  turnId?: string;
}

// ============================================================
// Ask User Rank (one complete id order — ask_user_rank bridge)
// ============================================================

export type AskUserRankItem = AskUserListItem;
export interface AskUserRankSpec {
  prompt: string;
  items: AskUserRankItem[];
  /** Only the first N matter; the response still includes every id. */
  cutoff?: number;
}
/** Reply with ClientAskUserRankResponse, or dismiss with ClientAskUserCancel. */
export interface ServerAskUserRankRequest extends SessionScoped, AskUserRankSpec {
  type: "ask_user_rank_request";
  requestId: string;
}
/** A complete permutation of the request's ids; the host verifies equality. */
export interface ClientAskUserRankResponse extends AskAnswerBinding {
  type: "ask_user_rank_response";
  requestId: string;
  order: string[];
  unchanged: boolean;
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
export type ActivitySpanOrigin = "session" | "cron" | "autonomous";
export type ActivityPrincipalKind = "owner" | "agent" | "ambient" | "system";
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
  /** Principal responsible for this span; absent means unattributed. */
  principalId?: string;
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

/**
 * Which catalog a run's inference was billed through: `openrouter` (routed
 * over OpenRouter, billed at its resale rate) or `direct` (the model vendor's
 * own endpoint, billed at the vendor's rate). Resolved once at run start from
 * the run's inference profile, exactly like {@link BillingMode}.
 *
 * It exists because a model id does not identify its own price: both pricing
 * catalogs carry some of the same ids at different rates, so only the route
 * says which of the two a given run was actually billed at. Absent means
 * unknown — pricing then falls back to id-alone resolution.
 */
export type PricingRoute = "openrouter" | "direct";

/** THE membership check for {@link PricingRoute} — one definition for every
 *  boundary that validates an untrusted value (span attrs, stored profiles). */
export function isPricingRoute(v: unknown): v is PricingRoute {
  return v === "openrouter" || v === "direct";
}

export interface ActivityRunSummary {
  runId: string;
  origin: ActivitySpanOrigin;
  name: string;
  sessionId: string | null;
  jobName: string | null;
  /** Root-span actor; null means unattributed. */
  principalId?: string | null;
  /** Historical snapshot retained after the principal row is pruned. */
  principalLabel?: string | null;
  /** Historical snapshot retained after the principal row is pruned. */
  principalKind?: ActivityPrincipalKind | null;
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
  principalId?: string | null;
  principalLabel?: string | null;
  principalKind?: ActivityPrincipalKind | null;
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

/**
 * The runtime stats channel (`GET /api/activity/stats?days=N`): what the
 * server's own database says about sessions, runs, tokens and cost. The
 * corpus channel is `GET /api/brain/stats`; a stats surface calls both and
 * merges. Every figure is labelled with what it covers — `lifetime` from
 * the never-pruned session catalog, `window` from the run rollups — because
 * the two sources do not say the same thing. Timestamps are ms epoch;
 * an average is `null` wherever its denominator is zero or its sum is
 * incomplete, never `0`.
 */
export interface ActivityRuntimeStats {
  /** The clock every window and average was computed against. */
  generatedAt: number;
  lifetime: {
    scope: "lifetime";
    sessions: number;
    /** Sum of every session's `num_turns`. */
    turns: number;
    /**
     * Sum of every session's backend-reported `total_cost_usd`. A list-price
     * figure accumulated per turn. The catalog folds an unreported cost into
     * `0` when it writes the turn, so no unpriced counter survives to be
     * reported here: read this as a floor, and use `window` when unknown has
     * to be told apart from zero.
     */
    costUsd: number;
    /** Oldest `created_at`; null when the catalog is empty. */
    firstActivityAt: number | null;
    /** Newest `last_active_at`; null when the catalog is empty. */
    lastActivityAt: number | null;
    /**
     * Days from `firstActivityAt` to `generatedAt` (at least 1 once a session
     * exists) — the denominator of the per-day average. `0` when the catalog
     * is empty, and also when its oldest session is dated AFTER
     * `generatedAt`: a clock corrected backwards leaves such rows, and a
     * negative span must not become a one-day burn rate. The lifetime
     * totals still include those sessions; only the rate goes `null`.
     */
    elapsedDays: number;
    averages: {
      costUsdPerSession: number | null;
      turnsPerSession: number | null;
      costUsdPerDay: number | null;
      /** `costUsdPerDay` projected over a mean month (365.25 / 12 days). */
      costUsdPerMonth: number | null;
    };
  };
  window: {
    scope: "window";
    /** The requested window length. */
    days: number;
    /**
     * `[since, until]` is closed and both ends are enforced: a run dated
     * after `until` — a clock corrected backwards leaves such rows — is not
     * summed and does not move `recordedSince`. `until` is `generatedAt`.
     */
    since: number;
    until: number;
    /**
     * The oldest run in the record at or before `until`, regardless of the
     * window; null when the record holds none. Rollups outlive detail
     * pruning, so the sums are complete back to here — but no further, and a
     * window reaching past it covers fewer days than it asked for.
     */
    recordedSince: number | null;
    /**
     * Days between `max(since, recordedSince)` and `until` — what the
     * per-day averages divide by. At least 1 once the record has a run, 0
     * when it has none.
     */
    coveredDays: number;
    /**
     * Where drill-in detail (spans, events) stops: runs that ended before
     * `cutoffAt` may have had their detail pruned, and `insideWindow` says
     * whether that boundary falls inside this window. The rollup sums are
     * unaffected; `/activity/runs/:id` for such a run answers rollup-only.
     */
    detailRetention: { days: number; cutoffAt: number; insideWindow: boolean };
    /** Runs in the window whose detail is already gone. */
    detailPrunedRuns: number;
    runs: number;
    failures: number;
    /**
     * Sum of KNOWN list-price costs — a floor; the excluded runs are
     * `unpricedListCostRuns` (see `ActivityAggregate`).
     */
    costUsd: number;
    /** Sum of KNOWN effective costs; the excluded runs are `unpricedRuns`. */
    effectiveCostUsd: number;
    /**
     * Runs with unknown EFFECTIVE cost — render "≥ $X · N unpriced" when
     * nonzero, and as wholly unknown when it equals `runs`.
     */
    unpricedRuns: number;
    /**
     * Runs with unknown LIST-PRICE cost. The two counters are independent,
     * because the two columns are: a subscription-billed run with no
     * backend-reported cost has a known effective cost of $0 and an unknown
     * list price, so it is in this counter and not in `unpricedRuns`. Render
     * `costUsd` the same way — "≥ $X · N unpriced", wholly unknown when it
     * equals `runs`.
     */
    unpricedListCostRuns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    averages: {
      runsPerDay: number | null;
      /**
       * Null while `unpricedListCostRuns > 0`: a rate over a partial sum
       * would hide the hole the sum shows.
       */
      costUsdPerDay: number | null;
      costUsdPerMonth: number | null;
      /** Null while `unpricedRuns > 0`, for the same reason. */
      effectiveCostUsdPerDay: number | null;
      effectiveCostUsdPerMonth: number | null;
    };
  };
  database: {
    /** The server database's logical size (pages × page size; WAL excluded). */
    sizeBytes: number;
  };
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

/** One decision or FYI in the Actions contribution to the in-app digest. */
export interface ActionDigestEntry {
  itemId: string;
  threadId: string;
  title: string;
}

/**
 * The Actions/FYI contribution to the in-app digest for one authenticated
 * client context, stored at its local 09:00 or 17:00 slot (#683). It lists
 * only work not yet reported to that context; unchanged decisions remain in
 * Actions without repeating here. Generation is not a delivery or read receipt.
 */
export interface ActionDigestSummary {
  generatedAt: number;
  /** The local slot this summary stands for, as a UTC instant. */
  slotAt: number;
  /** The client's validated IANA zone the slot was computed in. */
  timeZone: string;
  /** New or reawakened waiting decisions below the push cutoff. */
  waiting: Array<ActionDigestEntry & { episodeId: string }>;
  /** New FYIs. They never count as waiting decisions. */
  updates: ActionDigestEntry[];
}

/**
 * `zone_required`: no usable reported zone, so timed summaries wait for one.
 * `dismissedAt` is this client context's own dismissal, not the global
 * activity digest marker.
 */
export type ActionDigestState =
  | { status: "zone_required" }
  | { status: "ready"; timeZone: string; latest: ActionDigestSummary | null; dismissedAt: number | null };

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

// ============================================================
// Durable Queue and Actions (additive; distinct from activity notifications)
// ============================================================

export type InboxView = "queue" | "actions";
export type InboxQueueStatus = "scheduled" | "ready" | "claimed" | "done" | "blocked" | "failed" | "superseded" | "expired" | "dropped";
export type InboxActionStatus = "pending" | "snoozed" | "resolved" | "dismissed" | "expired" | "dropped";
export type InboxDismissReason = "dont_ask_again" | "wrong_call" | "need_more_info" | "no_longer_relevant";

/** Server-owned provenance and immutable trust; never accepted from a model. */
export interface InboxThread {
  id: string;
  trustClass: "trusted" | "untrusted";
  source: "share" | "cli";
  status: "open" | "closed";
  /** Bounded derived projection, not the append-only audit record. */
  stateMd: string;
  stakes: number;
  deadline?: number;
  createdAt: number;
  lastSeenAt: number;
}

/** A requested exact operation, NOT a capability grant or a tool allowlist. */
export interface InboxOperation {
  toolName: string;
  input: Record<string, unknown>;
  /** Canonical brain-relative path; the server must check its current envelope. */
  targetPath: string;
}

export interface InboxWorkPayload {
  instruction: string;
  operation?: InboxOperation;
}

/**
 * Model output is data, never authority. These payloads contain no trust,
 * principal, profile, tool-policy or grant fields. Creation AND application
 * must validate the requested operation against server-owned authority.
 * `hygiene` is server-built human review only, never generic model escalation.
 * `write_policy` and `open_session` describe deferred v2 data only; v1 uses
 * V1ResolutionEffect and v1ResolutionEffectSchema, which exclude both kinds.
 * Snooze has no model-selected time; the server derives it deterministically.
 */
export type HygieneInput = string | string[] | null;
export interface HygieneDiff {
  path: string; before: string; after: string;
  changes: Array<{ before: string; after: string; line: number }>;
}
export interface HygieneEffect {
  kind: "hygiene";
  operation: "resolve" | "check" | "undo" | "dismiss" | "snooze";
  findingId: string;
  fingerprint: string;
  handler?: string;
  input?: HygieneInput;
  previewToken?: string;
  undoToken?: string;
}
export interface HygieneAction {
  findingId: string;
  fingerprint: string;
  /** Supported CLI projection, retained as display data. */
  finding: Record<string, unknown>;
  outcome?: { version: 1; status: "applying" | "fixed" | "stale" | "refused" | "check_failed" | "still_detected" | "not_detected" | "undone" | "dismissed" | "snoozed" | "superseded"; supersededBy?: string; reason?: string; code?: string; undoToken?: string; fieldError?: { field: string; message: string } };
}
export interface HygieneReviewState {
  version: 1;
  status: "idle" | "active" | "paused" | "complete" | "blocked";
  position: number;
  fixed: number; dismissed: number; snoozed: number;
  pendingActionId?: string;
  /** Shared cap retirement pauses review without disposing its finding. */
  pauseReason?: { kind: "actions-limit"; retiredActionId: string; retirementReceiptId: string };
  counts?: { eligibleRemaining: number; fixed: number; dismissed: number; snoozed: number; nextSnoozeDueAt: string | null; informationalNotShown: number };
  blocker?: Record<string, unknown>;
}
export interface HygieneReviewCommand { operation: "start" | "pause" | "resume" | "refresh" }
export interface HygienePreviewRequest { itemId: string; optionId: string; expectedVersion: number; input: HygieneInput }
export interface HygieneReviewRead { review: HygieneReviewState; action: InboxActionItem | null }

export type ResolutionEffect =
  | HygieneEffect
  | { kind: "enqueue"; payload: InboxWorkPayload }
  | { kind: "cancel_blocked" }
  | { kind: "snooze" }
  | { kind: "dismiss"; reason?: InboxDismissReason }
  | { kind: "write_policy"; policy: { slug: string; content: string } }
  | { kind: "open_session"; seed: { prompt: string } };

export type V1ResolutionEffect = Exclude<ResolutionEffect, { kind: "write_policy" | "open_session" }>;

export interface InboxOption {
  id: string;
  label: string;
  effect: ResolutionEffect;
  /** CLI-owned input descriptor; no client-selected effect. */
  input?: { type: "none" | "string" | "enum" | "date" | "strings" | "path"; values?: string[]; example?: string };
  preview?: HygieneDiff;
}

export interface InboxItemBase {
  id: string;
  threadId: string;
  dedupKey: string;
  createdAt: number;
  updatedAt: number;
  /** UTC epoch milliseconds. Every item has an explicit expiry. */
  expiresAt: number;
  waitUntil?: number;
  version: number;
  runId?: string;
}

export type InboxQueueItem = InboxItemBase & {
  queue: "queue";
  status: InboxQueueStatus;
  attempts: number;
  maxAttempts: number;
  claimedAt?: number;
  leaseUntil?: number;
  blockedByItemId?: string;
} & (
  | { type: "triage"; payload: { stagingId: string } }
  | { type: "execute"; payload: InboxWorkPayload }
  /** Server-owned compensation; never a model-submitted effect. */
  | { type: "cleanup_pending"; payload: { stagingId: string } }
);

export type InboxActionItem = InboxItemBase & {
  queue: "actions";
  type: "approve" | "choose" | "fyi";
  status: InboxActionStatus;
  payload: { title: string; detail: string };
  /** FYIs have no options and do not count against the decision cap. */
  options: InboxOption[];
  hygiene?: HygieneAction;
};

/** Queue work acquires leases; human Actions never enter `claimed`. */
export type InboxItem = InboxQueueItem | InboxActionItem;

/** Scope survives removal: clients never derive it by joining a mutable item. */
export type InboxChange = {
  changeId: number;
  threadId: string;
  /** Per-thread order, independent of the global change cursor. */
  seq: number;
} & (
  | { kind: "upsert_thread"; thread: InboxThread }
  | { kind: "upsert_item"; itemId: string; item: InboxItem }
  | { kind: "remove_item"; itemId: string }
  | { kind: "remove_thread" }
);

/** Opt-in only after server_hello advertises inbox; no hello remains tolerated. */
export interface ClientInboxSubscribe {
  type: "inbox_subscribe";
  view: InboxView;
  /** Optional thread filter, subject to server-side principal authorization. */
  threadId?: string;
}

export interface ClientInboxUnsubscribe {
  type: "inbox_unsubscribe";
  view: InboxView;
  threadId?: string;
}

/** Select a stored option; no client-supplied effect or authority is accepted. */
export interface ClientInboxResolve {
  type: "inbox_resolve";
  itemId: string;
  optionId: string;
  /** Feedback only, never standing authority. */
  reason?: InboxDismissReason;
  /** Must exactly match the input bound to the stored preview. */
  input?: HygieneInput;
}

/** The server computes waitUntil; clients cannot override the scheduling rule. */
export interface ClientInboxSnooze {
  type: "inbox_snooze";
  itemId: string;
}

/**
 * A transactionally consistent snapshot. Chunk continuations set append;
 * highWaterSeq is per-thread and cursor is the global change high-water mark.
 * Discard deltas at/below the thread's snapshot seq. A delta before the first
 * snapshot is ignored; reconnect starts with a fresh snapshot.
 */
export interface InboxSnapshot {
  type: "inbox_snapshot";
  view: InboxView;
  threadId?: string;
  threads: InboxThread[];
  items: InboxItem[];
  highWaterSeq: Record<string, number>;
  cursor: number;
  append?: boolean;
}

export interface InboxDelta {
  type: "inbox_delta";
  view: InboxView;
  change: InboxChange;
}

// Conditional form: flat request nodes, typed visible answers (#585).
export type { AskUserFormLimits, AskUserFormNode, AskUserFormInput, AskUserFormSpec, AskUserFormAnswer, AskUserFormAnswers, AskUserFormPayload, AskUserFormSingleAnswer, AskUserFormMultiAnswer, AskUserFormScaleAnswer, AskUserFormRankAnswer } from "./tool-contracts/form.js";
export interface ServerAskUserFormRequest extends SessionScoped, AskUserFormSpec {
  type: "ask_user_form_request";
  requestId: string;
}
export interface ClientAskUserFormResponse extends AskAnswerBinding {
  type: "ask_user_form_response";
  requestId: string;
  answers: import("./tool-contracts/form.js").AskUserFormAnswers;
  turnId?: string;
}

/** Authenticated operational intake; queueing does not file brain content. */
export interface QueueAddRequest {
  key: string;
  title?: string;
  text?: string;
  url?: string;
}
export interface QueueAddResult {
  queued: true;
  created: boolean;
  threadId: string;
  itemId: string;
  stagingId: string;
}

/** Server-owned CLI staging metadata; the share manifest's source stays unchanged. */
export interface QueueStagingManifest extends ShareIntakeResult {
  source: "cli";
}
