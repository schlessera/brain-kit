import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./handoff-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useHandoffStore = Object.assign(
  function useHandoffStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.handoff.getState>) => T): T {
    return useRootStore("handoff", selector);
  },
  defaultRoot.stores.handoff,
);
