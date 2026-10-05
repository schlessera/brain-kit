import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./inbox-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useInboxStore = Object.assign(
  function useInboxStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.inbox.getState>) => T): T {
    return useRootStore("inbox", selector);
  },
  defaultRoot.stores.inbox,
);
