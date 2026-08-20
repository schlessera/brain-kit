import { create } from "zustand";
import type {
  MessageSource,
  MessagePart,
  AskUserQuestion,
  AskUserAnnotation,
} from "@schlessera/brain-ui-sdk/protocol";
import { useProviderStore } from "./provider-store.js";
import { registerDevHandle } from "../config.js";

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
  questions: AskUserQuestion[];
  /** Filled in once the user submits. Keyed by question text. */
  answers?: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
  cancelled?: boolean;
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

interface ChatState {
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
    attachments?: MessageAttachment[]
  ) => void;
  startAssistantMessage: (key: ChatKey) => void;
  appendText: (key: ChatKey, text: string) => void;
  appendThinking: (key: ChatKey, text: string) => void;
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
    description?: string
  ) => void;
  resolveToolApproval: (key: ChatKey, toolUseId: string, approved: boolean) => void;
  setToolResult: (key: ChatKey, toolUseId: string, output: string, isError: boolean) => void;
  setAskUserRequest: (key: ChatKey, requestId: string, questions: AskUserQuestion[]) => void;
  submitAskUserAnswers: (
    key: ChatKey,
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  cancelAskUser: (key: ChatKey, requestId: string) => void;
  clearAskUser: (key: ChatKey) => void;
  finishAssistantMessage: (key: ChatKey) => void;
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
}

let messageCounter = 0;
function nextId() {
  return `msg-${++messageCounter}-${Date.now()}`;
}

const SESSION_ID_KEY = "brain-sessionId";

/**
 * Persist the active session id to localStorage when a DOM is present (the
 * browser). A no-op in non-DOM environments (tests, SSR) so creating the store
 * never throws on a missing `localStorage`.
 */
function persistSessionId(id: string | null) {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(SESSION_ID_KEY, id);
  else localStorage.removeItem(SESSION_ID_KEY);
}

function readPersistedSessionId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(SESSION_ID_KEY);
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

/** Free object URLs held by live message previews before dropping them. */
function revokeAttachmentUrls(messages: ChatMessage[]) {
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.previewUrl.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
    }
  }
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

export const useChatStore = create<ChatState>((set, get) => {
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
      for (let i = msgs.length - 1; i >= 0; i--) {
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
    buffers: {},
    draft: null,
    pendingDraftId: null,
    // localStorage (not sessionStorage) so the active session id survives the
    // PWA process being killed on mobile — that durability is what lets a cold
    // relaunch re-request the full transcript instead of showing nothing.
    activeSessionId: readPersistedSessionId(),
    runStates: {},
    queueNotes: {},

    // createIfMissing: a user-initiated send must never be dropped, even when
    // the active session's buffer hasn't been materialized yet (cold start
    // racing the history replay).
    addUserMessage: (key, text, source, attachments) =>
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
            ...(attachments && attachments.length > 0
              ? { attachments, attachmentCount: attachments.length }
              : {}),
          },
        ],
        }),
        true
      ),

    startAssistantMessage: (key) =>
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
          },
        ],
        isStreaming: true,
      })),

    appendText: (key, text) =>
      mutateLastAssistant(key, (last) => ({
        ...last,
        content: last.content + text,
        parts: appendPart(last.parts, "text", text),
      })),

    appendThinking: (key, text) =>
      mutateLastAssistant(key, (last) => ({
        ...last,
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

    requestToolApproval: (key, toolUseId, toolName, input, description) =>
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
      mutateBuffer(key, (chat) => {
        const exchange: AskUserExchange = { requestId, questions };
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
      }),

    submitAskUserAnswers: (key, requestId, answers, annotations) =>
      mutateBuffer(key, (chat) => {
        const update = (e: AskUserExchange): AskUserExchange =>
          e.requestId === requestId ? { ...e, answers, annotations } : e;
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
        (last) => ({ ...last, isStreaming: false }),
        () => ({ isStreaming: false })
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

    clearMessages: () => {
      const state = get();
      if (state.draft) revokeAttachmentUrls(state.draft.messages);
      persistSessionId(null);
      // Starting fresh: unpin the provider so the picker unlocks.
      useProviderStore.getState().setPinned(null);
      set({ draft: null, activeSessionId: null });
    },
  };
});

// Dev-only handle so browser automation / manual debugging can inject
// fixture messages without a live Claude session. Registered rather than
// installed: whether this is a development build is the shell's call
// (`configureBrainUi({ devTools: true })`), not something a component library
// infers from its bundler.
registerDevHandle(() => {
  if (typeof window === "undefined") return;
  (window as unknown as { __chatStore?: typeof useChatStore }).__chatStore =
    useChatStore;
});
