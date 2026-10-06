import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./follow-up-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useFollowUpStore = Object.assign(
  function useFollowUpStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.followUp.getState>) => T): T {
    return useRootStore("followUp", selector);
  },
  defaultRoot.stores.followUp,
);
