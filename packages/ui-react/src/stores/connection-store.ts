import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./connection-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useConnectionStore = Object.assign(
  function useConnectionStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.connection.getState>) => T): T {
    return useRootStore("connection", selector);
  },
  defaultRoot.stores.connection,
);
