import { createStore } from "zustand/vanilla";
import type {
  LocalExchange,
  MessageBlock,
  MessageSource,
  MessagePart,
  AskUserQuestion,
  AskUserAnnotation,
  AskUserListSpec,
  TurnFailure,
  TurnRetry,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { StatsSection } from "../components/chat/stats/compose-stats.js";
import type { ProviderState } from "./provider-state.js";
import type { StoreEnvironment } from "./store-environment.js";

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
  /** The `ask_user` questions; empty for an `ask_user_list` exchange. */
  questions: AskUserQuestion[];
  /**
   * Present when this is an `ask_user_list` exchange (#583): one scale over a
   * list of items. Such an exchange has no `questions`, and its `answers` are
   * keyed by item id rather than by question text.
   */
  list?: AskUserListSpec;
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
 * Open an ask exchange: attached to the streaming assistant message, where the
 * transcript draws it, and held as the session's pending exchange. `ask_user`
 * and `ask_user_list` share the slot, so the composer, the suggestions row and
 * the tool-result cleanup treat either the same way.
 */
function addExchange(
  chat: SessionChat,
  exchange: AskUserExchange
): Pick<SessionChat, "messages" | "askUser"> {
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
    effort?: { requestId: string; thinkingLevel?: ThinkingLevel }
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
    rememberable?: boolean
  ) => void;
  resolveToolApproval: (key: ChatKey, toolUseId: string, approved: boolean) => void;
  setToolResult: (key: ChatKey, toolUseId: string, output: string, isError: boolean) => void;
  setAskUserRequest: (key: ChatKey, requestId: string, questions: AskUserQuestion[]) => void;
  /** An `ask_user_list` request: the same exchange slot, holding a list. */
  setAskUserListRequest: (key: ChatKey, requestId: string, list: AskUserListSpec) => void;
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
  clearAskUser: (key: ChatKey) => void;
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
  /** New chat: drop the draft, unbind the view, unpin the provider. */
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
export function activeChat(state: ChatState): SessionChat {
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
export function anyStreaming(state: ChatState): boolean {
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
function revokeAttachmentUrls(messages: ChatMessage[]) {
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.previewUrl.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
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
      for (const tool of message.toolCalls) if (tool.status === "pending_approval") out.push({ key, tool });
    }
  };
  for (const [id, chat] of Object.entries(state.buffers)) scan(id, chat);
  scan(null, state.draft);
  return out;
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

export function createChatStore(env: StoreEnvironment, provider: StoreApi<ProviderState>) {
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
      addUserMessage: (key, text, source, attachments, effort) =>
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

      requestToolApproval: (key, toolUseId, toolName, input, description, kind, rememberable) =>
        mutateLastAssistant(key, (last) => {
          // Check if tool call already exists (from streaming)
          const existingIdx = last.toolCalls.findIndex(
            (t) => t.id === toolUseId || (t.name === toolName && t.status === "streaming")
          );
          const tools = [...last.toolCalls];
          const toolCall: ToolCall = {
            id: toolUseId,
            name: toolName,
            input,
            inputJson: JSON.stringify(input, null, 2),
            status: "pending_approval",
            ...(kind ? { approvalKind: kind } : {}),
            ...(rememberable === false ? { approvalRememberable: false } : {}),
            ...(description ? { approvalDescription: description } : {}),
          };
          let parts = last.parts;
          if (existingIdx >= 0) {
            tools[existingIdx] = toolCall;
          } else {
            // Approval request for a tool that never streamed a start event —
            // give it a chronological slot too.
            parts = [...parts, { kind: "tool", toolIndex: tools.length }];
            tools.push(toolCall);
          }
          return { ...last, toolCalls: tools, parts };
        }),

      resolveToolApproval: (key, toolUseId, approved) =>
        mutateLastAssistant(key, (last) => ({
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

      setToolResult: (key, toolUseId, output, isError) =>
        mutateLastAssistant(key, (last) => ({
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

      setAskUserRequest: (key, requestId, questions) =>
        mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions })),

      setAskUserListRequest: (key, requestId, list) =>
        mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], list })),

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

      setMessages: (key, messages) =>
        set((state) => {
          if (key === null) {
            if (state.draft) revokeAttachmentUrls(state.draft.messages);
            return {
              draft: { ...emptyChat(), messages },
            };
          }
          const existing = state.buffers[key];
          if (existing) revokeAttachmentUrls(existing.messages);
          const buffers = {
            ...state.buffers,
            [key]: { ...emptyChat(), messages },
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
        if (state.draft) revokeAttachmentUrls(state.draft.messages);
        persistSessionId(null);
        // Starting fresh: unpin the provider so the picker unlocks.
        provider.getState().setPinned(null);
        set({ draft: null, activeSessionId: null });
      },
    };
  });

}
