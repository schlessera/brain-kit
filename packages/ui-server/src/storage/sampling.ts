import type { Database } from "bun:sqlite";
import type { PushSender } from "../activity/push-sender.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import type { StorageCoordinator } from "./coordinator.js";
import type { StorageHistory } from "./history-store.js";
import type { StorageNotifier } from "./notify.js";
import type { SharedStorageScan } from "./shared-scan.js";
import { bucket } from "./history-model.js";
/** Background work starts at the next UTC six-hour boundary, never at boot or on a read. */
export function createStorageSampling(db: Database, storage: StorageCoordinator, history: StorageHistory, shared: SharedStorageScan, notices: StorageNotifier, sender: PushSender, bootAt = Date.now()) {
  let lastBucket = bucket(0, bootAt), lastClock = bootAt, lastCleanup = bootAt;
  let delivering: Promise<unknown> | null = null, cleaning: Promise<unknown> | null = null;
  const controller = new AbortController();
  function tick(now = Date.now()) {
    if (controller.signal.aborted) return;
    // Reversed clocks cannot re-enter a past bucket or renew stale evidence.
    if (now < lastClock) return;
    lastClock = now;
    try { history.flush(); } catch { /* Existing evidence remains readable. */ }
    const current = bucket(0, now);
    if (current > lastBucket) {
      try {
        const candidates = db.query("SELECT id FROM principals WHERE kind IN ('owner', 'ambient') AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100").all(now) as Array<{ id: string }>;
        const owner = candidates.find(({ id }) => { const principal = resolvePrincipal(db, id); return principal && isUsablePrincipal(principal, now); });
        if (owner) { lastBucket = current; storage.start(owner.id, true, 0); }
      } catch { lastBucket = current; history.failure(now); }
    }
    try { notices.sweep(now); } catch { /* A failed receipt write cannot authorize transport. */ }
    if (!delivering) delivering = sender.deliverStorage(notices, undefined, controller.signal).catch(() => {}).finally(() => { delivering = null; });
    if (!cleaning && now - lastCleanup >= 60_000) {
      lastCleanup = now;
      cleaning = shared.cleanupCache().catch(() => {}).finally(() => { cleaning = null; });
    }
  }
  const timer = setInterval(tick, 20_000); timer.unref();
  return {
    tick,
    async close() { controller.abort(); clearInterval(timer); await Promise.allSettled([delivering, cleaning]); history.flush(); },
  };
}
