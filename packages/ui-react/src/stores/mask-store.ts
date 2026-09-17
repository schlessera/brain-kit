import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./mask-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useMaskStore = Object.assign(
  function useMaskStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.mask.getState>) => T): T {
    return useRootStore("mask", selector);
  },
  defaultRoot.stores.mask,
);
