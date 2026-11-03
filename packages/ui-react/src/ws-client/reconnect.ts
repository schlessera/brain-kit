import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { activeChat, type ChatKey } from "../stores/chat-state.js";
import type { BrainUiServices } from "../root.js";

/**
 * Healing the transcript after a dropped socket.
 *
 * After a WS drop, the rendered transcript may have gaps (deltas streamed
 * while offline are lost). We heal by replaying the authoritative session
 * history — immediately if nothing is streaming, or once the in-flight turn
 * settles (result / idle status). The pending resync is keyed to the session
 * that needs healing (the one that was active at the reconnect), so a
 * background session settling first cannot consume it.
 *
 * The socket's own reconnect timing (backoff, liveness probes) belongs to
 * `BrainUiClient`; this is what a page does once a socket opens again.
 */
export function createReconnectHealing(
  root: Pick<BrainUiServices, "stores">,
  send: (message: ClientMessage) => boolean,
) {
  let wasDisconnected = false;
  let resyncSessionId: string | null = null;
  /** The running session in view that a reconnect reattached, until the host answers for it. */
  let reattachSessionId: string | null = null;
  /** Sessions whose started follow-up needs history to be whole (#1002). */
  const followUpRefresh = new Set<string>();

  /**
   * Read a session's history again for a started follow-up that arrived
   * incomplete (#1002), but only once nothing else is waiting in it: a replay
   * that lands after the next queued turn has started would replace its live
   * frames, so the last turn's end takes the refresh instead.
   */
  function refreshFollowUpHistory(sessionId: string | null): boolean {
    if (!sessionId || (root.stores.followUp.getState().pending[sessionId]?.length ?? 0) > 0) return false;
    if (!followUpRefresh.delete(sessionId)) return false;
    if (resyncSessionId === sessionId) resyncSessionId = null;
    send({ type: "session_resume", sessionId });
    return true;
  }

  function resyncIfNeeded(sessionId: string | null): void {
    if (refreshFollowUpHistory(sessionId)) return;
    if (!resyncSessionId || !sessionId || sessionId !== resyncSessionId) return;
    resyncSessionId = null;
    send({ type: "session_resume", sessionId });
  }

  function markHistoryReplaced(key: ChatKey): void {
    // A replay of a transcript that was streaming is not the whole answer
    // yet (a backend may keep it only once it ends, and a first chunk may
    // stop before it): the turn's end replays again.
    const replayed = key === null ? undefined : root.stores.chat.getState().buffers[key];
    if (key !== null && key === resyncSessionId && !replayed?.isStreaming && !replayed?.replay?.base.isStreaming) resyncSessionId = null;
  }

  function disconnected(): void {
    wasDisconnected = true;
    reattachSessionId = null;
  }

  function connected(): void {
    if (!wasDisconnected) return;
    wasDisconnected = false;
    const chat = root.stores.chat.getState();
    const active = activeChat(chat);
    if (!chat.activeSessionId || active.messages.length === 0) return;
    resyncSessionId = chat.activeSessionId;
    if (!active.isStreaming) {
      // Not mid-stream: replay right away.
      resyncIfNeeded(chat.activeSessionId);
      return;
    }
    // Mid-stream: reattach. Only the host knows whether the turn is still
    // running or ended while this page was away, and its answer to a resume
    // says which (a scoped `thinking` or `idle`) after a history that keeps
    // the messages already drawn (#1013). The resync flag stays: the turn's
    // end replays the finished answer.
    reattachSessionId = chat.activeSessionId;
    send({ type: "session_resume", sessionId: chat.activeSessionId });
  }

  return {
    refreshFollowUpHistory,
    resyncIfNeeded,
    markHistoryReplaced,
    disconnected,
    connected,
    /** A started follow-up arrived incomplete: its session's history is read again once its turn ends. */
    refreshAfterTurn(sessionId: string): void { followUpRefresh.add(sessionId); },
    reattaching(): string | null { return reattachSessionId; },
    endReattach(): void { reattachSessionId = null; },
    /** The account's context was dropped: nothing pending survives it. */
    drop(): void { followUpRefresh.clear(); resyncSessionId = null; },
    dispose(): void { resyncSessionId = null; },
  };
}

export type ReconnectHealing = ReturnType<typeof createReconnectHealing>;
