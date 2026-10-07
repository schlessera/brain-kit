import { createStore } from "zustand/vanilla";
import type {
  SharedFileMeta,
  LocalExchange,
  MessageBlock,
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
} from "@schlessera/brain-ui-sdk/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { StatsSection } from "../components/chat/stats/compose-stats.js";
import type { ProviderState } from "./provider-state.js";
import type { StoreEnvironment } from "./store-environment.js";
import type { ChatShellState } from "./shell-stores.js";
import type { AnswerDelivery } from "../lib/answer-delivery/types.js";
import type { RestoredApprovalClosure } from "../lib/restored-approvals.js";

export type { MessagePart };

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
  /** The host-minted turn that produced this assistant message, when known. */
  turnId?: string;
  /**
   * @internal The turn a live answer's frames named, kept when a replay
   * strips `turnId` to what history proves (#1013). Correlation only:
   * never evidence that the turn was seen.
   */
  streamTurnId?: string;
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
  approvalKind?: "tool" | "command";
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

export interface AskUserExchange {
  requestId: string;
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

/** The exchange has an outcome: answered (in any of the four shapes) or dismissed. */
export function isSettledExchange(exchange: AskUserExchange): boolean {
  return !!(exchange.answers || exchange.order || exchange.formAnswers || exchange.cancelled);
}

/**
 * Open an ask exchange: attached to the streaming assistant message, where the
 * transcript draws it, and held as the session's pending exchange. `ask_user`
 * and `ask_user_list` share the slot, so the composer, the suggestions row and
 * the tool-result cleanup treat either the same way.
 *
 * One request is one card (#910). The host re-delivers a pending request on
 * every reconnect and after `session_resume`, and history may already have
 * rebuilt it under the same id, so a request already in the buffer is
 * UPDATED, never appended again:
 *
 * - a settled card stays settled: a late or replayed request frame cannot
 *   revive an answered or dismissed question;
 * - a pending card keeps its payload and whatever the user is drafting in it,
 *   and learns its turn if it did not know it;
 * - a request claiming a different turn than the card already holds is a
 *   contradiction, not an update, and is ignored. The host's receipt is what
 *   decides which binding is real.
 */
function addExchange(
  chat: SessionChat,
  exchange: AskUserExchange
): Partial<Pick<SessionChat, "messages" | "askUser">> {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i]!;
    const index = message.askUserExchanges?.findIndex((e) => e.requestId === exchange.requestId) ?? -1;
    if (index === -1) continue;
    const existing = message.askUserExchanges![index]!;
    if (isSettledExchange(existing)) return {};
    if (existing.turnId && exchange.turnId && existing.turnId !== exchange.turnId) return {};
    const merged: AskUserExchange =
      existing.turnId || !exchange.turnId ? existing : { ...existing, turnId: exchange.turnId };
    const msgs = [...chat.messages];
    const exchanges = [...message.askUserExchanges!];
    exchanges[index] = merged;
    msgs[i] = { ...message, askUserExchanges: exchanges };
    const slot = chat.askUser;
    const askUser = !slot || slot.requestId === merged.requestId || isSettledExchange(slot) ? merged : slot;
    return { messages: msgs, askUser };
  }
  const msgs = [...chat.messages];
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  if (last?.role === "assistant") {
    msgs[lastIdx] = {
      ...last,
      askUserExchanges: [...(last.askUserExchanges ?? []), exchange],
    };
  }
  return { messages: msgs, askUser: exchange };
}

/**
 * One session's live transcript state. Every session the user has viewed (or
 * that bound from the draft) keeps its own buffer, so frames from a background
 * session accumulate in THAT session's transcript instead of being discarded —
 * the multi-session contract the old single-active-buffer store violated.
 */
export interface SessionChat {
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
}

/**
 * Buffer key: a server sessionId, or null for the DRAFT buffer — the new
 * conversation that has no server identity yet. `session_info` re-keys the
 * draft onto its real sessionId via bindDraftSession().
 */
export type ChatKey = string | null;

/** Retained transcript buffers beyond the active one (LRU-evicted). */
const MAX_BUFFERS = 8;

export interface PendingTurnRetry {
  requestId: string;
  failedTurnId: string;
  state: "waiting" | "unknown" | "refused";
  message?: string;
}

export interface ChatState {
  /** Ephemeral correlated chat acknowledgements; never written to browser storage. */
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
    kind?: "tool" | "command",
    rememberable?: boolean,
    /** The host turn the request belongs to, from the frame. */
    turnId?: string
  ) => void;
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
  setToolResult: (key: ChatKey, toolUseId: string, output: string, isError: boolean) => void;
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
  finishHistoryReplay: (key: ChatKey) => void;

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

/**
 * History rebuilds an exchange from its tool call, which names no turn. When
 * the buffer it replaces had already learned the turn from the live request,
 * keep it: the answer must be sent with that binding.
 */
function withKnownTurns(next: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const turns = new Map<string, string>();
  for (const m of previous) for (const e of m.askUserExchanges ?? []) if (e.turnId) turns.set(e.requestId, e.turnId);
  if (turns.size === 0) return next;
  return next.map((m) =>
    m.askUserExchanges?.some((e) => !e.turnId && turns.has(e.requestId))
      ? {
          ...m,
          askUserExchanges: m.askUserExchanges.map((e) =>
            !e.turnId && turns.has(e.requestId) ? { ...e, turnId: turns.get(e.requestId)! } : e
          ),
        }
      : m
  );
}

/**
 * A history replay of a transcript already on screen (a reconnect's resume or
 * snapshot, #1013) keeps what it repeats: a message at the same place with the
 * same role and text keeps its id and time, so React keeps its node and the
 * reader's place. The streaming answer counts as repeated when one text
 * continues the other, and it stays streaming: the host's status after the
 * history says whether the turn is still running, and only that ends it.
 */
function drawnText(message: ChatMessage): string {
  return message.parts.filter((part) => part.kind === "text").map((part) => part.text).join("") || message.content;
}

/** Lost deltas leave holes; subsequent deltas retain their order. */
function includesDrawnText(text: string, drawn: string): boolean {
  let at = 0;
  for (let i = 0; i < text.length && at < drawn.length; i++) if (text[i] === drawn[at]) at++;
  return at === drawn.length;
}

/** The host's display-size bound must not shorten text the page already drew. */
function keepUnclippedText(next: string | undefined, old: string | undefined): string | undefined {
  const elision = next?.match(/\n…\[\d+ chars elided\]$/);
  return elision && old?.startsWith(next!.slice(0, elision.index)) ? old : next;
}

/** Clipped blocks may split a live text part differently from stored entries. */
function restoreClippedParts(parts: MessagePart[], old: ChatMessage): MessagePart[] {
  const offsets = { text: 0, thinking: 0 };
  return parts.map((part, index) => {
    if (part.kind === "tool") return part;
    const prior = old.parts.filter((p) => p.kind === part.kind).map((p) => (p as { text: string }).text);
    const all = prior.join("") || (part.kind === "text" ? old.content : old.thinking ?? "");
    const at = offsets[part.kind];
    const elision = part.text.match(/\n…\[(\d+) chars elided\]$/);
    let text = part.text;
    if (elision && all.startsWith(text.slice(0, elision.index), at)) {
      // Restore through the drawn block containing this prefix, rather than
      // swallowing later blocks around a tool or thinking section.
      let end = 0;
      for (const block of prior) {
        end += block.length;
        if (end >= at + elision.index! && end > at) break;
      }
      // Stored blocks can share one live block across missed intervening
      // parts. Nonfinal prefixes stop at their stored text boundary.
      if (parts.slice(index + 1).some((p) => p.kind === part.kind)) end = Math.min(end, at + elision.index! + Number(elision[1]));
      text = all.slice(at, prior.length ? end : all.length);
    }
    offsets[part.kind] = all.startsWith(text, at) ? at + text.length : at;
    return text === part.text ? part : { ...part, text };
  });
}

function keepDrawnMessages(next: ChatMessage[], previous: Pick<SessionChat, "messages" | "isStreaming">, partial = true): Pick<SessionChat, "messages" | "isStreaming"> {
  // Only the transcript's tail can still be streaming: a message after it
  // (a follow-up that started) means its turn is over.
  const tail = next.length - 1;
  let streaming = false;
  const messages = next.map((received, i) => {
    const old = previous.messages[i];
    if (!old || old.role !== received.role) return received;
    const toolsElided = received.content.match(/\n…\[(\d+) tool calls elided\]$/);
    const boundedTools = toolsElided && Number(toolsElided[1]) <= old.toolCalls.length - received.toolCalls.length
      && received.toolCalls.every((tool, k) => tool.id === old.toolCalls[k]?.id);
    const content = boundedTools ? received.content.slice(0, toolsElided.index) : received.content;
    const unclippedContent = keepUnclippedText(content, old.content)!;
    const m = {
      ...received,
      content: unclippedContent,
      thinking: keepUnclippedText(received.thinking, old.thinking),
      parts: restoreClippedParts(received.parts.filter((part) => !boundedTools || part.kind !== "text" || part.text !== toolsElided![0]), old),
      toolCalls: [...received.toolCalls, ...(boundedTools ? old.toolCalls.slice(received.toolCalls.length) : [])].map((tool) => ({
        ...tool, output: keepUnclippedText(tool.output, old.toolCalls.find((t) => t.id === tool.id)?.output),
      })),
    };
    if (/\n…\[\d+ chars elided\]/.test(content)) m.content = drawnText(m);
    if (content !== unclippedContent && unclippedContent === old.content && drawnText(old).startsWith(drawnText(m))) m.content = old.content;
    // The array bound can omit a new trailing block while the aggregate
    // still carries it. Keep drawn cards, then add the newly proven suffix.
    if (m.content.startsWith(old.content) && m.content.length >= old.content.length
      && (boundedTools || m.content.length > old.content.length || drawnText(m).length < drawnText(old).length)
      && drawnText(m).length <= drawnText(old).length
      && (!old.turnId || !m.turnId || old.turnId === m.turnId)
      && old.toolCalls.slice(0, Math.min(old.toolCalls.length, m.toolCalls.length)).every((t, k) => t.id === m.toolCalls[k]!.id)) {
      const parts = [...old.parts];
      for (const [toolIndex, tool] of m.toolCalls.entries()) {
        if (!old.toolCalls.some((t) => t.id === tool.id)) parts.push({ kind: "tool", toolIndex });
      }
      const suffix = m.content.slice(old.content.length);
      m.parts = suffix ? appendPart(parts, "text", suffix) : parts;
    }
    const live = previous.isStreaming && old.isStreaming === true && m.role === "assistant";
    // Claude history adds separators to its aggregate across assistant
    // entries; the chronological text parts are the actual drawn text.
    const mine = drawnText(old), theirs = drawnText(m);
    const provenTurn = m.turnId && m.turnId === (old.turnId ?? old.streamTurnId);
    const clipped = received.parts.some((p) => p.kind === "text" && /\n…\[\d+ chars elided\]$/.test(p.text));
    const opening = received.parts.find((p) => p.kind === "text");
    // A bound cannot disprove this drawn continuation: retain even a short
    // shared opening until the scoped status settles its turn. Tool/request
    // identities and a different proven turn still reject a replacement.
    const boundedContinuation = clipped && opening?.kind === "text" && mine.length > 0
      && opening.text.length > 0 && opening.text[0] === mine[0];
    const continuing = live || !!(old.turnId ?? old.streamTurnId);
    const same = mine === theirs || boundedContinuation || (continuing && (provenTurn || theirs.startsWith(mine) || mine.startsWith(theirs)
      || (mine.length > 0 && theirs.length > 0 && (includesDrawnText(theirs, mine) || includesDrawnText(mine, theirs)))));
    // Text alone does not make it the same message: a tool-only answer has
    // none, and its cards keep state. A known turn or request must agree.
    const shared = Math.min(old.toolCalls.length, m.toolCalls.length);
    const sharedOld = old.toolCalls.filter((t) => m.toolCalls.some((n) => n.id === t.id));
    const sharedNext = m.toolCalls.filter((t) => old.toolCalls.some((n) => n.id === t.id));
    const compatibleTools = sharedOld.every((t, k) => t.id === sharedNext[k]?.id)
      && (sharedOld.length > 0 || !old.toolCalls.length || !m.toolCalls.length);
    const sameTools = continuing ? compatibleTools || (live && provenTurn)
      : old.toolCalls.length === m.toolCalls.length && old.toolCalls.slice(0, shared).every((t, k) => t.id === m.toolCalls[k]!.id);
    const knownTurn = old.turnId ?? old.streamTurnId;
    const sameTurn = !knownTurn || !m.turnId || knownTurn === m.turnId;
    if (!same || !sameTools || !sameTurn) return m;
    if (live && i === tail) {
      streaming = true;
      return mergeLive(old, m);
    }
    if (boundedContinuation && m.parts.some((p) => p.kind === "text" && /\n…\[\d+ chars elided\]$/.test(p.text))) {
      return { ...mergeLive(old, m), isStreaming: false };
    }
    return { ...m, id: old.id, timestamp: old.timestamp, ...(old.attachments ? { attachments: old.attachments } : {}) };
  });
  // The first frame can be only a prefix. Keep its matching drawn suffix
  // until the host's post-history status settles the replay: otherwise a
  // painted frame between WS tasks unmounts it and loses the scroll anchor.
  if (partial && next.length < previous.messages.length) {
    const suffix = previous.messages.slice(next.length).map((m) => m.isStreaming
      ? { ...m, turnId: undefined, streamTurnId: m.turnId ?? m.streamTurnId } : m);
    return { messages: [...messages, ...suffix], isStreaming: previous.isStreaming };
  }
  // A backend may keep an answer only once it ends, so a replay mid-turn can
  // stop just before the answer on screen. Everything else repeated: the
  // answer is still being written, and stays (the turn's end replays again).
  const live = previous.messages.at(-1);
  if (previous.isStreaming && live?.role === "assistant" && live.isStreaming
    && next.length === previous.messages.length - 1 && messages.every((m, i) => m.id === previous.messages[i]!.id)) {
    return { messages: [...messages, { ...live, turnId: undefined, streamTurnId: live.turnId ?? live.streamTurnId }], isStreaming: true };
  }
  return { messages, isStreaming: streaming };
}

/**
 * The live answer, from the page's copy and the host's: each may hold
 * progress the other lacks (text the page missed while away, a tool or
 * thinking that arrived while the history was read). A lagging copy cannot
 * erase text already drawn, even if it is longer; the other's tools join
 * the retained copy, and its outputs fill that copy's.
 * The turn is the history's alone: only a host-proven turn may let the
 * reader's view clear a tracker (D52 §4). The frames' turn stays for
 * correlation.
 */
function mergeLive(old: ChatMessage, m: ChatMessage): ChatMessage {
  const thinkingSize = (message: ChatMessage) => message.parts.reduce((n, p) => n + (p.kind === "thinking" ? p.text.length : 0), 0);
  const moreThinking = thinkingSize(m) > thinkingSize(old);
  const unresolvedClip = m.parts.some((p) => p.kind === "text" && /\n…\[\d+ chars elided\]$/.test(p.text));
  const base = unresolvedClip || !includesDrawnText(drawnText(m), drawnText(old))
    || (drawnText(old).length === drawnText(m).length && !moreThinking && m.toolCalls.length <= old.toolCalls.length) ? old : m;
  const other = base === old ? m : old;
  const theirs = new Map(other.toolCalls.map((t) => [t.id, t]));
  // A tool the other copy saw finish is that copy's, state and all: an
  // approval the host settled meanwhile is not offered again.
  const toolCalls = base.toolCalls.map((t) => {
    const o = theirs.get(t.id);
    if (!o && t.status === "pending_approval") return { ...t, restored: true as const, approvalTurnId: undefined };
    return o && ((o.output !== undefined && t.output === undefined) || ((t.status === "streaming" || t.status === "pending_approval") && o.status !== t.status)) ? o : t;
  });
  let parts = [...base.parts];
  for (const t of other.toolCalls) {
    if (toolCalls.some((b) => b.id === t.id)) continue;
    {
      const sourceAt = other.parts.findIndex((p) => p.kind === "tool" && other.toolCalls[p.toolIndex]?.id === t.id);
      const following = other.parts.slice(sourceAt + 1).filter((p) => p.kind === "tool").map((p) => other.toolCalls[p.toolIndex]!.id);
      let at = parts.findIndex((p) => p.kind === "tool" && following.includes(toolCalls[p.toolIndex]!.id));
      if (at < 0 && other === m) {
        // Stored progress missed while away precedes the live-only suffix
        // received while this history was being read.
        const preceding = other.parts.slice(0, sourceAt).filter((p) => p.kind === "tool").map((p) => other.toolCalls[p.toolIndex]!.id);
        const prior = parts.findLastIndex((p) => p.kind === "tool" && preceding.includes(toolCalls[p.toolIndex]!.id));
        if (prior >= 0) at = prior + 1;
      }
      parts.splice(at < 0 ? parts.length : at, 0, { kind: "tool", toolIndex: toolCalls.length });
    }
    toolCalls.push(other === old && t.status === "pending_approval"
      ? { ...t, restored: true as const, approvalTurnId: undefined } : t);
  }
  // The union's flat order must agree with its drawn chronology: the next
  // replay compares this list too, including a tool inserted in an old gap.
  const beforeOrder = [...toolCalls];
  const rank = new Map(parts.filter((p) => p.kind === "tool").map((p, i) => [beforeOrder[p.toolIndex]!.id, i]));
  toolCalls.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  parts = parts.map((p) => p.kind === "tool" ? { ...p, toolIndex: toolCalls.findIndex((t) => t.id === beforeOrder[p.toolIndex]!.id) } : p);
  // Thinking stays between the text/tool parts that bracketed it. Host
  // aggregates add separators, so compare the drawn blocks, not that field.
  const body = parts.filter((p) => p.kind !== "thinking");
  const thinkingSlots = (source: MessagePart[], sourceTools: ToolCall[], remap = false) => {
    const slots = new Map<number, Extract<MessagePart, { kind: "thinking" }>[]>();
    let at = 0;
    for (const [index, part] of source.entries()) {
      if (part.kind !== "thinking") { at++; continue; }
      let slot = at;
      if (remap) {
        // A recovered tool changes numeric slots. Anchor thinking to a tool
        // this copy actually saw, rather than duplicating it at an old index.
        const before = source.slice(0, index).filter((p) => p.kind !== "thinking");
        const prior = before.findLastIndex((p) => p.kind === "tool");
        const after = source.slice(index + 1).filter((p) => p.kind !== "thinking");
        const following = after.findIndex((p) => p.kind === "tool");
        const anchor = prior >= 0 ? before[prior] : following >= 0 ? after[following] : undefined;
        if (anchor?.kind === "tool") {
          const target = body.findIndex((p) => p.kind === "tool" && toolCalls[p.toolIndex]?.id === sourceTools[anchor.toolIndex]?.id);
          if (target >= 0) slot = prior >= 0 ? target + before.length - prior : target - following;
        }
      }
      slots.set(slot, [...(slots.get(slot) ?? []), part]);
    }
    return slots;
  };
  const slots = thinkingSlots(parts, toolCalls);
  for (const [at, blocks] of thinkingSlots(other.parts, other.toolCalls, true)) {
    const mine = slots.get(at) ?? [];
    if (blocks.reduce((n, p) => n + p.text.length, 0) > mine.reduce((n, p) => n + p.text.length, 0)) slots.set(at, blocks);
  }
  parts = body.flatMap((part, at) => [...(slots.get(at) ?? []), part]);
  parts.push(...(slots.get(body.length) ?? []));
  const thinking = parts.filter((p) => p.kind === "thinking").map((p) => p.text).join("") || undefined;
  // Questions by request: one either copy saw settled is settled, and one
  // only the page has drawn stays (its card is the reader's).
  const settled = (e: AskUserExchange) => e.answers !== undefined || e.cancelled === true || e.order !== undefined || e.formAnswers !== undefined;
  const asks = new Map((base.askUserExchanges ?? []).map((e) => [e.requestId, e]));
  for (const e of other.askUserExchanges ?? []) {
    const mine = asks.get(e.requestId);
    if (!mine || (settled(e) && !settled(mine))) asks.set(e.requestId, e);
  }
  const askUserExchanges = asks.size ? [...asks.values()] : undefined;
  return {
    ...base, toolCalls, parts, thinking, askUserExchanges,
    // Terminal history is authoritative even when the drawn text is longer.
    failure: m.failure ?? base.failure,
    retryOfTurnId: m.failure ? m.retryOfTurnId : base.retryOfTurnId,
    failureLive: m.failure ? false : base.failureLive,
    files: m.files ?? base.files,
    blocks: m.blocks ?? base.blocks,
    id: old.id, timestamp: old.timestamp, isStreaming: true,
    turnId: m.turnId, streamTurnId: old.turnId ?? old.streamTurnId,
  };
}

function emptyChat(): SessionChat {
  return { messages: [], isStreaming: false, askUser: null, lastTouched: Date.now() };
}

/** Frozen empty buffer for selectors when nothing is in view. */
const EMPTY_CHAT: SessionChat = Object.freeze({
  messages: Object.freeze([]) as unknown as ChatMessage[],
  isStreaming: false,
  askUser: null,
  lastTouched: 0,
});

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

/** Append text to the last part if it has the same kind, else start a new part. */
function appendPart(
  parts: MessagePart[],
  kind: "thinking" | "text",
  text: string
): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    return [...parts.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...parts, { kind, text }];
}

/** The message with no retry notice: the turn moved on, or ended. */
function withoutRetry(message: ChatMessage): ChatMessage {
  if (!message.retry) return message;
  const { retry: _retry, ...rest } = message;
  return rest;
}

/** Free object URLs held by live message previews before dropping them. */
function revokeAttachmentUrls(messages: ChatMessage[], retained: ChatMessage[] = []) {
  const kept = new Set(retained.flatMap((m) => (m.attachments ?? []).map((a) => a.previewUrl)));
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.previewUrl.startsWith("blob:") && !kept.has(a.previewUrl)) URL.revokeObjectURL(a.previewUrl);
    }
  }
}

/**
 * Whether a pending approval may offer "always allow": never for a
 * destructive-command confirmation, and never when the host said it would
 * not keep the grant. Both approval surfaces and the Actions receipt read
 * this one rule, so the button and the receipt cannot disagree.
 */
export function offersAlwaysAllow(tool: Pick<ToolCall, "approvalKind" | "approvalRememberable">): boolean {
  return tool.approvalKind !== "command" && tool.approvalRememberable !== false;
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
  return tool.status === "pending_approval" && !tool.readOnly;
}

/** Evict least-recently-touched non-active buffers beyond MAX_BUFFERS. */
function evictStale(
  buffers: Record<string, SessionChat>,
  activeSessionId: string | null
): Record<string, SessionChat> {
  const ids = Object.keys(buffers);
  if (ids.length <= MAX_BUFFERS) return buffers;
  const evictable = ids
    .filter((id) => id !== activeSessionId && !buffers[id].isStreaming)
    .sort((a, b) => buffers[a].lastTouched - buffers[b].lastTouched);
  const next = { ...buffers };
  for (const id of evictable.slice(0, ids.length - MAX_BUFFERS)) {
    revokeAttachmentUrls(next[id].messages);
    delete next[id];
  }
  return next;
}

export function createChatStore(env: StoreEnvironment, provider: StoreApi<ProviderState>, composerDrafts?: StoreApi<{ newChat(): void }>) {
  let messageCounter = 0;
  function nextId() {
    return `msg-${++messageCounter}-${Date.now()}`;
  }

  const SESSION_ID_KEY = env.storageKey("brain-sessionId");

  /**
   * Persist the active session id to localStorage when a DOM is present (the
   * browser). A no-op in non-DOM environments (tests, SSR) so creating the store
   * never throws on a missing `localStorage`.
   */
  function persistSessionId(id: string | null) {
    const storage = env.storage();
    if (!storage) return;
    if (id) env.storage()?.setItem(SESSION_ID_KEY, id);
    else env.storage()?.removeItem(SESSION_ID_KEY);
  }

  function readPersistedSessionId(): string | null {
    const storage = env.storage();
    if (!storage) return null;
    return storage.getItem(SESSION_ID_KEY);
  }


  const RETRIES_KEY = env.storageKey("brain-turn-retries");
  function readRetries(): Record<string, PendingTurnRetry> {
    try {
      const value: unknown = JSON.parse(env.storage()?.getItem(RETRIES_KEY) ?? "{}");
      if (!value || typeof value !== "object") return {};
      return Object.fromEntries(Object.entries(value).flatMap(([sessionId, retry]) => {
        if (!retry || typeof retry !== "object") return [];
        const r = retry as Partial<PendingTurnRetry>;
        return typeof r.requestId === "string" && typeof r.failedTurnId === "string" && (r.state === "waiting" || r.state === "unknown")
          ? [[sessionId, { requestId: r.requestId, failedTurnId: r.failedTurnId, state: "unknown" as const }]] : [];
      }));
    } catch { return {}; }
  }

  return createStore<ChatState>((set, get) => {
    /**
     * Immutably update one buffer. Draft mutations (key null) create the draft
     * on demand; session mutations require an existing buffer — a frame for an
     * evicted/never-opened session must not materialize a partial transcript
     * (the view heals via session_resume instead).
     */
    function mutateBuffer(
      key: ChatKey,
      fn: (chat: SessionChat) => Partial<SessionChat>,
      createIfMissing = false
    ): void {
      set((state) => {
        if (key === null) {
          const draft = state.draft ?? emptyChat();
          return { draft: { ...draft, ...fn(draft), lastTouched: Date.now() } };
        }
        const existing = state.buffers[key] ?? (createIfMissing ? emptyChat() : undefined);
        if (!existing) return state;
        return {
          buffers: {
            ...state.buffers,
            [key]: { ...existing, ...fn(existing), lastTouched: Date.now() },
          },
        };
      });
    }

    /**
     * Update the assistant message that holds tool call `toolUseId`, else the
     * last assistant message. A restored approval can sit in a turn shell
     * (#964) while the turn's later output streams into a newer message, and
     * its decision and result must still reach the card.
     */
    function mutateToolHolder(key: ChatKey, toolUseId: string, fn: (msg: ChatMessage) => ChatMessage): void {
      mutateBuffer(key, (chat) => {
        let index = chat.messages.findLastIndex((m) => m.role === "assistant" && m.toolCalls.some((t) => t.id === toolUseId));
        if (index === -1) index = chat.messages.findLastIndex((m) => m.role === "assistant");
        if (index === -1) return {};
        const msgs = [...chat.messages];
        msgs[index] = fn(msgs[index]!);
        return { messages: msgs };
      });
    }

    /** Monotonic per store, so every take is a new request. */
    let composerInsertSeq = 0;

    /** Update the last message of a buffer when it is an assistant message. */
    function mutateLastAssistant(
      key: ChatKey,
      fn: (msg: ChatMessage) => ChatMessage,
      extra?: (chat: SessionChat) => Partial<SessionChat>
    ): void {
      mutateBuffer(key, (chat) => {
        const msgs = [...chat.messages];
        // The last ASSISTANT message, not the last message.
        //
        // A follow-up sent mid-stream appends a user message to the end of the
        // buffer while the assistant is still streaming into the message before
        // it. Indexing the end therefore aimed every subsequent delta at the
        // user's own message, where `role === "assistant"` failed and the write
        // was silently discarded — the turn kept running and its output stopped
        // appearing. Scanning backwards costs nothing at these lengths and
        // leaves single-message behaviour identical.
        let index = -1;
        for (let i = msgs.length - 1;i >= 0;i--) {
          if (msgs[i].role === "assistant") {
            index = i;
            break;
          }
        }
        let out: Partial<SessionChat> = {};
        if (index !== -1) {
          msgs[index] = fn(msgs[index]);
          out = { messages: msgs };
        }
        return extra ? { ...out, ...extra(chat) } : out;
      });
    }

    return {
      chatReceipts: {},
      setChatReceipt(requestId, state, sessionId) {
        if (get().chatReceipts[requestId]?.state === "accepted") return;
        const entries = Object.entries(get().chatReceipts).filter(([id]) => id !== requestId).slice(-255);
        set({ chatReceipts: Object.fromEntries([...entries, [requestId, { state, sessionId }]]) });
      },
      clearChatReceipt(requestId) {
        const chatReceipts = { ...get().chatReceipts };
        delete chatReceipts[requestId];
        set({ chatReceipts });
      },
      setMessageEffort(key, requestId, thinkingLevel, effectiveThinkingLevel) {
        mutateBuffer(key, (chat) => ({ messages: chat.messages.map((message) => message.role === "user" && message.requestId === requestId
          ? { ...message, thinkingLevel, ...(effectiveThinkingLevel !== undefined ? { effectiveThinkingLevel } : {}) } : message) }));
      },
      turnRetries: readRetries(),
      setTurnRetry(sessionId, retry) {
        const turnRetries = { ...get().turnRetries };
        if (retry) turnRetries[sessionId] = retry;
        else delete turnRetries[sessionId];
        try {
          env.storage()?.setItem(RETRIES_KEY, JSON.stringify(Object.fromEntries(Object.entries(turnRetries).filter(([, r]) => r.state !== "refused"))));
        } catch { /* The host also consumes each failed-turn handle once. */ }
        set({ turnRetries });
      },
      setRetryHandle: (key, retryOfTurnId) => mutateLastAssistant(key, last => ({ ...last, retryOfTurnId })),
      buffers: {},
      draft: null,
      pendingDraftId: null,
      detachedDrafts: {},
      // localStorage (not sessionStorage) so the active session id survives the
      // PWA process being killed on mobile — that durability is what lets a cold
      // relaunch re-request the full transcript instead of showing nothing.
      activeSessionId: readPersistedSessionId(),
      runStates: {},
      queueNotes: {},
      backendIds: {},

      // createIfMissing: a user-initiated send must never be dropped, even when
      // the active session's buffer hasn't been materialized yet (cold start
      // racing the history replay).
      addUserMessage: (key, text, source, attachments, effort, files) =>
        mutateBuffer(
          key,
          (chat) => ({
            messages: [
              ...chat.messages,
              {
                id: nextId(),
                role: "user",
                content: text,
                toolCalls: [],
                parts: [],
                isStreaming: false,
                timestamp: Date.now(),
                source: source ?? "typed",
                ...effort,
                ...(files?.length ? { files } : {}),
                ...(attachments && attachments.length > 0
                  ? { attachments, attachmentCount: attachments.length }
                  : {}),
              },
            ],
          }),
          true
        ),

      startAssistantMessage: (key, turnId, requestId) =>
        mutateBuffer(key, (chat) => ({
          messages: [
            ...chat.messages,
            {
              id: nextId(),
              role: "assistant",
              content: "",
              thinking: "",
              toolCalls: [],
              parts: [],
              isStreaming: true,
              timestamp: Date.now(),
              ...(turnId ? { turnId } : {}),
              ...(requestId ? { requestId } : {}),
            },
          ],
          isStreaming: true,
        })),

      appendText: (key, text) =>
        mutateLastAssistant(key, (last) => ({
          ...withoutRetry(last),
          content: last.content + text,
          parts: appendPart(last.parts, "text", text),
        })),

      setStatsAnswer: (key, sections) =>
        mutateLastAssistant(key, (last) => ({ ...last, statsAnswer: sections })),

      setLocalExchange: (key, exchange) =>
        mutateLastAssistant(key, (last) => ({ ...last, localExchange: exchange })),

      markLocalExchange: (exchangeId, saved, reason) =>
        set((state) => {
          const mark = (chat: SessionChat): SessionChat | null => {
            const index = chat.messages.findIndex((m) => m.localExchange?.id === exchangeId);
            if (index === -1) return null;
            const messages = [...chat.messages];
            const current = messages[index]!;
            const { reason: _previous, ...exchange } = current.localExchange!;
            messages[index] = {
              ...current,
              localExchange: { ...exchange, saved, ...(reason ? { reason } : {}) },
            };
            return { ...chat, messages };
          };
          const draft = state.draft ? mark(state.draft) : null;
          if (draft) return { draft };
          for (const [key, chat] of Object.entries(state.buffers)) {
            const marked = mark(chat);
            if (marked) return { buffers: { ...state.buffers, [key]: marked } };
          }
          return state;
        }),

      appendThinking: (key, text) =>
        mutateLastAssistant(key, (last) => ({
          ...withoutRetry(last),
          thinking: (last.thinking || "") + text,
          parts: appendPart(last.parts, "thinking", text),
        })),

      startToolCall: (key, toolUseId, toolName) =>
        mutateLastAssistant(key, (last) => ({
          ...last,
          parts: [...last.parts, { kind: "tool", toolIndex: last.toolCalls.length }],
          toolCalls: [
            ...last.toolCalls,
            {
              id: toolUseId,
              name: toolName,
              input: {},
              inputJson: "",
              status: "streaming",
              startedAt: Date.now(),
            },
          ],
        })),

      appendToolInput: (key, partialJson) =>
        mutateLastAssistant(key, (last) => {
          if (last.toolCalls.length === 0) return last;
          const tools = [...last.toolCalls];
          const lastTool = tools[tools.length - 1];
          tools[tools.length - 1] = {
            ...lastTool,
            inputJson: lastTool.inputJson + partialJson,
          };
          return { ...last, toolCalls: tools };
        }),

      completeToolCall: (key, toolUseId, toolName, input) =>
        mutateLastAssistant(key, (last) => ({
          ...last,
          toolCalls: last.toolCalls.map((t) =>
            t.id === toolUseId || (t.name === toolName && t.status === "streaming")
              ? {
                ...t,
                id: toolUseId,
                input,
                status: "complete" as const,
                // Input finished streaming — execution starts about now
                startedAt: Date.now(),
              }
              : t
          ),
        })),

      requestToolApproval: (key, toolUseId, toolName, input, description, kind, rememberable, turnId) =>
        mutateBuffer(key, (chat) => {
          const msgs = [...chat.messages];
          const request = (previous: ToolCall | undefined, restored: boolean): ToolCall => ({
            id: toolUseId,
            name: toolName,
            input,
            inputJson: JSON.stringify(input, null, 2),
            status: "pending_approval",
            ...(kind ? { approvalKind: kind } : {}),
            ...(rememberable === false ? { approvalRememberable: false } : {}),
            ...(description ? { approvalDescription: description } : {}),
            // A card already pending keeps what it was; anything else is
            // restored when it lands on a message no live turn is streaming.
            ...((previous?.status === "pending_approval" ? previous.restored : restored)
              ? { restored: true as const, ...(turnId ? { approvalTurnId: turnId } : {}) }
              : {}),
          });
          // One card per request: a re-delivery updates the card wherever it
          // is, and never draws a second one (#964).
          const holder = msgs.findLastIndex((m) => m.role === "assistant" && m.toolCalls.some((t) => t.id === toolUseId));
          if (holder !== -1) {
            const target = msgs[holder]!;
            msgs[holder] = {
              ...target,
              // A card the host already closed with a reason (#1072) stays
              // closed: a late duplicate of its request revives nothing.
              toolCalls: target.toolCalls.map((t) => t.id !== toolUseId || (t.readOnly && t.readOnly !== "unlisted") ? t : request(t, !target.isStreaming)),
            };
            return { messages: msgs };
          }
          // The turn's own answer, when a message carries its id; otherwise
          // the latest answer, if it is still streaming or comes after the
          // user's latest message, and no other turn owns it.
          let index = turnId ? msgs.findLastIndex((m) => m.role === "assistant" && m.turnId === turnId) : -1;
          if (index === -1) {
            const last = msgs.findLastIndex((m) => m.role === "assistant");
            const lastUser = msgs.findLastIndex((m) => m.role === "user");
            const candidate = last === -1 ? undefined : msgs[last]!;
            if (candidate && (candidate.isStreaming || last > lastUser) && (!candidate.turnId || !turnId || candidate.turnId === turnId)) {
              index = last;
            }
          }
          if (index === -1) {
            // No answer belongs to this turn: the replay ended on the user's
            // message. Draw the turn's shell, holding only the card, with no
            // invented text (D52 §4, approval recovery).
            msgs.push({
              id: nextId(),
              role: "assistant",
              content: "",
              toolCalls: [request(undefined, true)],
              parts: [{ kind: "tool", toolIndex: 0 }],
              isStreaming: false,
              timestamp: Date.now(),
              turnShell: true,
              ...(turnId ? { turnId } : {}),
            });
            return { messages: msgs };
          }
          const last = msgs[index]!;
          // Check if tool call already exists (from streaming)
          const existingIdx = last.toolCalls.findIndex(
            (t) => t.name === toolName && t.status === "streaming"
          );
          const tools = [...last.toolCalls];
          const toolCall = request(undefined, !last.isStreaming);
          let parts = last.parts;
          if (existingIdx >= 0) {
            tools[existingIdx] = toolCall;
          } else {
            // Approval request for a tool that never streamed a start event —
            // give it a chronological slot too.
            parts = [...parts, { kind: "tool", toolIndex: tools.length }];
            tools.push(toolCall);
          }
          msgs[index] = { ...last, toolCalls: tools, parts };
          return { messages: msgs };
        }),

      resolveToolApproval: (key, toolUseId, approved) =>
        mutateToolHolder(key, toolUseId, (last) => ({
          ...last,
          toolCalls: last.toolCalls.map((t) =>
            t.id === toolUseId
              ? {
                ...t,
                status: approved ? ("approved" as const) : ("denied" as const),
                // Don't let approval wait time inflate the duration badge
                ...(approved ? { startedAt: Date.now() } : {}),
              }
              : t
          ),
        })),

      closeRestoredApprovals: (key, closures) => {
        if (closures.length === 0) return;
        const byId = new Map(closures.map((c) => [c.toolUseId, c.closure]));
        mutateBuffer(key, (chat) => {
          let changed = false;
          const messages = chat.messages.map((m) => {
            if (m.role !== "assistant" || !m.toolCalls.some((t) => byId.has(t.id))) return m;
            let touched = false;
            const toolCalls = m.toolCalls.map((t) => {
              const closure = byId.get(t.id);
              if (!closure || !t.restored || t.readOnly === closure) return t;
              // Decided on this page: the card already says what happened.
              if (t.status === "approved" || t.status === "denied") return t;
              if (t.readOnly && t.readOnly !== "unlisted") return t;
              touched = true;
              return { ...t, readOnly: closure };
            });
            if (!touched) return m;
            changed = true;
            return { ...m, toolCalls };
          });
          return changed ? { messages } : {};
        });
      },

      reopenRestoredApprovals: (key, toolUseIds) => {
        const reopen = (t: ToolCall) => toolUseIds.includes(t.id) && t.readOnly === "unlisted" && t.status === "pending_approval";
        const chat = key === null ? get().draft : get().buffers[key];
        if (!chat?.messages.some((m) => m.toolCalls.some(reopen))) return;
        mutateBuffer(key, (current) => ({
          messages: current.messages.map((m) => {
            if (!m.toolCalls.some(reopen)) return m;
            return { ...m, toolCalls: m.toolCalls.map((t) => {
              if (!reopen(t)) return t;
              const { readOnly: _closed, ...open } = t;
              return open;
            }) };
          }),
        }));
      },

      revokeRestoredApprovals: () =>
        set((state) => {
          const revoke = (chat: SessionChat): SessionChat => {
            if (!chat.messages.some((m) => m.toolCalls.some((t) => t.restored && t.readOnly !== "revoked"))) return chat;
            const messages = chat.messages.map((m) => {
              if (!m.toolCalls.some((t) => t.restored && t.readOnly !== "revoked")) return m;
              const toolCalls = m.toolCalls.map((t) => {
                if (!t.restored || t.readOnly === "revoked") return t;
                // The request's identity goes with the authority to answer
                // it: the card keeps only what it showed.
                const { approvalTurnId: _turn, ...rest } = t;
                return { ...rest, id: `revoked-${nextId()}`, readOnly: "revoked" as const };
              });
              if (!m.turnShell) return { ...m, toolCalls };
              const { turnId: _shellTurn, ...shell } = m;
              return { ...shell, toolCalls };
            });
            return { ...chat, messages };
          };
          const buffers = Object.fromEntries(Object.entries(state.buffers).map(([id, chat]) => [id, revoke(chat)]));
          const changed = Object.keys(buffers).some((id) => buffers[id] !== state.buffers[id]);
          const draft = state.draft ? revoke(state.draft) : state.draft;
          if (!changed && draft === state.draft) return state;
          return { buffers, draft };
        }),

      setToolResult: (key, toolUseId, output, isError) =>
        mutateToolHolder(key, toolUseId, (last) => ({
          ...last,
          toolCalls: last.toolCalls.map((t) =>
            t.id === toolUseId
              ? {
                ...t,
                output,
                isError,
                status: "complete" as const,
                endedAt: Date.now(),
              }
              : t
          ),
        })),

      setAskUserRequest: (key, requestId, questions, turnId) =>
        mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions, ...(turnId ? { turnId } : {}) })),

      setAskUserListRequest: (key, requestId, list, turnId) =>
        mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], list, ...(turnId ? { turnId } : {}) })),

      setAskUserRankRequest: (key, requestId, rank, turnId) =>
        mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], rank, ...(turnId ? { turnId } : {}) })),

      submitAskUserRankOrder: (key, requestId, order, unchanged) =>
        mutateBuffer(key, (chat) => {
          const answeredAt = Date.now();
          const update = (e: AskUserExchange): AskUserExchange =>
            e.requestId === requestId
              ? { ...e, order, unchanged, answeredAt }
              : e;
          const msgs = chat.messages.map((m) =>
            m.askUserExchanges?.some((e) => e.requestId === requestId)
              ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
              : m
          );
          const askUser =
            chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
          return { messages: msgs, askUser };
        }),

      setAskUserFormRequest: (key, requestId, form, turnId) =>
        mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], form, ...(turnId ? { turnId } : {}) })),

      submitAskUserFormAnswers: (key, requestId, formAnswers, visibleNodes) =>
        mutateBuffer(key, (chat) => {
          const answeredAt = Date.now();
          const update = (e: AskUserExchange): AskUserExchange =>
            e.requestId === requestId
              ? { ...e, formAnswers, visibleNodes, answeredAt }
              : e;
          const msgs = chat.messages.map((m) =>
            m.askUserExchanges?.some((e) => e.requestId === requestId)
              ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
              : m
          );
          const askUser =
            chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
          return { messages: msgs, askUser };
        }),

      submitAskUserListAnswers: (key, requestId, answers, notes) =>
        mutateBuffer(key, (chat) => {
          const answeredAt = Date.now();
          const update = (e: AskUserExchange): AskUserExchange =>
            e.requestId === requestId
              ? { ...e, answers, answeredAt, ...(notes && Object.keys(notes).length ? { notes } : {}) }
              : e;
          const msgs = chat.messages.map((m) =>
            m.askUserExchanges?.some((e) => e.requestId === requestId)
              ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
              : m
          );
          const askUser =
            chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
          return { messages: msgs, askUser };
        }),

      submitAskUserAnswers: (key, requestId, answers, annotations, typed) =>
        mutateBuffer(key, (chat) => {
          const answeredAt = Date.now();
          const update = (e: AskUserExchange): AskUserExchange =>
            e.requestId === requestId
              ? { ...e, answers, annotations, answeredAt, ...(typed ? { typed: true } : {}) }
              : e;
          const msgs = chat.messages.map((m) =>
            m.askUserExchanges?.some((e) => e.requestId === requestId)
              ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
              : m
          );
          const askUser =
            chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
          return { messages: msgs, askUser };
        }),

      cancelAskUser: (key, requestId) =>
        mutateBuffer(key, (chat) => {
          const update = (e: AskUserExchange): AskUserExchange =>
            e.requestId === requestId ? { ...e, cancelled: true } : e;
          const msgs = chat.messages.map((m) =>
            m.askUserExchanges?.some((e) => e.requestId === requestId)
              ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
              : m
          );
          const askUser =
            chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
          return { messages: msgs, askUser };
        }),

      reopenAskExchange: (key, requestId) =>
        mutateBuffer(key, (chat) => {
          let reopened: AskUserExchange | null = null;
          const msgs = chat.messages.map((m) => {
            if (!m.askUserExchanges?.some((e) => e.requestId === requestId)) return m;
            return {
              ...m,
              askUserExchanges: m.askUserExchanges.map((e) => {
                if (e.requestId !== requestId) return e;
                const {
                  answers: _a, annotations: _n, notes: _o, order: _r, unchanged: _u,
                  formAnswers: _f, visibleNodes: _v, typed: _t, answeredAt: _w, cancelled: _c,
                  ...rest
                } = e;
                reopened = rest;
                return rest;
              }),
            };
          });
          return reopened ? { messages: msgs, askUser: reopened } : {};
        }),

      deliveries: {},
      setDelivery: (requestId, delivery) =>
        set((state) => {
          const deliveries = { ...state.deliveries };
          if (delivery) deliveries[requestId] = delivery;
          else delete deliveries[requestId];
          return { deliveries };
        }),

      clearAskUser: (key) => mutateBuffer(key, () => ({ askUser: null })),

      finishAssistantMessage: (key) =>
        mutateLastAssistant(
          key,
          (last) => ({ ...withoutRetry(last), isStreaming: false }),
          () => ({ isStreaming: false })
        ),

      failAssistantMessage: (key, failure, turnId, replace = false) =>
        mutateBuffer(
          key,
          (chat) => {
            const msgs = [...chat.messages];
            let index = -1;
            if (turnId) {
              index = msgs.findLastIndex((m) => m.role === "assistant" && m.turnId === turnId);
            }
            if (index === -1) {
              // The composer opens the turn's message before the turn has an
              // id, and a failure with no deltas never stamps one — so the
              // last assistant message, unless another turn owns it.
              const last = msgs.findLastIndex((m) => m.role === "assistant");
              const owner = last === -1 ? undefined : msgs[last].turnId;
              if (last !== -1 && (owner === undefined || owner === turnId)) index = last;
            }
            if (index === -1) {
              msgs.push({
                id: nextId(),
                role: "assistant",
                content: "",
                toolCalls: [],
                parts: [],
                isStreaming: false,
                timestamp: Date.now(),
                ...(turnId ? { turnId } : {}),
              });
              index = msgs.length - 1;
            }
            const target = msgs[index];
            msgs[index] = {
              ...withoutRetry(target),
              isStreaming: false,
              failure: target.failure && !replace ? target.failure : failure,
              failureLive: true,
              ...(turnId ? { turnId } : {}),
            };
            // The buffer streams while its newest message does: a follow-up
            // already running after this message keeps it streaming.
            const streaming = msgs.some((m) => m.role === "assistant" && m.isStreaming);
            return { messages: msgs, isStreaming: streaming };
          },
          true
        ),

      setRetry: (key, retry) =>
        mutateLastAssistant(key, (last) => {
          if (!last.isStreaming) return last;
          return retry ? { ...last, retry } : withoutRetry(last);
        }),

      setMessageBlocks: (key, blocks, turnId) =>
        mutateBuffer(key, (chat) => {
          const msgs = [...chat.messages];
          let index = -1;
          if (turnId) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "assistant" && msgs[i].turnId === turnId) {
                index = i;
                break;
              }
            }
          }
          if (index === -1) {
            // No message carries the turn (an optimistic message opened by
            // the composer, or a frame without one): the last assistant
            // message, but only once it has finished — never a follow-up
            // still streaming.
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "assistant") {
                if (!msgs[i].isStreaming) index = i;
                break;
              }
            }
          }
          if (index === -1) return {};
          msgs[index] = { ...msgs[index], blocks };
          return { messages: msgs };
        }),

      stampTurn: (key, turnId) =>
        mutateLastAssistant(key, (last) =>
          last.isStreaming && !last.turnId ? { ...last, turnId } : last
        ),

      setStreaming: (key, streaming) => mutateBuffer(key, () => ({ isStreaming: streaming })),

      historyLoads: {},
      noteHistoryLoaded: (sessionId) =>
        set((state) => ({ historyLoads: { ...state.historyLoads, [sessionId]: (state.historyLoads[sessionId] ?? 0) + 1 } })),

      setMessages: (key, messages) =>
        set((state) => {
          if (key === null) {
            if (state.draft) revokeAttachmentUrls(state.draft.messages);
            return {
              draft: { ...emptyChat(), messages },
            };
          }
          const existing = state.buffers[key];
          const base = existing ? { messages: existing.messages, isStreaming: existing.isStreaming } : null;
          const drawn = base ? keepDrawnMessages(withKnownTurns(messages, base.messages), base) : { messages, isStreaming: false };
          if (existing) revokeAttachmentUrls(existing.messages, drawn.messages);
          const buffers = {
            ...state.buffers,
            [key]: base
              ? { ...emptyChat(), ...drawn, replay: { base, received: messages } }
              : { ...emptyChat(), messages },
          };
          return { buffers: evictStale(buffers, state.activeSessionId) };
        }),

      appendMessages: (key, messages) =>
        set((state) => {
          if (key === null) {
            const draft = state.draft ?? emptyChat();
            return { draft: { ...draft, messages: [...draft.messages, ...messages] } };
          }
          const existing = state.buffers[key] ?? emptyChat();
          if (existing.replay) {
            // A later chunk of the same replay: reconcile the whole replay so
            // far against the transcript it replaced, so a message the first
            // chunk kept back as still being written is not drawn twice. The
            // answer as it stands now (deltas since) is the live one.
            const { base, received } = existing.replay;
            const now = existing.messages.at(-1);
            const live = base.messages.at(-1);
            const current = now && live && now.id === live.id ? { ...base, messages: [...base.messages.slice(0, -1), now] } : base;
            const all = [...received, ...messages];
            const drawn = keepDrawnMessages(withKnownTurns(all, current.messages), current);
            revokeAttachmentUrls(existing.messages, drawn.messages);
            return {
              buffers: {
                ...state.buffers,
                [key]: { ...existing, ...drawn, replay: { base: current, received: all }, lastTouched: Date.now() },
              },
            };
          }
          return {
            buffers: {
              ...state.buffers,
              [key]: {
                ...existing,
                messages: [...existing.messages, ...messages],
                lastTouched: Date.now(),
              },
            },
          };
        }),

      finishHistoryReplay: (key) => mutateBuffer(key, (existing) => {
        if (!existing.replay) return {};
        const { base, received } = existing.replay;
        const now = existing.messages.at(-1);
        const live = base.messages.at(-1);
        // A full replay is already reconciled. Progress that opened another
        // message afterward is live, not an unreceived history suffix. A
        // lagging backend can also omit just the answer that was live before
        // the replay; retain that answer even if this status ends its turn.
        if (received.length >= base.messages.length || now?.id !== live?.id
          || (base.isStreaming && live?.isStreaming && received.length === base.messages.length - 1
            && existing.messages.slice(0, received.length).every((m, i) => m.id === base.messages[i]!.id))) {
          return { replay: undefined };
        }
        const drawn = keepDrawnMessages(withKnownTurns(received, existing.messages), existing, false);
        revokeAttachmentUrls(existing.messages, drawn.messages);
        return { ...drawn, replay: undefined };
      }),

      startDraftTurn: () => {
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        set({ pendingDraftId: id });
        return id;
      },

      bindDraftSession: (sessionId) =>
        set((state) => {
          const adopted = state.buffers[sessionId] ?? state.draft ?? emptyChat();
          const buffers = evictStale(
            { ...state.buffers, [sessionId]: { ...adopted, lastTouched: Date.now() } },
            sessionId
          );
          const followView = state.activeSessionId === null;
          if (followView) persistSessionId(sessionId);
          return {
            buffers,
            draft: null,
            pendingDraftId: null,
            ...(followView ? { activeSessionId: sessionId } : {}),
          };
        }),

      setActiveSession: (sessionId) =>
        set((state) => {
          persistSessionId(sessionId);
          if (sessionId === null) return { activeSessionId: null };
          const existing = state.buffers[sessionId];
          const buffers = existing
            ? state.buffers
            : evictStale({ ...state.buffers, [sessionId]: emptyChat() }, sessionId);
          return { activeSessionId: sessionId, buffers };
        }),

      setRunState: (sessionId, runState, note) =>
        set((state) => {
          const noteChanged = (state.queueNotes[sessionId] ?? undefined) !== note;
          if (state.runStates[sessionId] === runState && !noteChanged) return state;

          const runStates = { ...state.runStates };
          if (runState === "idle") delete runStates[sessionId];
          else runStates[sessionId] = runState;

          // The note belongs to the queued state; anything else ends it. A
          // `queued` frame with no note also clears, so a queue that drained back
          // under the warn mark stops claiming it is heavy.
          const queueNotes = { ...state.queueNotes };
          if (runState === "queued" && note) queueNotes[sessionId] = note;
          else delete queueNotes[sessionId];

          return { runStates, queueNotes };
        }),

      setSessionBackend: (sessionId, backendId) =>
        set((state) =>
          state.backendIds[sessionId] === backendId
            ? state
            : { backendIds: { ...state.backendIds, [sessionId]: backendId } }
        ),

      composerInsert: null,
      requestComposerInsert: (text) =>
        set({ composerInsert: { seq: ++composerInsertSeq, text } }),
      clearComposerInsert: (seq) =>
        set((state) => (state.composerInsert?.seq === seq ? { composerInsert: null } : state)),

      clearMessages: () => {
        const state = get();
        // A first message still unanswered keeps its transcript, aside: its
        // announcement binds it there, not to whatever the view shows next.
        const detach = state.draft && state.pendingDraftId ? state.pendingDraftId : null;
        if (state.draft && !detach) revokeAttachmentUrls(state.draft.messages);
        persistSessionId(null);
        // Starting fresh: unpin the provider so the picker unlocks.
        provider.getState().setPinned(null);
        composerDrafts?.getState().newChat();
        set({
          draft: null,
          activeSessionId: null,
          ...(detach ? { pendingDraftId: null, detachedDrafts: { ...state.detachedDrafts, [detach]: state.draft! } } : {}),
        });
      },

      bindDetachedDraft: (correlationId, sessionId) =>
        set((state) => {
          const adopted = state.detachedDrafts[correlationId];
          if (!adopted) return state;
          const detachedDrafts = { ...state.detachedDrafts };
          delete detachedDrafts[correlationId];
          const existing = state.buffers[sessionId];
          return {
            detachedDrafts,
            buffers: evictStale(
              { ...state.buffers, [sessionId]: existing ?? { ...adopted, lastTouched: Date.now() } },
              state.activeSessionId ?? sessionId
            ),
          };
        }),

      withdrawSend: (key, requestId) =>
        set((state) => {
          const strip = (chat: SessionChat): SessionChat => {
            const messages = chat.messages.filter((m) => !(m.requestId === requestId && (m.role === "user" || (!m.turnId && !m.content && !m.thinking && m.toolCalls.length === 0))));
            if (messages.length === chat.messages.length) return chat;
            return { ...chat, messages, isStreaming: chat.isStreaming && messages.some((m) => m.role === "assistant" && m.isStreaming) };
          };
          if (key !== null) {
            const buffer = state.buffers[key];
            return buffer ? { buffers: { ...state.buffers, [key]: strip(buffer) } } : state;
          }
          const detachedDrafts = Object.fromEntries(Object.entries(state.detachedDrafts).map(([id, chat]) => [id, strip(chat)]));
          return { ...(state.draft ? { draft: strip(state.draft) } : {}), detachedDrafts };
        }),
    };
  });

}
