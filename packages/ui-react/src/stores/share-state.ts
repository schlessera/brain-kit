import { createStore } from "zustand/vanilla";
import type { StoredShare } from "@schlessera/brain-ui-sdk/share-target";
import type { ShareShellState } from "./shell-stores.js";

/**
 * Shares waiting for the user to confirm them.
 *
 * They queue rather than run: a share is untrusted input (any website can POST
 * to the share target), and the client can only have ONE unbound chat draft at
 * a time — two turns started before the first `session_info` arrives would put
 * both messages in the same buffer and then silently drop the second session's
 * transcript. One at a time, each behind a tap, solves both.
 */
export interface ShareIntakeState {
  /** Claimed shares, oldest first. The head is the one on screen. */
  queue: StoredShare[];
  /** An upload or send is in flight; no second share may start. */
  busy: boolean;
  phase: "review" | "uploading" | "parsing" | "paused";
  /** Something the user needs to see rather than a silent failure. */
  error: string | null;
  /** Non-fatal notes about the last confirm (images over the vision cap, …). */
  notes: string[];

  enqueue: (record: StoredShare) => void;
  remove: (id: string) => void;
  setPhase: (phase: ShareIntakeState["phase"]) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setNotes: (notes: string[]) => void;
}

export function createShareStore() {
  return createStore<ShareIntakeState>((set) => ({
    queue: [],
    busy: false,
    phase: "review",
    error: null,
    notes: [],

    enqueue: (record) =>
      set((state) =>
        state.queue.some((queued) => queued.id === record.id)
          ? state
          : { queue: [...state.queue, record] }
      ),

    remove: (id) =>
      set((state) => ({ queue: state.queue.filter((queued) => queued.id !== id) })),

    setPhase: phase => set({ phase }),
    setBusy: (busy) => set({ busy, ...(!busy ? { phase: "review" as const } : {}) }),
    setError: (error) => set({ error }),
    setNotes: (notes) => set({ notes }),
  }));
}

/** Whether a share is pending — the shell reads this to defer a reload. */
export function hasPendingShare(state: ShareShellState): boolean {
  return state.queue.length > 0 || state.busy;
}
