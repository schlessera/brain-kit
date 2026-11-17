import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./markup-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useMarkupStore = Object.assign(
  function useMarkupStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.markup.getState>) => T): T {
    return useRootStore("markup", selector);
  },
  defaultRoot.stores.markup,
);
