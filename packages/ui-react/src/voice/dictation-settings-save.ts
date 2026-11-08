// Writes of the brain-wide dictation choice (#3709, plan §7).
//
// The queue belongs to the root, not to Settings › Voice: a choice the pane
// accepted is written even if the pane closes while an earlier write is still
// on its way. Writes are latest-wins and one at a time, each against the
// newest revision the root knows. The pane only presents the state kept in
// the voice store. Nothing here requests a session, a microphone or a provider.

import { ApiRequestError } from "../lib/api-client.js";
import type { BrainUiRoot } from "../root.js";
import { confirmDictationSettings, invalidateDiscovery, loadDiscovery } from "./dictation-providers.js";
import type { DictationChoice, DictationSaveState } from "./voice-state.js";

type Queue = { desired: DictationChoice | null; running: Promise<void> | null };
const queues = new WeakMap<object, Queue>();
const queueOf = (root: BrainUiRoot): Queue => {
  let queue = queues.get(root.stores);
  if (!queue) queues.set(root.stores, queue = { desired: null, running: null });
  return queue;
};

function patch(root: BrainUiRoot, next: Partial<DictationSaveState>): void {
  root.stores.voice.setState((state) => ({ dictationSave: { ...state.dictationSave, ...next } }));
}

/** Whether a write is still on its way. */
export function dictationSaveRunning(root: BrainUiRoot): boolean {
  return queueOf(root).running !== null;
}

/**
 * Read discovery again. A failure is reported however recent the shown
 * snapshot is, because what is shown may no longer be the server's.
 */
export async function refreshDictationDiscovery(root: BrainUiRoot): Promise<boolean> {
  try {
    await loadDiscovery(root, { force: true });
    const status = root.stores.voice.getState().dictationSave.status;
    patch(root, { refreshFailed: false, ...(status?.kind === "stale" ? { status: { kind: "stale", current: true } } : {}) });
    return true;
  } catch {
    patch(root, { refreshFailed: true });
    return false;
  }
}

/** Accept a choice; it is written for the root's life, whatever shows it. */
export function saveDictationChoice(root: BrainUiRoot, choice: DictationChoice): Promise<void> {
  const queue = queueOf(root);
  queue.desired = choice;
  patch(root, { pending: choice, status: { kind: "saving" } });
  return queue.running ??= drain(root, queue).finally(() => { queue.running = null; });
}

async function drain(root: BrainUiRoot, queue: Queue): Promise<void> {
  while (queue.desired) {
    const want: DictationChoice = queue.desired;
    const base = root.stores.voice.getState().discovery?.snapshot;
    if (!base) {
      queue.desired = null;
      patch(root, { pending: null, status: { kind: "failed", retry: want, text: "Couldn't save. Your dictation service is unchanged." } });
      return;
    }
    try {
      confirmDictationSettings(root, await root.api.saveDictationSettings({ ...want, revision: base.dictation.revision }));
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      const code = error instanceof Error ? error.message : "";
      if (status === 403) {
        // The server is the authority: this account cannot write, so nothing queued can land.
        queue.desired = null;
        patch(root, { pending: null, status: null, refusedAccount: root.stores.connection.getState().accountKey ?? "" });
        return;
      }
      if (status === 409 || status === 428) {
        // Changed on another device. A choice made against the old value is dropped with it.
        queue.desired = null;
        patch(root, { pending: null, status: { kind: "stale", current: false } });
        invalidateDiscovery(root);
        await refreshDictationDiscovery(root);
        return;
      }
      // A newer choice made meanwhile supersedes the one that failed.
      if (queue.desired !== want) continue;
      queue.desired = null;
      const unknown = code === "speech_provider_unknown";
      patch(root, { pending: null, status: { kind: "failed", retry: want, text: unknown ? "That dictation service isn't available on this host." : "Couldn't save. Your dictation service is unchanged." } });
      if (unknown) { invalidateDiscovery(root); await refreshDictationDiscovery(root); }
      return;
    }
    if (queue.desired === want) queue.desired = null;
    // The server's answer is shown already; read the rest of discovery again.
    await refreshDictationDiscovery(root);
  }
  patch(root, { pending: null, status: null });
}
