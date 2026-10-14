/** Native immutable execution views, acquired before synchronous worker spawn. */
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { createNativeBrainManagerClient } from "./native-brain-manager-client.js";

export interface WorkerStartupStorage {
  readonly root: string;
  retain(): void;
  release(): void | Promise<void>;
  readonly cleanupPid?: number;
}

export interface WorkerStartupView {
  readonly brain: string;
  readonly root: string;
  readonly storage: WorkerStartupStorage;
  /** Drop this reference. The final reference awaits native deletion; failures retain broker recovery intent. */
  cleanup(): void | Promise<void>;
}

const releasedViews = new WeakSet<WorkerStartupView>();

/** Synchronous callers must receive a view acquired by their trusted async host context. */
export function createWorkerStartupView(_brain: string, _options: { omitGit?: boolean; storage?: WorkerStartupStorage } = {}): never {
  throw new Error("Immutable worker inputs require an asynchronously prepared native managed-storage checkpoint; full-copy startup fallback is unavailable. Prepare and pass startupView before spawning.");
}

/** A separate reference for one execution consumer; the supplied owner keeps its reference. */
export function retainWorkerStartupView(view: WorkerStartupView): WorkerStartupView {
  if (releasedViews.has(view)) throw new Error("native startup checkpoint owner is closed");
  view.storage.retain();
  let released = false, completion: void | Promise<void>;
  const retained: WorkerStartupView = { ...view, cleanup() {
    if (!released) { released = true; releasedViews.add(retained); completion = view.storage.release(); }
    return completion;
  } };
  return retained;
}

/**
 * Acquire a complete RO view from the one configured trusted manager. No discovery,
 * filesystem scan, byte-copy fallback or repository execution occurs here.
 * The owner keeps this view only for the approved turn/maintenance input lifetime.
 * Give each worker retainWorkerStartupView(view), await its exited promise, then
 * await the owner's cleanup. A lost RPC releases/reconciles the same identity.
 */
export async function prepareNativeWorkerStartupView(brainPath: string,
  manager: Pick<ReturnType<typeof createNativeBrainManagerClient>, "checkpoint" | "release">,
  signal?: AbortSignal): Promise<WorkerStartupView> {
  signal?.throwIfAborted();
  const brain = realpathSync(brainPath), id = randomUUID();
  if (statfsSync(brain).type !== 0x9123683e || brain !== join(dirname(brain), "brain")) {
    throw new Error("Immutable worker inputs require the configured native Btrfs managed brain; full-copy fallback is unavailable.");
  }
  const expected = join(dirname(brain), ".brain-native", "checkpoints", id);
  try {
    const checkpoint = await manager.checkpoint(id, signal);
    signal?.throwIfAborted();
    if (checkpoint.id !== id || checkpoint.path !== expected || checkpoint.readOnly !== true
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(checkpoint.fsid)
      || !/^[0-9a-f]{32}$/.test(checkpoint.uuid) || !/^[1-9][0-9]*$/.test(checkpoint.rootId)
      || !/^[1-9][0-9]*$/.test(checkpoint.transaction)
      || !lstatSync(expected).isDirectory() || statfsSync(expected).type !== 0x9123683e) {
      throw new Error("Native manager did not return the expected complete immutable checkpoint identity.");
    }
  } catch (error) {
    // Never use an aborted signal for ownership cleanup. Same-ID operations are
    // serialized by the broker, including a checkpoint whose reply was lost.
    try { await manager.release(id); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Native startup checkpoint ${id} has an unknown outcome; reconcile its durable manager intent.`); }
    throw error;
  }
  let refs = 0, closing = false, deletion: Promise<void> | undefined;
  const storage: WorkerStartupStorage = { root: expected,
    retain() { if (closing) throw new Error("native startup checkpoint is closed"); refs++; },
    release() {
      if (closing) return deletion;
      if (--refs > 0) return;
      closing = true;
      deletion = manager.release(id).then(() => {});
      return deletion;
    },
  };
  return retainWorkerStartupView({ brain, root: expected, storage, cleanup() {} });
}
