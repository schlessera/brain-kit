import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./ui-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useUIStore = Object.assign(
  function useUIStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.ui.getState>) => T): T {
    return useRootStore("ui", selector);
  },
  defaultRoot.stores.ui,
);
