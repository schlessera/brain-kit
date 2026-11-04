import type { VoicePermissionReceipt } from "../voice/conversation-permissions.js";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createStore } from "zustand/vanilla";
import type {
  SharedFileMeta,
  LocalExchange,
  MessageBlock,
  MessageLink,
  MessageSource,
  MessagePart,
  AskUserQuestion,
  AskUserAnnotation,
  AskUserListSpec,
  AskUserRankSpec,
  AskUserFormSpec,
  AskUserFormAnswers,
  TurnFailure,
  TurnRetry,
  ThinkingLevel,
  StateRoomObservation,
  TurnJournalSummary,
} from "@schlessera/brain-ui-sdk/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { StatsSection } from "../lib/stats/compose-stats.js";
import type { ProviderState } from "./provider-state.js";
import type { StoreEnvironment } from "./store-environment.js";
import type { ChatShellState } from "./shell-stores.js";
import { createApprovalsSlice } from "./chat-slices/approvals.js";
import { createAskUserSlice } from "./chat-slices/ask-user.js";
import { createChatSliceContext } from "./chat-slices/buffers.js";
import { createMessagesSlice } from "./chat-slices/messages.js";
import { createChatPersistence } from "./chat-slices/persistence.js";
import { createSessionSlice } from "./chat-slices/session.js";
import { createStatusSlice } from "./chat-slices/status.js";
import { createStreamingSlice } from "./chat-slices/streaming.js";
import { createTranscriptSlice } from "./chat-slices/transcript.js";
import type { AnswerDelivery } from "../lib/answer-delivery/types.js";
import type { RestoredApprovalClosure } from "../lib/restored-approvals.js";

export type { MessagePart };
export { isSettledExchange } from "./chat-slices/ask-user.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  /**
   * Chronological thinking/text/tool segments, in arrival order. `content`,
   * `thinking` and `toolCalls` remain the aggregated views (used for sharing
   * and tool state); `parts` drives rendering order.
   */
  parts: MessagePart[];
  isStreaming: boolean;
  timestamp: number;
  source?: MessageSource;
  requestId?: string;
  thinkingLevel?: ThinkingLevel;
  effectiveThinkingLevel?: ThinkingLevel;
  /** AskUserQuestion exchanges raised during this assistant turn. */
  askUserExchanges?: AskUserExchange[];
  /**
   * Image attachments on a user message. Live messages carry a local
   * `previewUrl` (object URL, revoked on clear). History-loaded messages
   * carry no data — only `attachmentCount` — since base64 is never replayed.
   */
  attachments?: MessageAttachment[];
  files?: SharedFileMeta[];
  /** Attachment count for history-loaded messages without preview data. */
  attachmentCount?: number;
  /**
   * Blocks the surface classified out of this message's text (D42), each
   * anchored to a text part and a span in it. Arrive after the turn's
   * result, or with the replayed history; absent means plain markdown.
   */
  blocks?: MessageBlock[];
  journal?: TurnJournalSummary;
  journalLive?: boolean;
  /** The host-minted turn that produced this assistant message, when known. */
  turnId?: string;
  /**
   * @internal The turn a live answer's frames named, kept when a replay
   * strips `turnId` to what history proves (#1013). Correlation only:
   * never evidence that the turn was seen.
   */
  streamTurnId?: string;
  /**
   * @internal What the host's promoted links (#1698) were applied to: the
   * text parts as they streamed, every link named so far, and the blocks as
   * the host sent them, anchored to that streamed text.
   */
  linkRewrite?: { texts: string[]; links: Record<string, string>; blocks?: MessageBlock[] };
  /**
   * A turn shell (#964, D52 §4): drawn to hold a restored approval whose
   * replay ended on the user's message. It has no text of its own, and its
   * header time is the host's `startedAt` for its turn, never the client
   * clock (#1072).
   */
  turnShell?: true;
  /**
   * The /stats answer (#97), drawn from the kit in place of text. The
   * command answers from REST, not from a turn; `localExchange` says whether
   * the host keeps it as part of the session (#582).
   */
  statsAnswer?: StatsSection[];
  /** On an assistant message answered by the client itself: the exchange and whether it is kept. */
  localExchange?: LocalExchangeState;
  /**
   * The failure that ended this assistant message's turn (#575), live from
   * the terminal frame or replayed from history. Drawn after the content.
   */
  failure?: TurnFailure;
  /** Host-retained original request available for an exact retry. */
  retryOfTurnId?: string;
  /** Received live in this client; absent on history replay. */
  failureLive?: boolean;
  /**
   * How the turn stopped, when the runtime or the host says so and no
   * failure does (#3356): a status for the turn, drawn after its content,
   * never the agent's words. `timeout` only from the host's own timeout
   * report; `aborted`/`unspecified` from the runtime's replayed notice.
   */
  runtimeNotice?: TurnNotice;
  /** The notice arrived live in this client; absent on history replay. */
  runtimeNoticeLive?: boolean;
  /** While streaming: the failed model call the runtime is retrying (#575). */
  retry?: TurnRetry;
}

/**
 * A locally answered command (`/stats`) as part of its session (#582).
 *
 * - `draft`: the conversation has no session yet. The exchange is sent with
 *   the message that starts one (`localExchangesForDraft`).
 * - `pending`: sent, and the host has not answered yet.
 * - `saved`: the host keeps it. The agent sees it with the next prompt, and
 *   replay shows it again.
 * - `unsaved`: it exists only on this screen, and the UI says so.
 */
export interface LocalExchangeState {
  id: string;
  command: string;
  prompt: string;
  /** What the command drew, as the wire carries it. */
  answer: unknown;
  /** The figures as text, for the agent. Empty once replayed. */
  context: string;
  saved: "draft" | "pending" | "saved" | "unsaved";
  /** Why it is `unsaved`. */
  reason?: string;
}

export interface MessageAttachment {
  previewUrl: string;
  mediaType: string;
}

export interface ToolCall {
  /** Local voice dispatch and host-confirmed permission evidence. */
  voicePermission?: VoicePermissionReceipt;
  policyChange?: PolicyChangeReview;
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson: string;
  output?: string;
  isError?: boolean;
  status: "streaming" | "pending_approval" | "approved" | "denied" | "complete";
  /**
   * What the pending approval is for: "tool" may be remembered via "Always
   * allow"; "command" (a destructive-bash confirmation) is per-use only.
   */
  approvalKind?: "tool" | "command" | "policy";
  /**
   * `false` when the host said it will not keep an "always allow" given on
   * this card (#147) — the request is outside the turn's enforced allowlist.
   * Absent means `approvalKind` alone decides. Read it through
   * `offersAlwaysAllow`, not directly.
   */
  approvalRememberable?: false;
  /**
   * The approval request's description. For a "command" confirmation it is
   * what the command will do, in words — the matched confirm pattern's
   * effect (#112) — and the card draws it; for a "tool" grant it is the
   * runtime's own text and is not drawn.
   */
  approvalDescription?: string;
  /**
   * The host re-delivered this pending approval after the transcript was
   * rebuilt from history (#964, D52 §4 R3): it is the original request,
   * restored, not one raised while this client watched the turn.
   */
  restored?: true;
  /**
   * The host turn that raised a restored approval (#1072), from its frame.
   * Only a restored card carries it: it is what a terminal frame or a
   * recovery envelope is matched against.
   */
  approvalTurnId?: string;
  /**
   * A restored approval the host no longer lists as pending (#1072, D52 §4
   * R3): the card is read-only and says why. Set only while the host
   * advertises session recovery; see `lib/restored-approvals.ts`.
   */
  readOnly?: RestoredApprovalClosure;
  /**
   * Execution timing for the duration badge. `startedAt` is (re)stamped when
   * the input finishes streaming or an approval is granted — so approval
   * wait time doesn't inflate the reported duration. `endedAt` is stamped by
   * the tool result. History-loaded messages carry no timing.
   */
  startedAt?: number;
  endedAt?: number;
}

/** Why a turn stopped, as `ChatMessage.runtimeNotice` records it (#3356). */
export interface TurnNotice {
  cause: "timeout" | "aborted" | "unspecified";
}

export interface AskUserExchange {
  requestId: string;
  /** Host terminal state ended the unanswered exchange. */
  terminal?: true;
  /**
   * The host's turn limit is what ended it (#3356), from the terminal frame;
   * absent when the host did not say why the turn ended.
   */
  endedBy?: "timeout";
  /**
   * The host turn that raised the request, from the request frame. A card
   * rebuilt from history has none until the host re-delivers the request.
   */
  turnId?: string;
  /** The `ask_user` questions; empty for an `ask_user_list` exchange. */
  questions: AskUserQuestion[];
  /**
   * Present when this is an `ask_user_list` exchange (#583): one scale over a
   * list of items. Such an exchange has no `questions`, and its `answers` are
   * keyed by item id rather than by question text.
   */
  list?: AskUserListSpec;
  rank?: AskUserRankSpec;
  form?: AskUserFormSpec;
  formAnswers?: AskUserFormAnswers;
  visibleNodes?: string[];
  order?: string[];
  unchanged?: boolean;
  /** Filled in once the user submits. Keyed by question text, or by item id
   * for a list exchange. A skipped list item is absent. */
  answers?: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
  /** A list exchange's per-item notes, keyed by item id. */
  notes?: Record<string, string>;
  cancelled?: boolean;
  /**
   * The user answered in the composer instead of choosing an option, and the
   * composer text was bound to the question (D38 §1: the card then quotes what
   * it took, with a neutral border). Live-only: the `ask_user` tool output the
   * server persists is `{answers, annotations}` and carries no such flag, so a
   * resumed transcript rebuilds a typed exchange as a plain `answered` one.
   */
  typed?: boolean;
  /**
   * When the answer was submitted, from this client's clock. Absent on
   * history-loaded exchanges — the persisted tool output carries no time, and
   * the card shows none rather than one it made up.
   */
  answeredAt?: number;
}

/**
 * One session's live transcript state. Every session the user has viewed (or
 * that bound from the draft) keeps its own buffer, so frames from a background
 * session accumulate in THAT session's transcript instead of being discarded —
 * the multi-session contract the old single-active-buffer store violated.
 */
export interface SessionChat {
  /** Turn-scoped receipts may precede the first assistant frame. Never persisted in browser storage. */
  journals?: Record<string, TurnJournalSummary>;
  messages: ChatMessage[];
  isStreaming: boolean;
  /**
   * The currently-pending ask-user exchange in this session (no answers yet).
   * Mirrors the same exchange that lives on the streaming assistant message;
   * held here for fast lookup by hooks/components.
   */
  askUser: AskUserExchange | null;
  /** LRU stamp for buffer eviction. */
  lastTouched: number;
  /**
   * @internal The latest history replay (#1013): what was on screen before
   * it, and every message its chunks have brought so far, so each appended
   * chunk is reconciled against the same transcript the first one was.
   */
  replay?: { base: Pick<SessionChat, "messages" | "isStreaming">; received: ChatMessage[] };
  /**
   * @internal This client holds the session's whole transcript (#1328): the host's
   * history for it arrived (an empty one counts), or the buffer is the one
   * this client started the conversation in. A buffer opened for a stored or
   * selected session before its history comes back is not, however empty.
   */
  historyConfirmed?: true;
}

/**
 * Why a selected session's history could not be restored (#1328): the host
 * reported a load error, or nothing answered within the bound.
 */
export interface RestoreFailure {
  reason: "error" | "timeout" | "missing";
  message?: string;
}

/**
 * The selected session whose transcript this client has not yet received
 * (#1328), or null. Until its history arrives the view must not read as a new
 * chat, and nothing may be sent into it: the reader cannot see what the agent
 * would answer from.
 */
export type Restoration =
  | { sessionId: string; phase: "restoring" }
  | { sessionId: string; phase: "failed"; failure: RestoreFailure };

/**
 * Buffer key: a server sessionId, or null for the DRAFT buffer — the new
 * conversation that has no server identity yet. `session_info` re-keys the
 * draft onto its real sessionId via bindDraftSession().
 */
export type ChatKey = string | null;

export interface PendingTurnRetry {
  requestId: string;
  failedTurnId: string;
  state: "waiting" | "unknown" | "refused";
  message?: string;
}

export interface ChatState {
  /** Explicit UI history target routing; never inferred from an opaque backend ID. */
  historyOwners: Record<string,string>;
  setHistoryOwner(key:string,ownerId:string|null):void;
  stateRooms: Record<string, { observation: StateRoomObservation; historical: boolean }>;
  stateRoomPreferences: Record<string, { dismissedAllowance?: number; invalidatedAt?: number; backendId?: string; measuredAt?: number }>;
  stateRoomAnnouncements: Record<string, number>;
  setStateRoom(sessionId: string, observation: StateRoomObservation | undefined, historical?: boolean): void;
  dismissStateRoom(sessionId: string, allowanceBytes: number): void;
  invalidateStateRoom(sessionId: string, observedAt: number): void;
  markStateRoomAnnounced(sessionId: string, allowanceBytes: number): void;
  /** Ephemeral correlated chat acknowledgements; never written to browser storage. */
  scopeDecisionReceipts: Record<string, import("@schlessera/brain-ui-sdk/protocol").ServerScopeDecisionReceipt>;
  setScopeDecisionReceipt(receipt: import("@schlessera/brain-ui-sdk/protocol").ServerScopeDecisionReceipt): void;
  chatReceipts: Record<string, { state: "accepted" | "refused"; sessionId?: string }>;
  setChatReceipt(requestId: string, state: "accepted" | "refused", sessionId?: string): void;
  clearChatReceipt(requestId: string): void;
  setMessageEffort(key: ChatKey, requestId: string, thinkingLevel: ThinkingLevel, effectiveThinkingLevel?: ThinkingLevel): void;
  turnRetries: Record<string, PendingTurnRetry>;
  setTurnRetry(sessionId: string, retry: PendingTurnRetry | null): void;
  setRetryHandle(key: ChatKey, retryOfTurnId: string | undefined): void;
  /** Per-session transcript buffers, keyed by server sessionId. */
  buffers: Record<string, SessionChat>;
  /**
   * How many replayed-history chunks each session has received. A reader
   * that asked for fresh history (the handoff review, #61) waits for this
   * to move instead of trusting a cached buffer.
   */
  historyLoads: Record<string, number>;
  noteHistoryLoaded: (sessionId: string) => void;
  /** The unbound new-conversation buffer, if one is in progress. */
  draft: SessionChat | null;
  /**
   * Correlation id for the conversation the draft is currently starting.
   *
   * A client starting a conversation has no session id, so it used to adopt
   * the FIRST `session_info` for an unknown session — which could be an older
   * background turn's, or another client's, silently binding the user's draft
   * to someone else's transcript. The id is sent on `chat_message` and echoed
   * on `session_info`; adoption now requires a match. Null when no draft turn
   * is in flight.
   */
  pendingDraftId: string | null;
  /**
   * New-conversation transcripts the reader left by New chat or by opening
   * a session while their first message was still unanswered, by their
   * `pendingDraftId` (#951, D52 §5). The matching `session_info` gives each
   * its session without selecting it, so a late announcement can never
   * take over the view, or a newer new-chat transcript, it no longer owns.
   */
  detachedDrafts: Record<string, SessionChat>;
  /** A detached new conversation got its session: it is that session's buffer now. */
  bindDetachedDraft: (correlationId: string, sessionId: string) => void;
  /**
   * Take a send's optimistic rows out of its transcript: its user message
   * and the empty reply opened for it. The send has no proof of acceptance,
   * and its review block (D52 §5) stands in for it.
   */
  withdrawSend: (key: ChatKey, requestId: string) => void;
  /** The session in view; null = the draft / new-chat view. */
  activeSessionId: string | null;
  /** Sessions whose history restoration failed, until history for them arrives (#1328). */
  restoreFailures: Record<string, RestoreFailure>;
  /** Record that a session's history could not be restored. */
  failRestore: (sessionId: string, failure: RestoreFailure) => void;
  /** Retry: the session's restoration is waiting on the host again. */
  clearRestoreFailure: (sessionId: string) => void;

  /**
   * Live run-state per session id, for the session-list badges. Maintained for
   * every session frame regardless of whether a buffer exists. "idle" is the
   * absence of a running/queued turn.
   */
  runStates: Record<string, "streaming" | "queued" | "idle">;
  /**
   * Backend that owns each session, from `session_info` (or the session list
   * for history sessions). Scopes tool-call renderer resolution per backend;
   * absence falls back to the deployment default.
   */
  backendIds: Record<string, string>;
  /**
   * Per-session note attached to a `queued` status — the host sends one once a
   * session's follow-up queue grows heavy. Cleared when the session leaves the
   * queued state, so a stale warning cannot outlive the queue it described.
   */
  queueNotes: Record<string, string>;

  // Buffer mutations (key: sessionId, or null for the draft)
  addUserMessage: (
    key: ChatKey,
    text: string,
    source?: MessageSource,
    attachments?: MessageAttachment[],
    effort?: { requestId: string; thinkingLevel?: ThinkingLevel },
    files?: SharedFileMeta[]
  ) => void;
  startAssistantMessage: (key: ChatKey, turnId?: string, requestId?: string) => void;
  appendText: (key: ChatKey, text: string) => void;
  appendThinking: (key: ChatKey, text: string) => void;
  /** Attach the /stats answer to the assistant message being written. */
  setStatsAnswer: (key: ChatKey, sections: StatsSection[]) => void;
  /** Attach a local exchange to the assistant message being written (#582). */
  setLocalExchange: (key: ChatKey, exchange: LocalExchangeState) => void;
  /**
   * Record what became of a local exchange, wherever its message now is: a
   * draft's exchange is answered once the draft has become a session.
   */
  markLocalExchange: (
    exchangeId: string,
    saved: LocalExchangeState["saved"],
    reason?: string
  ) => void;
  startToolCall: (key: ChatKey, toolUseId: string, toolName: string) => void;
  appendToolInput: (key: ChatKey, partialJson: string) => void;
  completeToolCall: (
    key: ChatKey,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => void;
  requestToolApproval: (
    key: ChatKey,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    description?: string,
    kind?: "tool" | "command" | "policy",
    rememberable?: boolean,
    /** The host turn the request belongs to, from the frame. */
    turnId?: string
  ) => void;
  applyVoicePermission: (receipt: VoicePermissionReceipt) => void;
  resolveToolApproval: (key: ChatKey, toolUseId: string, approved: boolean) => void;
  /**
   * Make restored approval cards read-only, each with the host fact that
   * closed it (#1072, D52 §4 R3). Only a restored card that is not already
   * closed takes one, except `unlisted`, which a reason replaces. Nothing is
   * sent.
   */
  closeRestoredApprovals: (key: ChatKey, closures: ReadonlyArray<{ toolUseId: string; closure: RestoredApprovalClosure }>) => void;
  /**
   * The principal is no longer authorized (a 401/403 read or a revocation):
   * every restored card in every buffer reads `no longer yours to answer`,
   * and drops the request and turn identities it held.
   */
  revokeRestoredApprovals: () => void;
  /** An envelope that counts lists these again: an `unlisted` card takes a decision again. */
  reopenRestoredApprovals: (key: ChatKey, toolUseIds: readonly string[]) => void;
  setToolResult: (key: ChatKey, toolUseId: string, output: string, isError: boolean, policyChange?: PolicyChangeReview) => void;
  setAskUserRequest: (key: ChatKey, requestId: string, questions: AskUserQuestion[], turnId?: string) => void;
  /** An `ask_user_list` request: the same exchange slot, holding a list. */
  setAskUserListRequest: (key: ChatKey, requestId: string, list: AskUserListSpec, turnId?: string) => void;
  setAskUserRankRequest: (key: ChatKey, requestId: string, rank: AskUserRankSpec, turnId?: string) => void;
  setAskUserFormRequest: (key: ChatKey, requestId: string, form: AskUserFormSpec, turnId?: string) => void;
  submitAskUserFormAnswers: (key: ChatKey, requestId: string, formAnswers: AskUserFormAnswers, visibleNodes: string[]) => void;
  submitAskUserRankOrder: (key: ChatKey, requestId: string, order: string[], unchanged: boolean) => void;
  submitAskUserListAnswers: (
    key: ChatKey,
    requestId: string,
    answers: Record<string, string>,
    notes?: Record<string, string>
  ) => void;
  submitAskUserAnswers: (
    key: ChatKey,
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>,
    /** `true` when the answer was taken from the composer, not an option. */
    typed?: boolean
  ) => void;
  cancelAskUser: (key: ChatKey, requestId: string) => void;
  /**
   * Make a submitted exchange editable again: its answer is cleared and it is
   * the buffer's pending exchange once more. Only for an answer the host has
   * confirmed it did not take (#910).
   */
  reopenAskExchange: (key: ChatKey, requestId: string) => void;
  clearAskUser: (key: ChatKey) => void;
  /**
   * The turn ended: its unanswered questions can no longer be answered.
   * `endedBy` records the host's stated reason on them, including on
   * questions an earlier terminal frame of the same turn already ended.
   */
  endTurnQuestions: (key: ChatKey, turnId?: string, endedBy?: "timeout") => void;
  /**
   * Record how a turn stopped (#3356) on its assistant message, as
   * `failAssistantMessage` finds it. A turn that already shows a failure
   * keeps that, the fuller account; the same notice twice is one notice.
   */
  setTurnNotice: (key: ChatKey, notice: TurnNotice, turnId?: string) => void;
  /**
   * Delivery state of submitted ask answers, by request id (#910). Held
   * outside the transcript buffers: an answer queued in one session must
   * keep its state while another is in view, and survive a history replace.
   */
  deliveries: Record<string, AnswerDelivery>;
  setDelivery: (requestId: string, delivery: AnswerDelivery | null) => void;
  finishAssistantMessage: (key: ChatKey) => void;
  /**
   * End a turn on `failure` (#575): the turn's assistant message — the one
   * carrying `turnId`, else the last assistant message when no other turn
   * owns it — records it and stops streaming. A turn that never opened a
   * message gets one, so a failure is never left without a row. A message
   * that already records a failure keeps the first unless `replace` is set:
   * one failure is shown once, and the terminal frame's is the fullest.
   */
  failAssistantMessage: (
    key: ChatKey,
    failure: TurnFailure,
    turnId?: string,
    replace?: boolean
  ) => void;
  /** Show (or with null, clear) the retry the streaming turn is waiting on. */
  setRetry: (key: ChatKey, retry: TurnRetry | null) => void;
  /**
   * Attach classified blocks (D42) to the assistant message of `turnId`, or,
   * when the turn is unknown, to the last assistant message only if it has
   * finished — never to a newer message still streaming.
   */
  setMessageBlocks: (key: ChatKey, blocks: MessageBlock[], turnId?: string) => void;
  setTurnJournal: (key: ChatKey, turnId: string, journal: TurnJournalSummary) => void;
  /**
   * Rewrite the link destinations the host rewrote in the saved answer
   * (#1698) in the assistant messages of `turnId`, or, when no message
   * carries a turn, in the last assistant message if it has none of its
   * own. Only text that changes is replaced, so nothing else re-renders.
   */
  rewriteMessageLinks: (key: ChatKey, links: MessageLink[], turnId?: string) => void;
  /**
   * Record the host-minted turn on the streaming assistant message, from
   * the first scoped frame. The composer opens the message optimistically
   * before any turn exists, so the id arrives with the deltas.
   */
  stampTurn: (key: ChatKey, turnId: string) => void;
  setStreaming: (key: ChatKey, streaming: boolean) => void;
  /** Replace a session's transcript (first replayed history chunk). Creates the buffer. */
  setMessages: (key: ChatKey, messages: ChatMessage[]) => void;
  /** Concatenate a continuation chunk of replayed history. Creates the buffer. */
  appendMessages: (key: ChatKey, messages: ChatMessage[]) => void;
  /** @internal The host's status after history settles a chunked replay. */
  finishHistoryReplay: (key: ChatKey, keepRunning?: boolean) => void;

  // Session lifecycle
  /**
   * Adopt the draft buffer as `sessionId` (the server just named the session).
   * If the draft view is active, the view follows. No-op draft = empty buffer.
   */
  bindDraftSession: (sessionId: string) => void;
  /** Mint and remember the correlation id for a draft turn about to be sent. */
  startDraftTurn: () => string;
  /** Switch the view to a session (creating an empty buffer if none), or to the draft (null). */
  setActiveSession: (sessionId: string | null) => void;
  /**
   * New chat: unbind the view, unpin the provider, and give the new-chat
   * view a fresh composer draft (D52 §5). A new conversation still waiting
   * for its first answer is detached, not dropped; any other draft
   * transcript is dropped.
   */
  clearMessages: () => void;
  setRunState: (
    sessionId: string,
    state: "streaming" | "queued" | "idle",
    note?: string
  ) => void;
  /** Record which backend owns a session (idempotent). */
  setSessionBackend: (sessionId: string, backendId: string) => void;

  /**
   * Text waiting to be put into the composer: an answer suggestion the reader
   * took (#40). The draft lives in the composer, not here, so a taker posts
   * the text and the composer merges it into its draft and clears the
   * request. `seq` tells two takes of the same text apart. Nothing is sent.
   */
  composerInsert: { seq: number; text: string } | null;
  requestComposerInsert: (text: string) => void;
  /** Clear the request the composer has applied; a newer one is kept. */
  clearComposerInsert: (seq: number) => void;
}
/** Frozen empty buffer for selectors when nothing is in view. */
const EMPTY_CHAT: SessionChat = Object.freeze({
  messages: Object.freeze([]) as unknown as ChatMessage[],
  isStreaming: false,
  askUser: null,
  lastTouched: 0,
});

/**
 * The selected session's restoration (#1328): null when nothing is selected
 * or its transcript is confirmed. Derived from the buffer, so a session whose
 * buffer was evicted is restoring again when it is selected again.
 */
export function restorationOf(state: Pick<ChatState, "activeSessionId" | "buffers" | "restoreFailures">): Restoration | null {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.buffers[sessionId]?.historyConfirmed) return null;
  const failure = state.restoreFailures[sessionId];
  return failure ? { sessionId, phase: "failed", failure } : { sessionId, phase: "restoring" };
}

/** The buffer currently in view (draft when no session is bound). */
export function activeChat(state: ChatShellState): SessionChat {
  if (state.activeSessionId) return state.buffers[state.activeSessionId] ?? EMPTY_CHAT;
  return state.draft ?? EMPTY_CHAT;
}

/**
 * The local exchanges a draft holds that the host has not kept yet (#582),
 * as the message that starts its session carries them. A `pending` one is
 * sent again: the message that carried it may have been refused, and the
 * host keeps an exchange id once.
 */
export function localExchangesForDraft(state: ChatState): LocalExchange[] {
  return (state.draft?.messages ?? []).flatMap((message) => {
    const exchange = message.localExchange;
    if (!exchange || (exchange.saved !== "draft" && exchange.saved !== "pending")) return [];
    return [{
      id: exchange.id,
      command: exchange.command,
      prompt: exchange.prompt,
      answer: exchange.answer,
      context: exchange.context,
    }];
  });
}

/** True when ANY buffer is streaming (service-worker busy check, etc.). */
export function anyStreaming(state: ChatShellState): boolean {
  if (state.draft?.isStreaming) return true;
  return Object.values(state.buffers).some((b) => b.isStreaming);
}

/**
 * Whether a pending approval may offer "always allow": never for a
 * destructive-command confirmation, and never when the host said it would
 * not keep the grant. Both approval surfaces and the Actions receipt read
 * this one rule, so the button and the receipt cannot disagree.
 */
export function offersAlwaysAllow(tool: Pick<ToolCall, "approvalKind" | "approvalRememberable">): boolean {
  return tool.approvalKind !== "command" && tool.approvalKind !== "policy" && tool.approvalRememberable !== false;
}

/**
 * Every tool call waiting on the user, across every buffer (D37: an approval
 * that arrived while you were reading something else cannot only exist as a
 * scroll position — the Actions pane lists it beside the inbox). The key is
 * the buffer's, so the decision can be resolved on the right transcript.
 */
export function pendingApprovals(state: Pick<ChatState, "buffers" | "draft">): Array<{ key: ChatKey; tool: ToolCall }> {
  const out: Array<{ key: ChatKey; tool: ToolCall }> = [];
  const scan = (key: ChatKey, chat: SessionChat | null) => {
    if (!chat) return;
    for (const message of chat.messages) {
      for (const tool of message.toolCalls) if (awaitsDecision(tool)) out.push({ key, tool });
    }
  };
  for (const [id, chat] of Object.entries(state.buffers)) scan(id, chat);
  scan(null, state.draft);
  return out;
}

/**
 * The card still takes a decision: it is pending, and no restored-card
 * closure (#1072) has made it read-only.
 */
export function awaitsDecision(tool: ToolCall): boolean {
  return tool.status === "pending_approval" && !tool.readOnly && (!tool.voicePermission || tool.voicePermission.phase === "pending");
}


/**
 * One root's chat store, composed of slices that share its buffers (#1361):
 * session, status, messages, streaming, approvals, ask-user and transcript.
 */
export function createChatStore(env: StoreEnvironment, provider: StoreApi<ProviderState>, composerDrafts?: StoreApi<{ newChat(): void }>) {
  const persistence = createChatPersistence(env);
  return createStore<ChatState>((set, get) => {
    const ctx = createChatSliceContext(set, get);
    return {
      ...createStatusSlice(ctx, persistence),
      ...createSessionSlice(ctx, persistence, provider, composerDrafts),
      ...createMessagesSlice(ctx),
      ...createApprovalsSlice(ctx),
      ...createAskUserSlice(ctx),
      ...createStreamingSlice(ctx),
      ...createTranscriptSlice(ctx),
    };
  });
}
