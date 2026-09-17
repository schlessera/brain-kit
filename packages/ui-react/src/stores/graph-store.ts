import { useRootStore } from "../root-context.js";
import { defaultRoot } from "../default-root.js";
export * from "./graph-state.js";

/** Hook reads the current provider. Statics address the default app only. */
export const useGraphStore = Object.assign(
  function useGraphStore<T>(selector: (state: ReturnType<typeof defaultRoot.stores.graph.getState>) => T): T {
    return useRootStore("graph", selector);
  },
  defaultRoot.stores.graph,
);

export function clearGraphSceneCache(): void { defaultRoot.stores.graph.clearSceneCache(); }
