import { createStore } from "zustand/vanilla";
import type { ContentRendererDeclaration } from "@schlessera/brain-ui-sdk";
import type { StoreEnvironment } from "./store-environment.js";

/** Authenticated declarations belong to this root and account, never a process global. */
export function createContentRendererStore({ api }: Pick<StoreEnvironment, "api">) {
  let generation = 0;
  let pending: Promise<void> | undefined;
  return createStore<{ warned: Set<string>; declarations: readonly ContentRendererDeclaration[]; loaded: boolean; load(): Promise<void>; reset(): void }>((set, get) => ({
    warned: new Set<string>(), declarations: [], loaded: false,
    load() {
      if (pending) return pending;
      if (get().loaded) return Promise.resolve();
      const started = generation;
      const request = api.status().then(status => {
        if (generation === started) set({ declarations: status.contentRenderers ?? [], loaded: true });
      }).catch(() => { /* Offline or signed out: retain source and retry on reconnect. */ }).finally(() => {
        if (pending === request) pending = undefined;
      });
      pending = request;
      return request;
    },
    reset() { generation++; pending = undefined; set({ declarations: [], loaded: false }); },
  }));
}
