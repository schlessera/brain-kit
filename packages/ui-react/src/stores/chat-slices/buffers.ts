/**
 * The buffers every chat slice writes through (#1361): the buffer
 * constructor, the shared mutators, the buffer bound and the attachment
 * preview URLs a dropped message releases.
 */
import type { StoreApi } from "zustand/vanilla";
import type { ChatKey, ChatMessage, ChatState, MessagePart, SessionChat } from "../chat-state.js";

type ChatSet = StoreApi<ChatState>["setState"];
type ChatGet = StoreApi<ChatState>["getState"];

/** What every slice of one chat store shares. */
export interface ChatSliceContext {
  set: ChatSet;
  get: ChatGet;
  /** A new message id, unique within this store. */
  nextId(): string;
  mutateBuffer(key: ChatKey, fn: (chat: SessionChat) => Partial<SessionChat>, createIfMissing?: boolean): void;
  mutateToolHolder(key: ChatKey, toolUseId: string, fn: (msg: ChatMessage) => ChatMessage): void;
  mutateLastAssistant(key: ChatKey, fn: (msg: ChatMessage) => ChatMessage, extra?: (chat: SessionChat) => Partial<SessionChat>): void;
}

/** Retained transcript buffers beyond the active one (LRU-evicted). */
const MAX_BUFFERS = 8;

export function emptyChat(): SessionChat {
  return { messages: [], isStreaming: false, askUser: null, lastTouched: Date.now() };
}

/** Append text to the last part if it has the same kind, else start a new part. */
export function appendPart(
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
export function withoutRetry(message: ChatMessage): ChatMessage {
  if (!message.retry) return message;
  const { retry: _retry, ...rest } = message;
  return rest;
}

/** Free object URLs held by live message previews before dropping them. */
export function revokeAttachmentUrls(messages: ChatMessage[], retained: ChatMessage[] = []) {
  const kept = new Set(retained.flatMap((m) => (m.attachments ?? []).map((a) => a.previewUrl)));
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.previewUrl.startsWith("blob:") && !kept.has(a.previewUrl)) URL.revokeObjectURL(a.previewUrl);
    }
  }
}

/** Evict least-recently-touched non-active buffers beyond MAX_BUFFERS. */
export function evictStale(
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

/** The shared buffer mutators of one store, over its `set`. */
export function createChatSliceContext(set: ChatSet, get: ChatGet): ChatSliceContext {
  let messageCounter = 0;
  function nextId() {
    return `msg-${++messageCounter}-${Date.now()}`;
  }

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
    // The updated buffer, or null when the call changes nothing: then the
    // store is left as it is and nobody is notified (#4739). A journal
    // restamp still owed is a change.
    function updated(chat: SessionChat): SessionChat | null {
      const patch = fn(chat);
      let changed = (Object.keys(patch) as (keyof SessionChat)[]).some((field) => !Object.is(patch[field], chat[field]));
      const next = { ...chat, ...patch };
      if (next.journals) {
        const last = new Map<string, number>();
        next.messages.forEach((message, index) => { const id = message.turnId ?? message.streamTurnId; if (message.role === "assistant" && id) last.set(id, index); });
        let restamped = false;
        const messages = next.messages.map((message, index) => {
          const id = message.turnId ?? message.streamTurnId, receipt = id && next.journals?.[id];
          if (!receipt || last.get(id!) !== index || message.journal === receipt) return message;
          restamped = true;
          return { ...message, journal: receipt, journalLive: true };
        });
        if (restamped) {
          next.messages = messages;
          changed = true;
        }
      }
      if (!changed) return null;
      next.lastTouched = Date.now();
      return next;
    }
    set((state) => {
      if (key === null) {
        // A missing draft is created even by a call that changes nothing.
        const draft = state.draft ?? emptyChat();
        const next = updated(draft);
        if (!next) return state.draft ? state : { draft };
        return { draft: next };
      }
      const current = state.buffers[key];
      const existing = current ?? (createIfMissing ? emptyChat() : undefined);
      if (!existing) return state;
      const next = updated(existing) ?? (current ? null : existing);
      if (!next) return state;
      return {
        buffers: {
          ...state.buffers,
          [key]: next,
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
      const message = fn(chat.messages[index]!);
      if (message === chat.messages[index]) return {};
      const msgs = [...chat.messages];
      msgs[index] = message;
      return { messages: msgs };
    });
  }

  /** Update the last message of a buffer when it is an assistant message. */
  function mutateLastAssistant(
    key: ChatKey,
    fn: (msg: ChatMessage) => ChatMessage,
    extra?: (chat: SessionChat) => Partial<SessionChat>
  ): void {
    mutateBuffer(key, (chat) => {
      const msgs = chat.messages;
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
      const message = index === -1 ? undefined : fn(msgs[index]);
      // Copied only once a message changed (#4739).
      if (message && message !== msgs[index]) {
        const next = [...msgs];
        next[index] = message;
        out = { messages: next };
      }
      return extra ? { ...out, ...extra(chat) } : out;
    });
  }

  return { set, get, nextId, mutateBuffer, mutateToolHolder, mutateLastAssistant };
}
