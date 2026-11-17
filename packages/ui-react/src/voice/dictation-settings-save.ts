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
import type { DictationChoice, DictationSaveState, DictationWriter } from "./voice-state.js";

/**
 * The identity a choice was accepted under: the writer the pane established
 * (the connection's account, or the account its own probe named, and the auth
 * generation), plus the connection's account at that moment. A queue serves
 * one identity: sign-out, a lock, a restore, an account change or disposing
 * the root ends it, and none of its choices is then written for whoever
 * comes next.
 */
type Ticket = DictationWriter & { connection: string | null };
type Queue = { ticket: Ticket; desired: DictationChoice | null; running: Promise<void> | null; ended: boolean };
const queues = new WeakMap<object, Queue>();

const live = (root: BrainUiRoot, ticket: Ticket): boolean =>
  root.authLock.epoch() === ticket.epoch && root.stores.connection.getState().accountKey === ticket.connection;

/** End a queue for good: nothing it still holds is written, and it shows nothing more. */
function end(root: BrainUiRoot, queue: Queue): void {
  if (queue.ended) return;
  queue.ended = true;
  queue.desired = null;
  if (queues.get(root.stores) !== queue) return;
  queues.delete(root.stores);
  patch(root, { pending: null, status: null });
}

/** The root's queue for this writer; one accepted under another identity ends first. */
function queueFor(root: BrainUiRoot, writer: DictationWriter): Queue {
  const ticket: Ticket = { ...writer, connection: root.stores.connection.getState().accountKey };
  const queue = queues.get(root.stores);
  if (queue && !queue.ended && live(root, queue.ticket) && queue.ticket.account === ticket.account && live(root, ticket)) return queue;
  if (queue) end(root, queue);
  const next: Queue = { ticket, desired: null, running: null, ended: false };
  queues.set(root.stores, next);
  return next;
}

function patch(root: BrainUiRoot, next: Partial<DictationSaveState>): void {
  root.stores.voice.setState((state) => ({ dictationSave: { ...state.dictationSave, ...next } }));
}

/** Whether a write is still on its way. */
export function dictationSaveRunning(root: BrainUiRoot): boolean {
  const queue = queues.get(root.stores);
  return !!queue?.running && !queue.ended && live(root, queue.ticket);
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

/**
 * Accept a choice from `writer`; it is written for the root's life, whatever
 * shows it, while the same identity holds. A writer whose generation is
 * already over is not accepted.
 */
export function saveDictationChoice(root: BrainUiRoot, choice: DictationChoice, writer: DictationWriter): Promise<void> {
  const queue = queueFor(root, writer);
  if (!live(root, queue.ticket)) { end(root, queue); return Promise.resolve(); }
  queue.desired = choice;
  patch(root, { pending: choice, status: { kind: "saving" } });
  return queue.running ??= drain(root, queue).finally(() => { queue.running = null; });
}

async function drain(root: BrainUiRoot, queue: Queue): Promise<void> {
  const { ticket } = queue;
  // Auth loss and account changes end the queue at once, not only when the
  // write on its way answers.
  const stopAuth = root.authLock.state.subscribe(() => { if (!live(root, ticket)) end(root, queue); });
  const stopAccount = root.stores.connection.subscribe((next, prior) => { if (next.accountKey !== prior.accountKey) end(root, queue); });
  // Cancellation is final: a newer queued choice is never moved on to.
  const over = () => { if (!queue.ended && !live(root, ticket)) end(root, queue); return queue.ended; };
  try {
    while (!over() && queue.desired) {
      const want: DictationChoice = queue.desired;
      const base = root.stores.voice.getState().discovery?.snapshot;
      if (!base) {
        queue.desired = null;
        patch(root, { pending: null, status: { kind: "failed", retry: want, text: "Couldn't save. Your dictation service is unchanged." } });
        return;
      }
      let saved: Awaited<ReturnType<BrainUiRoot["api"]["saveDictationSettings"]>>;
      try {
        saved = await root.api.saveDictationSettings({ ...want, revision: base.dictation.revision });
      } catch (error) {
        if (over()) return;
        const status = error instanceof ApiRequestError ? error.status : 0;
        const code = error instanceof Error ? error.message : "";
        if (status === 403) {
          // The server is the authority: this writer cannot write, so nothing queued can land.
          queue.desired = null;
          patch(root, { pending: null, status: null, refused: { account: ticket.account, epoch: ticket.epoch } });
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
      if (over()) return;
      confirmDictationSettings(root, saved);
      if (queue.desired === want) queue.desired = null;
      // The server's answer is shown already; read the rest of discovery again.
      await refreshDictationDiscovery(root);
    }
    if (!queue.ended) patch(root, { pending: null, status: null });
  } finally {
    stopAuth(); stopAccount();
  }
}
