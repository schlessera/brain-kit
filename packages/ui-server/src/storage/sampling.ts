import type { Database } from "bun:sqlite";
import type { PushSender } from "../activity/push-sender.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import type { StorageCoordinator } from "./coordinator.js";
import type { StorageHistory } from "./history-store.js";
import type { StorageNotifier } from "./notify.js";
import type { SharedStorageScan } from "./shared-scan.js";
import { bucket } from "./history-model.js";
/** Background work starts at the next UTC six-hour boundary, never at boot or on a read. */
export function createStorageSampling(db: Database, storage: StorageCoordinator, history: StorageHistory, shared: SharedStorageScan, notices: StorageNotifier, sender: Pick<PushSender, "deliverStorage">, bootAt = Date.now()) {
  let lastBucket = bucket(0, bootAt), lastClock = bootAt, lastCleanup = bootAt;
  let delivering: Promise<unknown> | null = null, cleaning: Promise<unknown> | null = null;
  let flushing: Promise<unknown> | null = null, sweeping: Promise<unknown> | null = null;
  const controller = new AbortController();
  // Keep the first four distinct original causes, not an app-lifetime error log.
  // Count failed operations (not distinct identities); saturation bounds the counter.
  const failures = new Set<unknown>();
  let failureCount = 0;
  function retain(error: unknown): void {
    failureCount = Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1);
    if (failures.size < 4) failures.add(error);
  }
  let closed: Promise<void> | undefined;
  function tick(now = Date.now()) {
    if (controller.signal.aborted) return;
    // Reversed clocks cannot re-enter a past bucket or renew stale evidence.
    if (now < lastClock) return;
    lastClock = now;
    if (!flushing) try {
      const result = history.flush();
      if (result instanceof Promise) flushing = result.catch(retain).finally(() => { flushing = null; });
    } catch (error) { retain(error); /* Existing evidence remains readable. */ }
    const current = bucket(0, now);
    if (current > lastBucket) {
      try {
        const candidates = db.query("SELECT id FROM principals WHERE kind IN ('owner', 'ambient') AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100").all(now) as Array<{ id: string }>;
        const owner = candidates.find(({ id }) => { const principal = resolvePrincipal(db, id); return principal && isUsablePrincipal(principal, now); });
        if (owner) { lastBucket = current; const result = storage.start(owner.id, true, 0); if (result instanceof Promise) void result.catch(() => history.failure(now)); }
      } catch { lastBucket = current; history.failure(now); }
    }
    if (!sweeping) try {
      const result = notices.sweep(now);
      if (result instanceof Promise) sweeping = result.catch(retain).finally(() => { sweeping = null; });
    } catch (error) { retain(error); /* A failed receipt write cannot authorize transport. */ }
    if (!delivering) try {
      delivering = sender.deliverStorage(notices, undefined, controller.signal).catch(retain).finally(() => { delivering = null; });
    } catch (error) { retain(error); }
    if (!cleaning && now - lastCleanup >= 60_000) {
      lastCleanup = now;
      try { cleaning = shared.cleanupCache().catch(retain).finally(() => { cleaning = null; }); }
      catch (error) { retain(error); }
    }
  }
  const timer = setInterval(tick, 20_000); timer.unref();
  return {
    tick,
    close() {
      if (closed) return closed;
      controller.abort(); clearInterval(timer);
      return closed = (async () => {
        await Promise.allSettled([delivering, cleaning, flushing, sweeping]);
        // Retry the final flush even after an earlier write/cleanup failed.
        try { await history.flush(); } catch (error) { retain(error); }
        const errors = [...failures];
        if (failureCount === 1) throw errors[0];
        if (failureCount) throw new AggregateError(errors,
          `Storage sampling shutdown failed: ${failureCount === Number.MAX_SAFE_INTEGER ? "at least " : ""}${failureCount} failed operations; ${errors.length} error representatives retained`,
          { cause: errors[0] });
      })();
    },
  };
}
