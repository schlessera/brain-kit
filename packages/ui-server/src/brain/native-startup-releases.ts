/** Bounded owner of startup checkpoints no admission consumer needs (#4304). */
import type { WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";

export const STARTUP_RELEASE_BACKLOG = 2;
export interface StartupReleaseResult {
  turnId: string; checkpointId: string; durationMs: number; attempt: number;
  outcome: "released" | "retry"; cause?: string;
}
export function createNativeStartupReleases(report: (result: StartupReleaseResult) => void = () => {}, retryMs = 30_000) {
  let owners = 0, closing = false;
  const waiters = new Set<() => void>();
  const pending = new Map<string, { view: WorkerStartupView; attempt: number; work?: Promise<void>; error?: unknown }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => { for (const wake of waiters) wake(); waiters.clear(); };
  function retryLater(): void {
    if (closing || timer || ![...pending.values()].some(entry => entry.error)) return;
    timer = setTimeout(() => { timer = undefined; for (const [id, entry] of pending) if (entry.error) start(id, entry); }, retryMs);
    timer.unref?.();
  }
  function start(turnId: string, entry: { view: WorkerStartupView; attempt: number; work?: Promise<void>; error?: unknown }): Promise<void> {
    if (entry.work) return entry.work;
    const started = performance.now(); entry.attempt++; entry.error = undefined;
    entry.work = Promise.resolve().then(() => entry.view.cleanup()).then(() => {
      pending.delete(turnId); owners--; changed();
      try { report({ turnId, checkpointId: entry.view.root.split("/").at(-1)!, durationMs: performance.now() - started, attempt: entry.attempt, outcome: "released" }); } catch { /* Diagnostics never own the release. */ }
    }, error => {
      entry.error = error;
      try { report({ turnId, checkpointId: entry.view.root.split("/").at(-1)!, durationMs: performance.now() - started, attempt: entry.attempt, outcome: "retry", cause: String(error).slice(0, 2000) }); } catch { /* Keep the checkpoint for retry. */ }
    }).finally(() => { entry.work = undefined; changed(); retryLater(); });
    return entry.work;
  }
  async function drain(): Promise<void> {
    for (const [id, entry] of [...pending]) {
      if (pending.get(id) !== entry) continue;
      await (entry.work ?? start(id, entry));
      if (entry.error) throw entry.error;
    }
  }
  return {
    async reserve(signal?: AbortSignal) {
      while (owners >= STARTUP_RELEASE_BACKLOG) {
        signal?.throwIfAborted();
        if (pending.size) await drain();
        else await new Promise<void>((resolve, reject) => {
          const wake = () => { signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => { waiters.delete(wake); reject(signal!.reason); };
          waiters.add(wake); signal?.addEventListener("abort", abort, { once: true });
        });
      }
      signal?.throwIfAborted();
      if (closing) throw new Error("Startup checkpoint releases are closing");
      owners++;
      let owned = true;
      return {
        handoff(turnId: string, view: WorkerStartupView) {
          if (!owned || pending.has(turnId)) throw new Error("Startup checkpoint already has a release owner");
          const entry = { view, attempt: 0 }; pending.set(turnId, entry); owned = false;
          void start(turnId, entry);
        },
        release() { if (owned) { owned = false; owners--; changed(); } },
      };
    },
    pending: () => pending.size,
    drain,
    // A failed cleanup alone never stops an already running turn. The native
    // manager still charges its retained extents and adjudicates new space.
    async settled() { await Promise.all([...pending.values()].flatMap(entry => entry.work ? [entry.work] : [])); },
    async close() { closing = true; clearTimeout(timer); timer = undefined; await drain(); },
  };
}
export type NativeStartupReleases = ReturnType<typeof createNativeStartupReleases>;
// The host passes the same leased manager to admission and observation.
const releases = new WeakMap<object, NativeStartupReleases>();
export function nativeStartupReleases(manager: object): NativeStartupReleases {
  let owner = releases.get(manager);
  if (!owner) { owner = createNativeStartupReleases(); releases.set(manager, owner); }
  return owner;
}
export function setNativeStartupReleases(manager: object, owner: NativeStartupReleases): void {
  if (releases.has(manager)) throw new Error("Startup release owner already initialized");
  releases.set(manager, owner);
}
