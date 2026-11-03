/**
 * Sessions (#1361): which buffer is in view, the draft before a session
 * exists and its binding, history ownership and restore failures, and
 * withdrawing a send the host refused.
 */
import type { StoreApi } from "zustand/vanilla";
import type { ChatState, SessionChat } from "../chat-state.js";
import type { ProviderState } from "../provider-state.js";
import type { ChatSliceContext } from "./buffers.js";
import { emptyChat, evictStale, revokeAttachmentUrls } from "./buffers.js";
import type { ChatPersistence } from "./persistence.js";

type SessionSliceSlice = Pick<ChatState,
  | "buffers"
  | "draft"
  | "pendingDraftId"
  | "detachedDrafts"
  | "activeSessionId"
  | "historyOwners"
  | "setHistoryOwner"
  | "restoreFailures"
  | "failRestore"
  | "clearRestoreFailure"
  | "startDraftTurn"
  | "bindDraftSession"
  | "setActiveSession"
  | "clearMessages"
  | "bindDetachedDraft"
  | "withdrawSend"
>;

export function createSessionSlice(ctx: ChatSliceContext,
  persistence: ChatPersistence,
  provider: StoreApi<ProviderState>,
  composerDrafts?: StoreApi<{ newChat(): void }>): SessionSliceSlice {
  const { set, get } = ctx;
  const { readHistorySelection, persistSessionId } = persistence;
  const persistedSessionId = persistence.readPersistedSessionId();
  return {
    // The stored selection gets its (empty, unconfirmed) buffer, as any
    // selection does, so the session's own frames land while its history
    // is restored (#1328).
    buffers: persistedSessionId ? { [persistedSessionId]: emptyChat() } : {},
    draft: null,
    pendingDraftId: null,
    detachedDrafts: {},
    // localStorage (not sessionStorage) so the active session id survives the
    // PWA process being killed on mobile — that durability is what lets a cold
    // relaunch re-request the full transcript instead of showing nothing.
    activeSessionId: persistedSessionId,
    historyOwners: readHistorySelection() ? {[readHistorySelection()!.key]:readHistorySelection()!.ownerId} : {},
    setHistoryOwner(key,ownerId){
      const historyOwners={...get().historyOwners};if(ownerId)historyOwners[key]=ownerId;else delete historyOwners[key];
      set({historyOwners});if(get().activeSessionId===key)persistSessionId(key,ownerId ?? undefined);
    },
    restoreFailures: {},
    failRestore: (sessionId, failure) =>
      set((state) => (state.buffers[sessionId]?.historyConfirmed && failure.reason !== "missing"
        ? state
        : { restoreFailures: { ...state.restoreFailures, [sessionId]: failure },
          ...(failure.reason === "missing" && state.buffers[sessionId] ? { buffers: { ...state.buffers,
            [sessionId]: { ...state.buffers[sessionId]!, historyConfirmed: undefined } } } : {}),
        })),
    clearRestoreFailure: (sessionId) =>
      set((state) => {
        if (!state.restoreFailures[sessionId]) return state;
        const restoreFailures = { ...state.restoreFailures };
        delete restoreFailures[sessionId];
        return { restoreFailures };
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
          // This client started the conversation: it holds all of it.
          { ...state.buffers, [sessionId]: { ...adopted, lastTouched: Date.now(), historyConfirmed: true } },
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
        persistSessionId(sessionId,sessionId ? state.historyOwners[sessionId] : undefined);
        if (sessionId === null) return { activeSessionId: null };
        const existing = state.buffers[sessionId];
        const buffers = existing
          ? state.buffers
          : evictStale({ ...state.buffers, [sessionId]: emptyChat() }, sessionId);
        // Selecting a session again is a new attempt at restoring it (#1328).
        let restoreFailures = state.restoreFailures;
        if (sessionId !== state.activeSessionId && restoreFailures[sessionId]) {
          restoreFailures = { ...restoreFailures };
          delete restoreFailures[sessionId];
        }
        return { activeSessionId: sessionId, buffers, restoreFailures };
      }),

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
            { ...state.buffers, [sessionId]: existing ?? { ...adopted, lastTouched: Date.now(), historyConfirmed: true } },
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
}
