import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useBrainUiRoot } from "../root-context.js";
import type { LocalWorkStatus, WorkRestore } from "../lib/local-work.js";

// A root without device-local storage keeps nothing and restores nothing.
const NONE_KEPT = createStore<LocalWorkStatus>(() => ({ failed: false, pending: false }));
const NOTHING_TO_RESTORE = createStore<WorkRestore>(() => ({ selection: null, focusId: null, scroll: null }));

/** Whether the work context is being kept on this device (#1014). */
export function useLocalWorkStatus<T>(selector: (state: LocalWorkStatus) => T): T {
  return useStore(useBrainUiRoot().localWork?.status ?? NONE_KEPT, selector);
}

/** What a restore after reload hands this view, until the view consumes it (#1014). */
export function useWorkRestore<T>(selector: (state: WorkRestore) => T): T {
  return useStore(useBrainUiRoot().localWork?.restore ?? NOTHING_TO_RESTORE, selector);
}
