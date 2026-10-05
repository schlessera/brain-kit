import { useCallback } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { useChatStore } from "../stores/chat-store.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { mintHandoffId } from "../lib/handoff.js";
import { useOpenSession } from "./use-open-session.js";

/** The entry's copy, in one place for the three places it appears (#61 §1). */
export const HANDOFF_ENTRY_LABEL = "Continue on another backend";

/** Why a session owned by `backendId` cannot be handed off right now, if it cannot. */
export function handoffWhy(
  providers: readonly { backendId?: string }[],
  backendId: string | undefined,
  connected: boolean
): string | undefined {
  const other = providers.some((p) => p.backendId && p.backendId !== backendId);
  return !other ? "no other backend set up" : !connected ? "needs the host" : undefined;
}

export interface HandoffEntry {
  /** Whether the entry belongs here at all: a stored session with a settled turn. */
  shown: boolean;
  /** Why it cannot run right now. Printed beside it, never a reason to hide it. */
  why?: string;
  open(): void;
}

/**
 * Whether a session can be continued on another backend, and the action
 * that opens the review sheet for it. A session that is not in view is
 * opened first, so the sheet reviews what the reader can see.
 *
 * `settled` says whether the caller knows the session has a settled turn;
 * the session list knows it for every row, the composer only for the one in
 * view.
 */
export function useHandoffEntry(sessionId: string | null, settled: boolean): HandoffEntry {
  const root = useBrainUiRoot();
  const openSession = useOpenSession();
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const providers = useProviderStore((s) => s.available);
  const backendId = useChatStore((s) => (sessionId ? s.backendIds[sessionId] : undefined));
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const why = handoffWhy(providers, backendId, connected);
  const open = useCallback(() => {
    if (!sessionId || why) return;
    if (activeSessionId !== sessionId) openSession(sessionId);
    root.stores.handoff.getState().open(sessionId, mintHandoffId());
  }, [sessionId, why, activeSessionId, openSession, root]);
  return { shown: Boolean(sessionId) && settled, ...(why ? { why } : {}), open };
}
