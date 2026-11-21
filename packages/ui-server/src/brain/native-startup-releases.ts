/** Bounded owner of startup checkpoints no admission consumer needs (#4304). */
import type { WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";

export const STARTUP_RELEASE_BACKLOG = 2;
export interface StartupReleaseResult {
  turnId: string; checkpointId: string; durationMs: number; attempt: number;
  outcome: "released" | "retry"; at: number; errorClass?: string; retrying?: boolean; cause?: string;
}
export function createNativeStartupReleases(report: (result: StartupReleaseResult) => unknown = () => {}, retryMs = 30_000) {
  let owners = 0, completed = 0, closing = false;
  const waiters = new Set<() => void>();
  const attempts = new Set<Promise<void>>();
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
    entry.work = Promise.resolve().then(() => entry.view.cleanup()).then(async () => {
      pending.delete(turnId); owners--; completed++; changed();
      try { await report({ at: Date.now(), turnId, checkpointId: entry.view.root.split("/").at(-1)!, durationMs: performance.now() - started, attempt: entry.attempt, outcome: "released" }); } catch { /* Diagnostics never own the release. */ }
    }, async error => {
      entry.error = error;
      try { await report({ at: Date.now(), errorClass: error instanceof Error ? error.name : "UnknownError", retrying: true, turnId, checkpointId: entry.view.root.split("/").at(-1)!, durationMs: performance.now() - started, attempt: entry.attempt, outcome: "retry", cause: String(error).slice(0, 2000) }); } catch { /* Keep the checkpoint for retry. */ }
    }).finally(() => { entry.work = undefined; changed(); retryLater(); });
    const work = entry.work; attempts.add(work);
    void work.finally(() => attempts.delete(work)).catch(() => {});
    return work;
  }
  async function drain(): Promise<void> {
    try {
      for (const [id, entry] of [...pending]) {
        if (pending.get(id) !== entry) continue;
        await (entry.work ?? start(id, entry));
        if (entry.error) throw entry.error;
      }
    } finally { await Promise.all([...attempts]); }
  }
  function waitForChange(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const wake = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { waiters.delete(wake); reject(signal!.reason); };
      waiters.add(wake); signal?.addEventListener("abort", abort, { once: true });
    });
  }
  return {
    async reserve(signal?: AbortSignal) {
      const retried = new Set<string>();
      while (owners >= STARTUP_RELEASE_BACKLOG) {
        signal?.throwIfAborted();
        const failed = [...pending].find(([id, entry]) => entry.error && !entry.work && !retried.has(id));
        const wake = waitForChange(signal);
        if (failed) { retried.add(failed[0]); void start(...failed); }
        else if (pending.size && [...pending.values()].every(entry => entry.error && !entry.work)) {
          changed(); await wake; throw [...pending.values()][0]!.error;
        }
        await wake;
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
    /** Called only after the manager positively refuses a checkpoint for space. */
    async reclaim(signal?: AbortSignal): Promise<boolean> {
      if (!pending.size) return false;
      const before = completed;
      const attempted = new Set<string>();
      while (completed === before && pending.size) {
        signal?.throwIfAborted();
        const wake = waitForChange(signal);
        const failed = [...pending].find(([id, entry]) => entry.error && !entry.work && !attempted.has(id));
        if (failed) { attempted.add(failed[0]); void start(...failed); }
        else if ([...pending.values()].every(entry => entry.error && !entry.work)) { changed(); await wake; return false; }
        await wake;
      }
      return completed > before;
    },
    completed: () => completed,
    pending: () => pending.size,
    drain,
    // A failed cleanup alone never stops an already running turn. The native
    // manager still charges its retained extents and adjudicates new space.
    async settled() { await Promise.all([...attempts]); },
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
