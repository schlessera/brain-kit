import type { Database } from "bun:sqlite";
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxStore } from "./store.js";
import { inboxLifecycleWrites } from "./lifecycle-writes.js";
import { removeStagedArrival } from "../share/staging-fs.js";
import { assertInboxRecoveryReady } from "./recovery-gate.js";
import { reapInboxThreadLifetimes } from "./lifetime.js";

interface CleanupItemOutcome { id: string; state: "running" | "cleaned" | "failed"; reason: string | null }
export interface CleanupReport { cleaned: number; failed: number; deferred: number; cancelled: boolean; truncated: boolean; items: CleanupItemOutcome[] }
export interface CleanupRequest { signal?: AbortSignal; assertAuthorized?: () => void; onItem?: (item: CleanupItemOutcome) => void | Promise<void> }

/** Recoverable compensation, never called from a SQLite transaction. Each
 * directory removal is idempotent; its durable lease is acknowledged afterwards. */
export function createInboxCleanup(db: Database, brainRoot: string, options: { now?: () => number;
  /** Internal crash fixture between removal and acknowledgement; never wired by createApp. */
  afterRemove?: () => Promise<void> } = {}) {
  const now = options.now ?? Date.now, store = createInboxStore(db, { now });
  const write = inboxLifecycleWrites(db);
  let active: Promise<CleanupReport> | null = null, closed = false;
  async function remove(stagingId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(stagingId)) throw new Error("Invalid cleanup staging id");
    // A final entry symlink is unlinked, never followed; a linked or changing
    // staging directory refuses, through descriptors rather than a pathname
    // check (#2907). IDs come only from the server's intake journal.
    removeStagedArrival(brainRoot, stagingId);
  }
  async function reconcile(request?: CleanupRequest): Promise<CleanupReport> {
    request?.signal?.throwIfAborted(); request?.assertAuthorized?.(); assertInboxRecoveryReady(db);
    const rows = db.query("SELECT id FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND type = 'cleanup_pending' AND status IN ('ready','claimed') ORDER BY id LIMIT ?")
      .all(request ? 200 : -1) as { id: string }[];
    const report: CleanupReport = { cleaned: 0, failed: 0, deferred: 0, cancelled: false, truncated: request ? rows.length === 200 : false, items: [] };
    for (const { id } of rows) {
      if (closed || request?.signal?.aborted) { report.cancelled = true; break; }
      request?.assertAuthorized?.();
      const item = await write<InboxQueueItem | null>("claimCleanup", id, now());
      if (!item || item.type !== "cleanup_pending") { report.deferred++; continue; }
      request?.assertAuthorized?.(); request?.signal?.throwIfAborted();
      await request?.onItem?.({ id, state: "running", reason: null });
      let outcome: CleanupItemOutcome;
      try {
        await remove(item.payload.stagingId);
        await options.afterRemove?.();
        reapInboxThreadLifetimes(db, item.threadId);
        // A process killed here leaves a claimed row; restart safely repeats
        // rm, which succeeds even when both directories are already absent.
        await write("commit", [{ kind: "transition", itemId: id, expectedVersion: item.version, to: "done" }], now());
        report.cleaned++;
        outcome = { id, state: "cleaned", reason: null };
      } catch {
        const current = store.getItem(id);
        if (current?.queue === "queue" && current.status === "claimed" && current.version === item.version)
          await write("fail", id, item.version, now());
        report.failed++;
        outcome = { id, state: "failed", reason: "cleanup_incomplete" };
      }
      if (request) report.items.push(outcome); await request?.onItem?.(outcome);
    }
    return report;
  }
  function run(request?: CleanupRequest): Promise<CleanupReport> {
    if (active) return request ? active.then(() => run(request)) : active;
    if (closed) return Promise.resolve({ cleaned: 0, failed: 0, deferred: 0, cancelled: true, truncated: false, items: [] });
    active = reconcile(request).finally(() => { active = null; });
    return active;
  }
  return {
    sweep: () => run().then(result => result.cleaned),
    run: (request: CleanupRequest) => run(request),
    async close() { closed = true; await active; },
  };
}
