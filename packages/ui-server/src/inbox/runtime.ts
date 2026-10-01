import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxStore } from "./store.js";

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
  timers?: Timers;
  /** Internal fixture/engine wiring, never a package extension interface. */
  dispatch?: (item: InboxQueueItem, signal: AbortSignal) => Promise<void>;
}) {
  const now = deps.now ?? Date.now;
  const timers: Timers = deps.timers ?? {
    setInterval: (callback, ms) => setInterval(callback, ms) as Timer,
    clearInterval: (timer) => clearInterval(timer),
  };
  const store = createInboxStore(db, { now });
  const controller = new AbortController();
  let timer: Timer | undefined;
  let closed = false;
  let active: Promise<DrainResult> | null = null;
  const result = (): DrainResult => ({
    busy: false, claimed: 0, recovered: 0, dispatchEnabled: Boolean(deps.dispatch),
  });

  function recoverLeases(): number {
    return db.transaction(() => {
      const rows = db.query(
        "SELECT id FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND status = 'claimed' AND lease_until <= ? ORDER BY id"
      ).all(now()) as { id: string }[];
      store.commit(rows.map(({ id }) => ({
        kind: "transition" as const, itemId: id,
        expectedVersion: store.getItem(id)!.version, to: "ready" as const,
      })));
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
    return item.status === "ready" && item.expiresAt > at &&
      (item.waitUntil === undefined || item.waitUntil <= at) && item.attempts < item.maxAttempts;
  }

  function claimNext(seen: Set<string>): InboxQueueItem | null {
    return db.transaction(() => {
      const at = now();
      const candidate = store.orderedItems().find(({ item }) =>
        item.queue === "queue" && eligible(item, at) && !seen.has(item.id)
      )?.item;
      if (!candidate || candidate.queue !== "queue") return null;
      store.commit([{
        kind: "transition", itemId: candidate.id, expectedVersion: candidate.version,
        to: "claimed", leaseUntil: at + LEASE_MS,
      }]);
      return store.getItem(candidate.id) as InboxQueueItem;
    }).immediate();
  }

  async function drain(): Promise<DrainResult> {
    const pass = result();
    if (closed) return pass;
    try {
      pass.recovered = recoverLeases();
      heartbeat();
      const at = now();
      const { count } = db.query(
        "SELECT COUNT(*) AS count FROM inbox_items WHERE deleted_at IS NULL AND queue = 'queue' AND status = 'ready' AND expires_at > ? AND (wait_until IS NULL OR wait_until <= ?) AND attempts < max_attempts"
      ).get(at, at) as { count: number };
      // Empty ticks never construct a recorder or call inference. An absent
      // dispatcher also leaves ready work untouched until the full-v1 gates.
      if (count === 0 || !deps.dispatch) return pass;
      const seen = new Set<string>();
      // Bound each pass by its initial ready set; new arrivals wait for a tick.
      for (let i = 0; i < count && !closed; i++) {
        const item = claimNext(seen);
        if (!item) break;
        seen.add(item.id);
        pass.claimed++;
        // The immediate claim transaction has ended before any asynchronous
        // work. The engine owns completion/backoff/checkpoints and accounting.
        await deps.dispatch(item, controller.signal);
      }
    } catch {
      pass.failed = true;
      // A failed dispatch keeps its committed lease for recovery. Do not log
      // untrusted item text or arbitrary dispatcher exceptions.
      deps.log.emit({ severityText: "WARN", body: "inbox drain failed; committed leases remain recoverable" });
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
  heartbeat();
  arm();
  return {
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
    },
  };
}
