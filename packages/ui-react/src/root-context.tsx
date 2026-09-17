import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ExtractState, StoreApi } from "zustand/vanilla";
import { defaultRoot } from "./default-root.js";
import { createBrainUiRoot, type BrainUiRoot } from "./root.js";
import type { BrainStores } from "./stores/create-stores.js";

const RootContext = createContext<BrainUiRoot | null>(null);

/** Supply a root explicitly when its lifetime extends beyond this subtree. */
export function BrainUiProvider({ root, children }: { root?: BrainUiRoot; children: ReactNode }) {
  const [owned] = useState(() => createBrainUiRoot());
  const lifetimeRef = useRef({ generation: 0 });
  useEffect(() => {
    const lifetime = lifetimeRef.current;
    const generation = ++lifetime.generation;
    return () => {
      // StrictMode replays effects using the same root. Dispose only when no
      // replacement setup took ownership before this microtask runs.
      queueMicrotask(() => { if (generation === lifetime.generation) owned.dispose(); });
    };
  }, [owned]);
  return <RootContext.Provider value={root ?? owned}>{children}</RootContext.Provider>;
}

export function useBrainUiRoot(): BrainUiRoot {
  return useContext(RootContext) ?? defaultRoot;
}

export function useBrainApi() { return useBrainUiRoot().api; }
export function useBrainConfig() { return useBrainUiRoot().config; }

/** The key carries the selected store's state type through the root lookup. */
export function useRootStore<K extends keyof BrainStores, T>(
  key: K,
  selector: (state: ExtractState<BrainStores[K]>) => T,
): T {
  const store = useBrainUiRoot().stores[key] as StoreApi<ExtractState<BrainStores[K]>>;
  return useStore<StoreApi<ExtractState<BrainStores[K]>>, T>(store, selector);
}
