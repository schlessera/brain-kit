/**
 * Activity writes off the event loop (#2814). The write worker runs this
 * module's store on its own connection at `synchronous=FULL`; the hosted
 * server's store keeps reading on the app connection and submits every
 * standalone write there, in call order. Each write keeps its own immediate
 * transaction, so its atomicity and the order of writes are unchanged.
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";

import type { SqliteWriter, WriteProcedures } from "../db/write-worker.js";
import { createModelPricing, pricingCachePath } from "../pricing/model-pricing.js";
import { createActivityStore, MAX_EVENT_PAYLOAD_BYTES, type ActivityStore, type ActivityWriteMethod, type AwaitableActivityStore, type RollupPricing } from "./store.js";

export const url = import.meta.url;

export const ACTIVITY_WRITE_METHODS = ["writeLifecycle", "startSpan", "endSpan", "patchSpan", "appendEvent", "heartbeat",
  "cascadeClose", "sweepOwnOrphans", "sweepStale", "rollupRun", "prune"] as const satisfies readonly ActivityWriteMethod[];

/** The app's pricing configuration; the worker prices rollups from the same cache and snapshot. */
export interface ActivityPricingConfig { brainPath: string; enabled?: boolean; ttlMs?: number }
export interface ActivityWriteOptions { writer: string; pricing?: ActivityPricingConfig }

/**
 * Worker side. Without a pricing configuration the store keeps its own
 * env-derived default, as the cron wrapper's bare store does. With one, the
 * worker reloads the shared on-disk table whenever the app's refresh
 * replaces it, so a rollup prices from the table the app last published.
 */
export function setup(db: Database, options: ActivityWriteOptions): WriteProcedures {
  const { store, pricing } = workerActivity(db, options);
  const procedures: WriteProcedures = {};
  for (const name of ACTIVITY_WRITE_METHODS) {
    procedures[name] = ((...args: unknown[]) => { pricing?.(); return Reflect.apply(store[name] as (...values: unknown[]) => unknown, store, args); }) as WriteProcedures[string];
  }
  return procedures;
}

/**
 * A store on the write connection, as `setup` builds it, for another
 * procedure module whose transaction writes Activity rows too (#2850).
 * `pricing`, present with a pricing configuration, reloads the shared table
 * if the app has replaced it; call it before a write that prices.
 */
export function workerActivity(db: Database, options: ActivityWriteOptions): { store: ActivityStore; pricing?: () => RollupPricing } {
  const config = options.pricing;
  let pricing: RollupPricing | undefined, identity = "";
  const current = (): RollupPricing => {
    const cache = pricingCachePath(config!.brainPath);
    let next = "absent";
    try { const info = statSync(cache); next = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`; } catch { /* The snapshot serves. */ }
    if (!pricing || next !== identity) { pricing = createModelPricing({ ...config!, fetchImpl: (() => Promise.reject(new Error("The write worker never fetches pricing."))) as unknown as typeof fetch }); identity = next; }
    return pricing;
  };
  const store = createActivityStore(db, { writer: options.writer, ...(config ? { pricing: { resolve: (model, route) => current().resolve(model, route) } } : {}) });
  return { store, ...(config ? { pricing: current } : {}) };
}

/**
 * The payload as the store will cap and serialize it, in a form that crosses
 * to the worker: what the store stores is unchanged. A payload over its cap is
 * stored as a slice of its JSON either way, so its JSON is sent instead of a
 * copy of the whole value.
 */
function transferablePayload(payload: unknown, cap?: number): unknown {
  if (typeof payload === "string") return payload;
  const json = JSON.stringify(payload ?? null);
  return json.length > Math.min(cap ?? MAX_EVENT_PAYLOAD_BYTES, MAX_EVENT_PAYLOAD_BYTES) ? json : JSON.parse(json);
}

/**
 * The hosted server's store. Reads run on `db`. A standalone write is
 * submitted to the write worker and resolves after its commit. A write the
 * caller makes inside its own transaction on `db` runs there, synchronously,
 * so it stays atomic with the caller's other rows.
 */
export function createOffloopActivityStore(db: Database, writer: SqliteWriter, options: {
  writer?: string; pricing?: RollupPricing; pricingConfig?: ActivityPricingConfig;
} = {}): AwaitableActivityStore {
  const identity = options.writer ?? `pid:${process.pid}:${Date.now()}`;
  const local: ActivityStore = createActivityStore(db, { writer: identity, ...(options.pricing ? { pricing: options.pricing } : {}) });
  const channel = writer.channel<ActivityWriteOptions>({ url, setup }, { writer: identity, ...(options.pricingConfig ? { pricing: options.pricingConfig } : {}) });
  // Clock defaults are taken when the write is submitted, not when the
  // worker reaches it, as a synchronous write took them.
  const submitted: Partial<Record<(typeof ACTIVITY_WRITE_METHODS)[number], (args: unknown[]) => unknown[]>> = {
    startSpan: ([input]) => [{ ...(input as object), startedAt: (input as { startedAt?: number }).startedAt ?? Date.now() }],
    endSpan: ([spanId, input]) => [spanId, { ...(input as object), endedAt: (input as { endedAt?: number }).endedAt ?? Date.now() }],
    appendEvent: ([spanId, eventType, payload, ts, cap]) => [spanId, eventType, transferablePayload(payload, cap as number | undefined), ts ?? Date.now(), cap],
    heartbeat: ([spanId, at]) => [spanId, at ?? Date.now()],
    sweepStale: ([staleAfterMs, now]) => [staleAfterMs, now ?? Date.now()],
    prune: ([prune]) => [{ ...(prune as object), now: (prune as { now?: number }).now ?? Date.now() }],
  };
  const store = Object.create(local) as AwaitableActivityStore;
  for (const name of ACTIVITY_WRITE_METHODS) {
    Object.defineProperty(store, name, { enumerable: true, value: (...args: unknown[]) => db.inTransaction
      ? Reflect.apply(local[name] as (...values: unknown[]) => unknown, local, args)
      : channel.call(name, ...(submitted[name]?.(args) ?? args)) });
  }
  return store;
}

/** A write whose outcome the caller does not wait for: a failure is reported, never left unhandled. */
export function observeWrite(result: unknown, failed: (error: unknown) => void): void {
  if (result instanceof Promise) result.catch(failed);
}

/** Runs `then` once the write has committed: at once for a synchronous store, after the commit otherwise. */
export function afterWrite<T>(result: T | Promise<T>, then: (value: T) => void, failed: (error: unknown) => void): void {
  if (result instanceof Promise) result.then(then, failed);
  else then(result);
}

/**
 * One caller's writes as a queue. Each write is submitted once every earlier
 * one has committed, and `after(job)` runs a read or a notification at its
 * place in that order, so it sees every write queued before it. Over a
 * synchronous store, or while nothing is pending, a call runs at once, as it
 * always did. A failed write or job is reported and dropped, as a synchronous
 * failure was. A caller that writes inside its own transaction awaits
 * `settled()` first, so those writes run now, inside it.
 */
export function orderedWrites<S extends Partial<AwaitableActivityStore>>(store: S, failed: (error: unknown) => void): {
  store: S; after(job: () => unknown): void; settled(): Promise<void>;
} {
  let pending = 0, tail: Promise<void> = Promise.resolve();
  const run = (job: () => unknown): Promise<void> | undefined => {
    try {
      const result = job();
      if (result instanceof Promise) return result.then(() => {}, failed);
    } catch (error) { failed(error); }
    return undefined;
  };
  const after = (job: () => unknown) => {
    if (pending === 0) {
      const running = run(job);
      if (!running) return;
      pending++; tail = running.finally(() => { pending--; });
      return;
    }
    pending++; tail = tail.then(() => run(job)).finally(() => { pending--; });
  };
  const view = Object.create(store) as S;
  for (const name of ACTIVITY_WRITE_METHODS) {
    if (typeof store[name] !== "function") continue;
    Object.defineProperty(view, name, { enumerable: true, value: (...args: unknown[]) => {
      after(() => Reflect.apply(store[name] as (...values: unknown[]) => unknown, store, args));
    } });
  }
  return { store: view, after, settled: async () => { let waiting: Promise<void>; do { waiting = tail; await waiting; } while (waiting !== tail); } };
}
