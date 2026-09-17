import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./principal-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const usePrincipalStore = Object.assign(
  function usePrincipalStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.principal.getState>) => T): T {
    return useRootStore("principal", selector);
  },
  defaultRoot.stores.principal,
);
