import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./share-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useShareStore = Object.assign(
  function useShareStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.share.getState>) => T): T {
    return useRootStore("share", selector);
  },
  defaultRoot.stores.share,
);
