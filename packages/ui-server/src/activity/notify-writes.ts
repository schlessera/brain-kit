/**
 * The Activity notifier and push delivery bookkeeping off the event loop
 * (#2850). The hosted server's notifier tick (intent detection under its
 * cursor, the stuck-run watchdog) and the writes push delivery makes
 * (delivery status, a subscription's `last_used_at`, a gone subscription)
 * commit on the `ui.db` write worker at `synchronous=FULL`. The tick runs the
 * same notifier against the write connection, with who is watching taken
 * where the tick was submitted; its log records come back to the app's log.
 * Reads (the inbox, the pending queue) stay on the app connection.
 */
import type { Database } from "bun:sqlite";
import type { LogRecord, Logger } from "@opentelemetry/api-logs";

import { procedureCaller, type SqliteWriter, type WriteProcedures } from "../db/write-worker.js";
import { createActivityNotifier, type ActivityNotifier } from "./notify.js";
import { createActivityStore } from "./store.js";

export const url = import.meta.url;

/** Who was watching when a tick was submitted: `ActivityStream.isWatched`, as data. */
export interface WatchedScopes { index: boolean; runs: string[]; sessions: string[] }

export function watchedBy(scopes: WatchedScopes) {
  return (scope: { runId?: string; sessionId?: string }) => scopes.index
    || (scope.runId !== undefined && scopes.runs.includes(scope.runId))
    || (scope.sessionId !== undefined && scopes.sessions.includes(scope.sessionId));
}

export function setup(db: Database): WriteProcedures {
  let watched: WatchedScopes = { index: false, runs: [], sessions: [] };
  const records: LogRecord[] = [];
  // Reads only: the notifier joins terminal changes and stuck runs on this connection.
  const notifier = createActivityNotifier({ db, store: createActivityStore(db), isWatched: scope => watchedBy(watched)(scope),
    log: { emit: (record: LogRecord) => { records.push(record); } } as unknown as Logger });
  return {
    tick(now: number, scopes: WatchedScopes) {
      watched = scopes;
      try { notifier.tick(now); } finally { watched = { index: false, runs: [], sessions: [] }; }
      return records.splice(0);
    },
    markDelivered: (id: number, status: "sent" | "send_failed") => notifier.markDelivered(id, status),
    acknowledge: (id: number) => notifier.acknowledge(id),
    acknowledgeAll: () => notifier.acknowledgeAll(),
    pruneAcknowledged: (olderThanMs: number) => notifier.pruneAcknowledged(olderThanMs),
    touchSubscription(endpoint: string, at: number, principalId?: string) {
      if (principalId === undefined) db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?").run(at, endpoint);
      else db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ? AND principal_id = ?").run(at, endpoint, principalId);
    },
    dropSubscription(endpoint: string) { db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint); },
  };
}

/** Push delivery's subscription bookkeeping; each settles once committed. */
export interface PushWrites {
  touch(endpoint: string, at: number, principalId?: string): Promise<void>;
  drop(endpoint: string): Promise<void>;
}

/**
 * The hosted server's notifier: reads on `db`, every write on `writer`. A
 * tick that is still committing is not submitted again; the next one runs
 * after it.
 */
export function createOffloopNotifier(db: Database, writer: SqliteWriter, options: { watched: () => WatchedScopes; log?: Logger }):
  { notifier: ActivityNotifier; push: PushWrites } {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  const reads = createActivityNotifier({ db, store: createActivityStore(db), isWatched: () => false, log: options.log });
  let ticking: Promise<void> | undefined;
  const failed = (error: unknown) => options.log?.emit({ severityText: "WARN", body: "notifier tick failed",
    attributes: { error: error instanceof Error ? error.message : String(error) } });
  const notifier: ActivityNotifier = {
    tick(now) {
      if (ticking) return ticking;
      ticking = call<LogRecord[]>("tick", now ?? Date.now(), options.watched())
        .then(records => { for (const record of records) options.log?.emit(record); }, failed)
        .finally(() => { ticking = undefined; });
      return ticking;
    },
    inbox: limit => reads.inbox(limit),
    pending: limit => reads.pending(limit),
    markDelivered: (id, status) => call<void>("markDelivered", id, status),
    acknowledge: id => call<boolean>("acknowledge", id),
    acknowledgeAll: () => call<number>("acknowledgeAll"),
    pruneAcknowledged: olderThanMs => call<number>("pruneAcknowledged", olderThanMs),
  };
  const push: PushWrites = {
    touch: (endpoint, at, principalId) => call<void>("touchSubscription", endpoint, at, principalId),
    drop: endpoint => call<void>("dropSubscription", endpoint),
  };
  return { notifier, push };
}
