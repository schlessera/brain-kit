// The saved brain-wide live-conversation default (#3616), read and written
// for Settings › Voice. The state belongs to the root, not to the pane: a pick
// the pane accepted is written even if the pane closes meanwhile. Writes are
// latest-wins and one at a time, each against the newest revision the root
// knows. Nothing here opens a provider, a microphone or reads history; a save
// changes only the next explicit Start.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { VoiceLiveSettings } from "@schlessera/brain-ui-sdk/protocol";
import { ApiRequestError } from "../lib/api-client.js";
import type { BrainUiRoot } from "../root.js";

type LiveSettingsStatus = { kind: "saving" } | { kind: "stale" } | { kind: "failed"; text: string; retry: string | null };

interface LiveSettingsState {
  settings: VoiceLiveSettings | null;
  /** `forbidden`: this principal is not the owner (the server's answer). */
  load: "idle" | "loading" | "loaded" | "forbidden" | "failed";
  /** The pick on its way; `undefined` when none is. */
  pending: string | null | undefined;
  status: LiveSettingsStatus | null;
}

interface Queue { desired: string | null | undefined; running: Promise<void> | null; epoch: number }
const stores = new WeakMap<object, { store: StoreApi<LiveSettingsState>; queue: Queue }>();

function entry(root: BrainUiRoot) {
  let found = stores.get(root.stores);
  if (!found) {
    found = { store: createStore<LiveSettingsState>(() => ({ settings: null, load: "idle", pending: undefined, status: null })), queue: { desired: undefined, running: null, epoch: root.authLock.epoch() } };
    stores.set(root.stores, found);
  }
  // A new auth generation ends what the last one read or queued.
  if (found.queue.epoch !== root.authLock.epoch()) {
    found.queue = { desired: undefined, running: null, epoch: root.authLock.epoch() };
    found.store.setState({ settings: null, load: "idle", pending: undefined, status: null });
  }
  return found;
}

export function liveSettingsStore(root: BrainUiRoot): StoreApi<LiveSettingsState> {
  return entry(root).store;
}

/** Read the saved default. A 403 means this principal may neither read nor write it. */
export async function loadLiveSettings(root: BrainUiRoot): Promise<void> {
  const { store, queue } = entry(root);
  if (!store.getState().settings) store.setState({ load: "loading" });
  try {
    const settings = await root.api.liveSettings();
    if (queue !== entry(root).queue) return;
    store.setState({ settings, load: "loaded" });
  } catch (error) {
    if (queue !== entry(root).queue) return;
    store.setState({ load: error instanceof ApiRequestError && error.status === 403 ? "forbidden" : "failed" });
  }
}

/** Accept a pick (`null` clears the default). It is written for the root's life while the auth generation holds. */
export function saveLiveDefault(root: BrainUiRoot, defaultProvider: string | null): Promise<void> {
  const { store, queue } = entry(root);
  queue.desired = defaultProvider;
  store.setState({ pending: defaultProvider, status: { kind: "saving" } });
  return queue.running ??= drain(root, queue).finally(() => { queue.running = null; });
}

async function drain(root: BrainUiRoot, queue: Queue): Promise<void> {
  const { store } = entry(root);
  const over = () => queue !== entry(root).queue;
  while (!over() && queue.desired !== undefined) {
    const want = queue.desired;
    const base = store.getState().settings;
    if (!base) {
      queue.desired = undefined;
      store.setState({ pending: undefined, status: { kind: "failed", text: "Couldn't save. Your live service is unchanged.", retry: want } });
      return;
    }
    try {
      const saved = await root.api.saveLiveSettings({ defaultProvider: want, revision: base.revision });
      if (over()) return;
      store.setState({ settings: saved });
      if (queue.desired === want) queue.desired = undefined;
    } catch (error) {
      if (over()) return;
      const status = error instanceof ApiRequestError ? error.status : 0;
      const code = error instanceof Error ? error.message : "";
      if (status === 403) {
        // The server is the authority: nothing queued can land.
        queue.desired = undefined;
        store.setState({ pending: undefined, status: null, load: "forbidden" });
        return;
      }
      if (status === 409) {
        // Changed on another device: a pick made against the old value is dropped with it.
        queue.desired = undefined;
        store.setState({ pending: undefined, status: { kind: "stale" } });
        await loadLiveSettings(root);
        return;
      }
      // A newer pick made meanwhile supersedes the one that failed.
      if (queue.desired !== want) continue;
      queue.desired = undefined;
      const unknown = code === "LIVE_PROVIDER_UNKNOWN";
      store.setState({ pending: undefined, status: { kind: "failed", text: unknown ? "That live service isn't available on this host." : "Couldn't save. Your live service is unchanged.", retry: want } });
      if (unknown) await loadLiveSettings(root);
      return;
    }
  }
  if (!over()) store.setState({ pending: undefined, status: null });
}
