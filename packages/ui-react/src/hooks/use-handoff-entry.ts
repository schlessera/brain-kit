import { useCallback } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { useChatStore } from "../stores/chat-store.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { mintHandoffId } from "../lib/handoff.js";
import { useOpenSession } from "./use-open-session.js";
import { useBackendName } from "../components/chat/handoff-links.js";

/** The entry's copy, in one place for the three places it appears (#61 §1). */
export const HANDOFF_ENTRY_LABEL = "Continue on another backend";

/**
 * Why a session owned by `backendId` cannot be handed off right now, if it cannot.
 *
 * With no runnable profile on another backend, the configured ones that
 * cannot run (#1044) say what to fix (#1090): every such backend, named by
 * `name` and joined with `, `, then `needs credentials` when each of their
 * profiles reports `needs-credentials`, else `can't run now` (the split
 * `unavailableReasonCopy` makes in the sheet). Like "no other backend set
 * up", which stays for a host where no other backend reports any profile,
 * it comes before "needs the host".
 */
export function handoffWhy(
  providers: readonly { backendId?: string }[],
  backendId: string | undefined,
  connected: boolean,
  unavailable: readonly { backendId?: string; reason: string }[] = [],
  name: (backendId: string) => string = (id) => id
): string | undefined {
  const other = providers.some((p) => p.backendId && p.backendId !== backendId);
  if (other) return connected ? undefined : "needs the host";
  const blocked = unavailable.filter((p) => p.backendId && p.backendId !== backendId);
  if (!blocked.length) return "no other backend set up";
  const backends = [...new Set(blocked.map((p) => p.backendId!))];
  const reason = !blocked.every((p) => p.reason === "needs-credentials")
    ? "can't run now"
    : backends.length > 1 ? "need credentials" : "needs credentials";
  return `${backends.map(name).join(", ")} ${reason}`;
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
  const unavailable = useProviderStore((s) => s.unavailable);
  const backendName = useBackendName();
  const backendId = useChatStore((s) => (sessionId ? s.backendIds[sessionId] : undefined));
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const why = handoffWhy(providers, backendId, connected, unavailable, backendName);
  const open = useCallback(() => {
    if (!sessionId || why) return;
    const opening = activeSessionId !== sessionId;
    if (opening) openSession(sessionId);
    root.stores.handoff.getState().open(sessionId, mintHandoffId(), { awaitHistory: opening });
  }, [sessionId, why, activeSessionId, openSession, root]);
  return { shown: Boolean(sessionId) && settled, ...(why ? { why } : {}), open };
}
