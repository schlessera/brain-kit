/**
 * Session status (#1361): run state and queue notes, backend and
 * state-room readings, send and scope-decision receipts, pending turn
 * retries, and composer insert requests.
 */
import type { ChatState } from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";
import type { ChatPersistence } from "./persistence.js";

type StatusSliceSlice = Pick<ChatState,
  | "scopeDecisionReceipts"
  | "setScopeDecisionReceipt"
  | "chatReceipts"
  | "setChatReceipt"
  | "clearChatReceipt"
  | "turnRetries"
  | "setTurnRetry"
  | "runStates"
  | "queueNotes"
  | "backendIds"
  | "stateRooms"
  | "stateRoomPreferences"
  | "stateRoomAnnouncements"
  | "setStateRoom"
  | "dismissStateRoom"
  | "invalidateStateRoom"
  | "markStateRoomAnnounced"
  | "setRunState"
  | "setSessionBackend"
  | "composerInsert"
  | "requestComposerInsert"
  | "clearComposerInsert"
>;

export function createStatusSlice(ctx: ChatSliceContext, persistence: ChatPersistence): StatusSliceSlice {
  const { set, get } = ctx;
  const { readRetries, persistRetries, readStateRoomPreferences, persistStateRoomPreferences } = persistence;
  /** Monotonic per store, so every take is a new request. */
  let composerInsertSeq = 0;
  return {
    scopeDecisionReceipts: {},
    setScopeDecisionReceipt(receipt) {
      const entries = Object.entries(get().scopeDecisionReceipts).filter(([id]) => id !== receipt.eventId).slice(-255);
      set({ scopeDecisionReceipts: Object.fromEntries([...entries, [receipt.eventId, receipt]]) });
    },
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

    turnRetries: readRetries(),
    setTurnRetry(sessionId, retry) {
      const turnRetries = { ...get().turnRetries };
      if (retry) turnRetries[sessionId] = retry;
      else delete turnRetries[sessionId];
      persistRetries(turnRetries);
      set({ turnRetries });
    },

    runStates: {},
    queueNotes: {},
    backendIds: {},
    stateRooms: {},
    stateRoomPreferences: readStateRoomPreferences(),
    stateRoomAnnouncements: {},
    setStateRoom(sessionId, observation, historical = false) {
      const rooms = { ...get().stateRooms };
      const current = rooms[sessionId];
      if (observation && current && current.observation.observedAt > observation.observedAt) return;
      if (historical && current && !current.historical && (!observation || current.observation.observedAt === observation.observedAt)) return;
      if (observation) rooms[sessionId] = { observation, historical };
      else delete rooms[sessionId];
      const preferences = { ...get().stateRoomPreferences };
      if (observation && !historical && (preferences[sessionId]?.invalidatedAt !== undefined
        || (preferences[sessionId]?.dismissedAllowance !== undefined && preferences[sessionId]!.dismissedAllowance !== observation.allowanceBytes))) {
        const dismissed = preferences[sessionId]?.dismissedAllowance;
        preferences[sessionId] = { ...(dismissed === observation.allowanceBytes ? { dismissedAllowance: dismissed } : {}) };
        persistStateRoomPreferences(preferences);
      }
      set({ stateRooms: rooms, stateRoomPreferences: preferences });
    },
    dismissStateRoom(sessionId, allowanceBytes) {
      const preferences = { ...get().stateRoomPreferences, [sessionId]: { ...get().stateRoomPreferences[sessionId], dismissedAllowance: allowanceBytes,
        backendId: get().backendIds[sessionId], measuredAt: get().stateRooms[sessionId]?.observation.observedAt } };
      persistStateRoomPreferences(preferences); set({ stateRoomPreferences: preferences });
    },
    invalidateStateRoom(sessionId, observedAt) {
      const prior = get().stateRoomPreferences[sessionId];
      if (prior?.invalidatedAt === observedAt && prior.dismissedAllowance === undefined) return;
      const preferences = { ...get().stateRoomPreferences, [sessionId]: { invalidatedAt: observedAt } };
      persistStateRoomPreferences(preferences); set({ stateRoomPreferences: preferences });
    },
    markStateRoomAnnounced(sessionId, allowanceBytes) {
      set({ stateRoomAnnouncements: { ...get().stateRoomAnnouncements, [sessionId]: allowanceBytes } });
    },

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
  };
}
