import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./file-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useFileStore = Object.assign(
  function useFileStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.file.getState>) => T): T {
    return useRootStore("file", selector);
  },
  defaultRoot.stores.file,
);
