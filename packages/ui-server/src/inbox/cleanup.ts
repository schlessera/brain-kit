import type { Database } from "bun:sqlite";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxStore } from "./store.js";
import { failInboxWork } from "./actions.js";
import { safeResolve } from "../files/walker.js";
import { assertInboxRecoveryReady } from "./recovery-gate.js";
import { inboxThreadAwaitingSettlement, reapInboxThreadLifetimes } from "./lifetime.js";

/** Recoverable compensation, never called from a SQLite transaction. Each
 * directory removal is idempotent; its durable lease is acknowledged afterwards. */
export function createInboxCleanup(db: Database, brainRoot: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now, store = createInboxStore(db, { now });
  let active: Promise<number> | null = null, closed = false;
  function claim(id: string): InboxQueueItem | null {
    return db.transaction(() => {
      assertInboxRecoveryReady(db);
      let item = store.getItem(id);
      if (!item || item.queue !== "queue" || item.type !== "cleanup_pending") return null;
      if (item.status === "claimed" && item.leaseUntil! <= now()) {
        failInboxWork(db, item.id, item.version, now());
        item = store.getItem(id)!;
      }
      if (item.queue !== "queue" || item.status !== "ready" || item.attempts >= item.maxAttempts || (item.waitUntil ?? 0) > now()) return null;
      if (inboxThreadAwaitingSettlement(db, item.threadId)) return null;
      // Re-raising a decision before compensation begins must protect the
      // retained staging. Admission and this check share SQLite's write lock.
      if (db.query(`SELECT 1 FROM inbox_items WHERE thread_id = ? AND deleted_at IS NULL AND
        ((queue = 'queue' AND type != 'cleanup_pending' AND status IN ('scheduled','ready','claimed','blocked','failed')) OR
         (queue = 'actions' AND type != 'fyi' AND status IN ('pending','snoozed'))) LIMIT 1`).get(item.threadId)) return null;
      store.commit([{ kind: "transition", itemId: id, expectedVersion: item.version, to: "claimed", leaseUntil: now() + 60_000 }]);
      return store.getItem(id) as InboxQueueItem;
    }).immediate();
  }
  async function remove(stagingId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(stagingId)) throw new Error("Invalid cleanup staging id");
    const root = await safeResolve(SHARE_STAGING_DIR, brainRoot);
    const expected = join(await realpath(brainRoot), SHARE_STAGING_DIR);
    try {
      if (await realpath(root) !== expected) throw new Error("Cleanup staging root must not traverse a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A final entry symlink is unlinked by rm, never followed. Parent symlinks
    // are refused above; IDs come only from the server's intake journal.
    for (const name of [stagingId, `.${stagingId}.partial`])
      await rm(join(root, name), { recursive: true, force: true });
  }
  async function reconcile(): Promise<number> {
    const rows = db.query("SELECT id FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND type = 'cleanup_pending' AND status IN ('ready','claimed') ORDER BY id")
      .all() as { id: string }[];
    let cleaned = 0;
    for (const { id } of rows) {
      if (closed) break;
      const item = claim(id);
      if (!item || item.type !== "cleanup_pending") continue;
      try {
        await remove(item.payload.stagingId);
        reapInboxThreadLifetimes(db, item.threadId);
        // A process killed here leaves a claimed row; restart safely repeats
        // rm, which succeeds even when both directories are already absent.
        store.commit([{ kind: "transition", itemId: id, expectedVersion: item.version, to: "done" }]);
        cleaned++;
      } catch {
        const current = store.getItem(id);
        if (current?.queue === "queue" && current.status === "claimed" && current.version === item.version)
          failInboxWork(db, id, item.version, now());
      }
    }
    return cleaned;
  }
  return {
    sweep(): Promise<number> {
      if (closed) return Promise.resolve(0);
      if (active) return active;
      active = reconcile().finally(() => { active = null; });
      return active;
    },
    async close() { closed = true; await active; },
  };
}
