import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./activity-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useActivityStore = Object.assign(
  function useActivityStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.activity.getState>) => T): T {
    return useRootStore("activity", selector);
  },
  defaultRoot.stores.activity,
);

export const loadSessionActivityHistory = defaultRoot.stores.activity.loadSessionActivityHistory;
export const loadSpanPayloads = defaultRoot.stores.activity.loadSpanPayloads;
