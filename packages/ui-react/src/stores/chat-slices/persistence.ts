/**
 * What the chat store keeps in browser storage (#1361): the selected
 * session, the state-room dismissals and the pending turn retries. Every
 * reader tolerates a missing, corrupt or foreign value.
 */
import type { ChatState, PendingTurnRetry } from "../chat-state.js";
import type { StoreEnvironment } from "../store-environment.js";

export type ChatPersistence = ReturnType<typeof createChatPersistence>;

export function createChatPersistence(env: StoreEnvironment) {
  const SESSION_ID_KEY = env.storageKey("brain-sessionId");
  const HISTORY_SELECTION_KEY = env.storageKey("brain-history-selection");
  function readHistorySelection():{key:string;ownerId:string}|null {
    try {const value:unknown=JSON.parse(env.storage()?.getItem(HISTORY_SELECTION_KEY) ?? "null");
      if(value && typeof value === "object" && "key" in value && "ownerId" in value && typeof value.key === "string" && typeof value.ownerId === "string" && value.key.length<=512 && value.ownerId.length<=256)return {key:value.key,ownerId:value.ownerId};
    }catch{/* A corrupt selection grants no routing authority. */}return null;
  }
  const STATE_ROOM_KEY = env.storageKey("brain-state-room-preferences");
  function readStateRoomPreferences(): ChatState["stateRoomPreferences"] {
    try {
      const parsed: unknown = JSON.parse(env.storage()?.getItem(STATE_ROOM_KEY) ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).flatMap(([sessionId, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const preference = value as { dismissedAllowance?: unknown; invalidatedAt?: unknown; backendId?: unknown; measuredAt?: unknown };
        const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
        return [[sessionId, {
          ...(valid(preference.dismissedAllowance) && preference.dismissedAllowance > 0 ? { dismissedAllowance: preference.dismissedAllowance } : {}),
          ...(valid(preference.invalidatedAt) ? { invalidatedAt: preference.invalidatedAt } : {}),
          ...(typeof preference.backendId === "string" && preference.backendId.length <= 200 ? { backendId: preference.backendId } : {}),
          ...(valid(preference.measuredAt) ? { measuredAt: preference.measuredAt } : {}),
        }]];
      }));
    } catch { return {}; }
  }
  function persistStateRoomPreferences(preferences: ChatState["stateRoomPreferences"]): void {
    try { env.storage()?.setItem(STATE_ROOM_KEY, JSON.stringify(preferences)); } catch { /* The in-memory dismissal still holds. */ }
  }

  /**
   * Persist the active session id to localStorage when a DOM is present (the
   * browser). A no-op in non-DOM environments (tests, SSR) so creating the store
   * never throws on a missing `localStorage`.
   */
  function persistSessionId(id: string | null, ownerId?:string) {
    const storage = env.storage();
    if (!storage) return;
    if(id && ownerId){storage.setItem(HISTORY_SELECTION_KEY,JSON.stringify({key:id,ownerId}));storage.removeItem(SESSION_ID_KEY);}
    else {if(id) storage.setItem(SESSION_ID_KEY,id);else storage.removeItem(SESSION_ID_KEY);storage.removeItem(HISTORY_SELECTION_KEY);}
  }

  function readPersistedSessionId(): string | null {
    const storage = env.storage();
    if (!storage) return null;
    return readHistorySelection()?.key ?? storage.getItem(SESSION_ID_KEY);
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
  function persistRetries(turnRetries: Record<string, PendingTurnRetry>): void {
    try {
      env.storage()?.setItem(RETRIES_KEY, JSON.stringify(Object.fromEntries(Object.entries(turnRetries).filter(([, r]) => r.state !== "refused"))));
    } catch { /* The host also consumes each failed-turn handle once. */ }
  }

  return {
    readHistorySelection,
    readStateRoomPreferences,
    persistStateRoomPreferences,
    persistSessionId,
    readPersistedSessionId,
    readRetries,
    persistRetries,
  };
}
