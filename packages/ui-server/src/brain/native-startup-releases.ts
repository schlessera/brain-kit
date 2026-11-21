/** Bounded owner of startup checkpoints no admission consumer needs (#4304). */
import type { WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";

export const STARTUP_RELEASE_BACKLOG = 2;
/** A view is admitted before its writer gate; retained consumers leave this pool. */
export const STARTUP_QUALIFICATION_BACKLOG = 2;
export interface StartupReleaseResult {
  turnId: string; checkpointId: string; durationMs: number; attempt: number;
  outcome: "released" | "retry"; at: number; errorClass?: string; retrying?: boolean; cause?: string;
}
type ReleaseEntry = { turnId: string; view: WorkerStartupView; attempt: number; ordinary: boolean; slotOwned: boolean; work?: Promise<void>; error?: unknown };
export function createNativeStartupReleases(report: (result: StartupReleaseResult) => unknown = () => {}, retryMs = 30_000) {
  let owners = 0, failedRunning = 0, qualifications = 0, completed = 0, closing = false;
  const waiters = new Set<() => void>();
  const attempts = new Set<Promise<void>>();
  const pending = new Map<string, ReleaseEntry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => { for (const wake of waiters) wake(); waiters.clear(); };
  function retryLater(): void {
    if (closing || timer || ![...pending.values()].some(entry => entry.error)) return;
    timer = setTimeout(() => { timer = undefined; for (const [id, entry] of pending) if (entry.error) start(id, entry); retryLater(); }, retryMs);
    timer.unref?.();
  }
  function failure(entry: ReleaseEntry, durationMs: number, error: unknown): Promise<void> {
    const result: StartupReleaseResult = { at: Date.now(), errorClass: error instanceof Error ? error.name : "UnknownError", retrying: true, turnId: entry.turnId,
      checkpointId: entry.view.root.split("/").at(-1)!, durationMs, attempt: entry.attempt, outcome: "retry", cause: String(error).slice(0, 2000) };
    return Promise.resolve().then(async () => { try { await report(result); } catch { /* The owner retains the failed view. */ } });
  }
  function track(work: Promise<void>): void {
    attempts.add(work); void work.finally(() => attempts.delete(work)).catch(() => {});
  }
  function start(key: string, entry: ReleaseEntry): Promise<void> {
    if (entry.work) return entry.work;
    if (!entry.slotOwned) {
      // Failed excluded consumers have their own bounded retry execution;
      // two unrelated ordinary release owners cannot prevent their recovery.
      if (failedRunning >= STARTUP_RELEASE_BACKLOG) return Promise.resolve();
      failedRunning++; entry.slotOwned = true;
    }
    const started = performance.now(); entry.attempt++; entry.error = undefined;
    entry.work = Promise.resolve().then(() => entry.view.cleanup()).then(async () => {
      pending.delete(key); if (entry.ordinary) owners--; else failedRunning--; entry.slotOwned = false; completed++; changed();
      try { await report({ at: Date.now(), turnId: entry.turnId, checkpointId: entry.view.root.split("/").at(-1)!, durationMs: performance.now() - started, attempt: entry.attempt, outcome: "released" }); } catch { /* Diagnostics never own the release. */ }
    }, async error => {
      entry.error = error;
      // Excluded consumers already owned their view. A failed retry keeps
      // that owner without consuming an ordinary admission release slot.
      if (!entry.ordinary) { failedRunning--; entry.slotOwned = false; changed(); }
      await failure(entry, performance.now() - started, error);
    }).finally(() => { entry.work = undefined; changed(); retryLater(); });
    const work = entry.work; track(work);
    return work;
  }
  async function drain(): Promise<void> {
    try {
      for (const [id, entry] of [...pending]) {
        if (pending.get(id) !== entry) continue;
        while (!entry.slotOwned && failedRunning >= STARTUP_RELEASE_BACKLOG) await waitForChange();
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
  function tryReserve(signal?: AbortSignal, disposal = false) {
    signal?.throwIfAborted();
    if (closing && !disposal) throw new Error("Startup checkpoint releases are closing");
    if (owners >= STARTUP_RELEASE_BACKLOG) return undefined;
    owners++;
    let owned = true;
    return {
      handoff(turnId: string, view: WorkerStartupView) {
        if (!owned || pending.has(view.root)) throw new Error("Startup checkpoint already has a release owner");
        const entry: ReleaseEntry = { turnId, view, attempt: 0, ordinary: true, slotOwned: true }; pending.set(view.root, entry); owned = false;
        void start(view.root, entry);
      },
      release() { if (owned) { owned = false; owners--; changed(); } },
    };
  }
  return {
    /** A failed excluded cleanup transfers ownership immediately, without a slot wait. */
    adoptFailed(turnId: string, view: WorkerStartupView, error: unknown, durationMs = 0): void {
      if (pending.has(view.root)) return;
      const entry: ReleaseEntry = { turnId, view, attempt: 1, ordinary: false, slotOwned: false, error };
      pending.set(view.root, entry); track(failure(entry, durationMs, error));
      changed(); retryLater();
    },
    tryReserve,
    async qualify(signal?: AbortSignal) {
      while (qualifications >= STARTUP_QUALIFICATION_BACKLOG) await waitForChange(signal);
      signal?.throwIfAborted();
      if (closing) throw new Error("Startup qualifications are closing");
      qualifications++;
      let owned = true;
      return { release() { if (owned) { owned = false; qualifications--; changed(); } } };
    },
    async reserve(signal?: AbortSignal, disposal = false) {
      const retried = new Set<string>();
      while (owners >= STARTUP_RELEASE_BACKLOG) {
        signal?.throwIfAborted();
        const failed = [...pending].find(([id, entry]) => entry.error && !entry.work && !retried.has(id));
        const wake = waitForChange(signal);
        if (failed) { retried.add(failed[0]); void start(...failed); }
        await wake;
      }
      return tryReserve(signal, disposal)!;
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
