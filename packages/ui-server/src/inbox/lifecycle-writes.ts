/** Recovery, store mutations and cleanup commits on the hosted write queue. */
import type { Database } from "bun:sqlite";
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { procedureCaller, type WriteProcedures } from "../db/write-worker.js";
import { inboxWriter } from "./write-runtime.js";
import { createInboxStore, type InboxMutation } from "./store.js";
import { reconcileInboxBudgets } from "./budget.js";
import { failInboxWork, sweepInboxLifecycle } from "./actions.js";
import { assertInboxRecoveryReady } from "./recovery-gate.js";
import { inboxRunIsLive, inboxThreadAwaitingSettlement } from "./lifetime.js";

export const url = import.meta.url;
export function setup(db: Database): WriteProcedures {
  let at = 0;
  const now = () => at, store = createInboxStore(db, { now });
  const HEARTBEAT_NAME = "inbox-drain";
  function recoverLeases(): number {
    return db.transaction(() => {
      reconcileInboxBudgets(db, now());
      const rows = db.query(
        "SELECT id, run_id FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND status = 'claimed' AND lease_until <= ? ORDER BY id"
      ).all(now()) as { id: string; run_id: string | null }[];
      let recovered = 0;
      for (const { id, run_id } of rows) {
        if (run_id && inboxRunIsLive(db, run_id)) continue;
        failInboxWork(db, id, store.getItem(id)!.version, now());
        recovered++;
      }
      return recovered;
    }).immediate();
  }

  function heartbeat(): void {
    db.transaction(() => {
      const { cursor } = db.query(
        "SELECT COALESCE(MAX(change_id), 0) AS cursor FROM inbox_changes"
      ).get() as { cursor: number };
      store.commit([{ kind: "heartbeat", name: HEARTBEAT_NAME, tickAt: now(), changeCursor: cursor }]);
    }).immediate();
  }

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
      if (db.query("SELECT 1 FROM inbox_interactive_shares s JOIN inbox_items i ON i.id = s.item_id WHERE i.thread_id = ? AND s.completion_json IS NULL").get(item.threadId)) return null;
      // Re-raising a decision before compensation begins must protect the
      // retained staging. Admission and this check share SQLite's write lock.
      if (db.query(`SELECT 1 FROM inbox_items WHERE thread_id = ? AND deleted_at IS NULL AND
        ((queue = 'queue' AND type != 'cleanup_pending' AND status IN ('scheduled','ready','claimed','blocked','failed')) OR
         (queue = 'actions' AND type != 'fyi' AND status IN ('pending','snoozed'))) LIMIT 1`).get(item.threadId)) return null;
      store.commit([{ kind: "transition", itemId: id, expectedVersion: item.version, to: "claimed", leaseUntil: now() + 60_000 }]);
      return store.getItem(id) as InboxQueueItem;
    }).immediate();
  }
  return {
    // Preserve the original boot order, including stopping at its first failure.
    startup(time: number) { at = time; recoverLeases(); sweepInboxLifecycle(db, time); heartbeat(); },
    recover(time: number) { at = time; return recoverLeases(); },
    sweep(time: number) { return sweepInboxLifecycle(db, time); },
    heartbeat(time: number) { at = time; return heartbeat(); },
    claimCleanup(id: string, time: number) { at = time; return claim(id); },
    commit(mutations: InboxMutation[], time: number) { at = time; return store.commit(mutations); },
    fail(id: string, version: number, time: number) { return failInboxWork(db, id, version, time); },
  };
}

export function inboxLifecycleWrites(db: Database) {
  return procedureCaller(db, { url, setup }, undefined, inboxWriter(db));
}
