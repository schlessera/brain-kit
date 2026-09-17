import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./provider-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useProviderStore = Object.assign(
  function useProviderStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.provider.getState>) => T): T {
    return useRootStore("provider", selector);
  },
  defaultRoot.stores.provider,
);
