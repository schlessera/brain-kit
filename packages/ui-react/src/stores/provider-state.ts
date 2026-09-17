import type { StoreEnvironment } from "./store-environment.js";
import { createStore } from "zustand/vanilla";
import type { ProviderInfo } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendInfo } from "../lib/api-client.js";

export interface ProviderState {
  /** Provider combos the server currently offers (metadata only). */
  available: ProviderInfo[];
  /** User's chosen combo for the next new conversation. Persisted. */
  selectedId: string;
  /**
   * Provider the active session is pinned to (from `session_info`). When set,
   * it takes display precedence over `selectedId` and the picker locks.
   */
  pinnedId: string | null;
  /** Capability metadata keyed by backend id. */
  backends: Record<string, BackendInfo>;
  loaded: boolean;

  loadProviders: () => Promise<void>;
  setSelected: (id: string) => void;
  setPinned: (id: string | null) => void;
}

export function createProviderStore(env: StoreEnvironment) {
  const { api } = env;
  const PROVIDER_ID_KEY = env.storageKey("brain-ui:provider-id");

  function readSelectedId(): string {
    const storage = env.storage();
    if (!storage) return "";
    return env.storage()?.getItem(PROVIDER_ID_KEY) ?? "";
  }


  return createStore<ProviderState>((set, get) => ({
    available: [],
    selectedId: readSelectedId(),
    pinnedId: null,
    backends: {},
    loaded: false,

    loadProviders: async () => {
      try {
        const { providers, backends } = await api.providers();
        set((s) => {
          // Keep the persisted choice if it's still on offer; otherwise fall
          // back to the first available combo. This runs on every reload of the
          // roster, so hiding the selected model in settings moves the selection
          // instead of leaving the composer pointing at a profile the picker no
          // longer lists.
          const stillValid = providers.some((p) => p.id === s.selectedId);
          const selectedId =
            stillValid && s.selectedId
              ? s.selectedId
              : providers[0]?.id ?? "";
          // Persist the fallback too — otherwise the stale id sits in
          // localStorage and has to be re-resolved on every boot.
          if (
            selectedId !== s.selectedId &&
            env.storage() !== null
          ) {
            env.storage()?.setItem(PROVIDER_ID_KEY, selectedId);
          }
          return {
            available: providers,
            selectedId,
            backends: backends ?? {},
            loaded: true,
          };
        });
      } catch {
        // Soft-fail: leave the picker empty; the composer still works and
        // sends run on the server default.
        set({ loaded: true });
      }
    },

    setSelected: (id) => {
      if (env.storage() !== null) {
        env.storage()?.setItem(PROVIDER_ID_KEY, id);
      }
      set({ selectedId: id });
    },

    setPinned: (id) => {
      if (get().pinnedId === id) return;
      set({ pinnedId: id });
    },
  }));
}

/** Resolve the backend metadata for an available provider profile. */
export function selectBackendForProvider(
  state: Pick<ProviderState, "available" | "backends">,
  providerId: string | null | undefined
): BackendInfo | null {
  const backendId = state.available.find(
    (provider) => provider.id === providerId
  )?.backendId;
  return backendId ? state.backends[backendId] ?? null : null;
}

