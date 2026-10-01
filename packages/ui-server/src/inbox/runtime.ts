import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxStore } from "./store.js";
import { createInboxBudget, reconcileInboxBudgets, type InboxBudgetOperation } from "./budget.js";
import { failInboxWork, sweepInboxLifecycle } from "./actions.js";
import { createInboxCleanup } from "./cleanup.js";
import { assertInboxRecoveryReady } from "./recovery-gate.js";

export const INBOX_TICK_MS = 60_000;
export const INBOX_STALE_MS = 180_000;
const LEASE_MS = 10 * 60_000;
const HEARTBEAT_NAME = "inbox-drain";

type Timer = ReturnType<typeof setInterval>;
interface Timers {
  setInterval(callback: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}
interface DrainResult {
  busy: boolean;
  claimed: number;
  recovered: number;
  dispatchEnabled: boolean;
  failed?: boolean;
}

/** Concrete internal lifecycle; createApp deliberately supplies no dispatcher yet. */
export function createInboxRuntime(db: Database, deps: {
  log: Logger;
  now?: () => number;
  brainRoot?: string;
  timers?: Timers;
  /** Internal fixture/engine wiring, never a package extension interface. */
  dispatch?: (item: InboxQueueItem, signal: AbortSignal) => Promise<void>;
  budget?: Omit<Parameters<typeof createInboxBudget>[1], "now">;
  /** Server-selected bounds/billing for each concrete model-bearing operation. */
  operation?: (item: InboxQueueItem) => InboxBudgetOperation;
}) {
  assertInboxRecoveryReady(db);
  const now = deps.now ?? Date.now;
  const timers: Timers = deps.timers ?? {
    setInterval: (callback, ms) => setInterval(callback, ms) as Timer,
    clearInterval: (timer) => clearInterval(timer),
  };
  const store = createInboxStore(db, { now });
  const cleanup = deps.brainRoot ? createInboxCleanup(db, deps.brainRoot, { now }) : undefined;
  const budget = deps.budget ? createInboxBudget(db, { ...deps.budget, now }) : undefined;
  const dispatchEnabled = Boolean(deps.dispatch && budget && deps.operation);
  const controller = new AbortController();
  let timer: Timer | undefined;
  let closed = false;
  let active: Promise<DrainResult> | null = null;
  const result = (): DrainResult => ({
    busy: false, claimed: 0, recovered: 0, dispatchEnabled,
  });

  function recoverLeases(): number {
    return db.transaction(() => {
      reconcileInboxBudgets(db, now());
      const rows = db.query(
        "SELECT id FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND status = 'claimed' AND lease_until <= ? ORDER BY id"
      ).all(now()) as { id: string }[];
      for (const { id } of rows) failInboxWork(db, id, store.getItem(id)!.version, now());
      return rows.length;
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

  function eligible(item: InboxQueueItem, at: number): boolean {
    return item.type !== "cleanup_pending" && item.status === "ready" && item.expiresAt > at &&
      (item.waitUntil === undefined || item.waitUntil <= at) && item.attempts < item.maxAttempts;
  }

  function claimNext(seen: Set<string>): InboxQueueItem | null {
    return db.transaction(() => {
      const at = now();
      for (const { item } of store.orderedItems()) {
        if (item.queue !== "queue" || !eligible(item, at) || seen.has(item.id)) continue;
        seen.add(item.id);
        const admitted = budget!.claim(item.id, deps.operation!(item), at + LEASE_MS);
        if (admitted) return admitted.items[0]!;
      }
      return null;
    }).immediate();
  }

  async function drain(): Promise<DrainResult> {
    const pass = result();
    if (closed) return pass;
    try {
      assertInboxRecoveryReady(db);
      await ready;
      pass.recovered = recoverLeases();
      sweepInboxLifecycle(db, now());
      await cleanup?.sweep();
      heartbeat();
      const at = now();
      const { count } = db.query(
        "SELECT COUNT(*) AS count FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND type != 'cleanup_pending' AND status = 'ready' AND expires_at > ? AND (wait_until IS NULL OR wait_until <= ?) AND attempts < max_attempts"
      ).get(at, at) as { count: number };
      // Empty ticks never construct a recorder or call inference. An absent
      // dispatcher also leaves ready work untouched until the full-v1 gates.
      if (count === 0 || !dispatchEnabled) return pass;
      const seen = new Set<string>();
      // Bound each pass by its initial ready set; new arrivals wait for a tick.
      for (let i = 0; i < count && !closed; i++) {
        const item = claimNext(seen);
        if (!item) break;
        seen.add(item.id);
        pass.claimed++;
        // The immediate claim transaction has ended before any asynchronous
        // work. The engine owns completion/backoff/checkpoints and accounting.
        try { await deps.dispatch!(item, controller.signal); }
        catch (error) {
          const current = store.getItem(item.id);
          if (current?.queue === "queue" && current.status === "claimed" && current.version === item.version)
            failInboxWork(db, item.id, item.version, now());
          reconcileInboxBudgets(db, now());
          throw error;
        }
      }
    } catch {
      pass.failed = true;
      // Explicit failures schedule backoff; killed workers retain recoverable
      // leases. Do not log untrusted text or arbitrary dispatcher exceptions.
      deps.log.emit({ severityText: "WARN", body: "inbox drain failed; retry and cleanup journals remain recoverable" });
    }
    return pass;
  }

  function tick(): Promise<DrainResult> {
    if (closed) return Promise.resolve(result());
    if (active) return Promise.resolve({ ...result(), busy: true });
    active = Promise.resolve().then(drain).finally(() => { active = null; });
    return active;
  }

  function arm(): void {
    if (timer !== undefined) timers.clearInterval(timer);
    timer = timers.setInterval(() => { void tick(); }, INBOX_TICK_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }

  // Boot recovery is deterministic and creates no Activity/model work.
  recoverLeases();
  sweepInboxLifecycle(db, now());
  heartbeat();
  const ready = cleanup?.sweep() ?? Promise.resolve(0);
  void ready.catch(() => deps.log.emit({ severityText: "WARN", body: "inbox cleanup recovery failed; journal retained" }));
  arm();
  return {
    ready,
    tick,
    async poke() {
      if (closed) return { ...result(), rearmed: false, closed: true };
      const row = db.query("SELECT tick_at FROM inbox_scheduler_heartbeats WHERE name = ?")
        .get(HEARTBEAT_NAME) as { tick_at: number } | null;
      const rearmed = !row || now() - row.tick_at >= INBOX_STALE_MS;
      if (rearmed) arm();
      return { ...await tick(), rearmed, closed: false };
    },
    async close(): Promise<void> {
      closed = true;
      controller.abort();
      if (timer !== undefined) timers.clearInterval(timer);
      await active;
      await ready.catch(() => {});
      await cleanup?.close();
    },
  };
}
