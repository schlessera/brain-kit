/**
 * The accelerator tier: web push delivery for pending notification intents.
 *
 * VAPID keys are generated at first use into their own table (see migration
 * 008 for why not the settings KV) and never leave the process. Payloads are
 * MINIMIZED — title + outcome word + a deep link — because push renders on
 * lock screens outside the app's auth; detail lives behind the authenticated
 * tap-through.
 *
 * Delivery marks the intent sent/send_failed; the inbox (guaranteed tier)
 * is untouched by any of it. A 404/410 response prunes the subscription —
 * the push service says that device is gone. When every send in a pass
 * fails, that is the all-devices signal (VAPID invalidated by a KV
 * wipe/restore, typically) and it is logged loudly; the client surfaces a
 * re-enable prompt when its subscription check disagrees with the server.
 */
import { Agent } from "node:https";
import type { Database } from "bun:sqlite";
import type { SqliteWriter } from "../db/write-worker.js";
import { createPushWrites, setup as inlinePushWrites } from "./push-writes.js";
import type { PushWrites } from "./notify-writes.js";
import type { Logger } from "@opentelemetry/api-logs";
import webpush from "web-push";

import type { ActivityNotifier } from "./notify.js";
import type { ActionAttempt, ActionAttemptOutcome } from "../inbox/notify.js";
import type { AwaitableActionNotifier } from "../inbox/notify-writes.js";
import type { StorageNotifier, StorageNoticeOutcome } from "../storage/notify.js";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  principalId: string | null;
  /** The destination's last reported IANA zone; null until a usable report. */
  timeZone: string | null;
}

export interface PushSender {
  publicKey(): string;
  /** Bind (or re-bind) an endpoint only while the registering principal is live. */
  subscribe(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    principalId: string,
    label?: string
  ): boolean;
  unsubscribe(endpoint: string, principalId: string): boolean;
  subscriptions(principalId?: string): PushSubscriptionRow[];
  /** Make one revoked principal's endpoints inert without deleting browser state. */
  unbindPrincipal(principalId: string): number;
  /** Deliver pending intents to every subscription. Returns sends attempted. */
  deliverPending(notifier: ActivityNotifier): Promise<number>;
  /**
   * Deliver due Action notices: one current-count attempt per destination,
   * frozen by the notifier before sending. Returns sends attempted.
   */
  deliverActions(notices: AwaitableActionNotifier, now?: number): Promise<number>;
  /** One durable Critical Storage submission per episode and subscription. */
  deliverStorage(notices: StorageNotifier, now?: number, signal?: AbortSignal): Promise<number>;
}


/** Hosted lifecycle writes settle after their FULL worker commit; standalone reads stay synchronous. */
type LifecycleWrite = "publicKey" | "subscribe" | "unsubscribe" | "unbindPrincipal";
export type AwaitablePushSender = Omit<PushSender, LifecycleWrite> & {
  [K in LifecycleWrite]: (...args: Parameters<PushSender[K]>) => ReturnType<PushSender[K]> | Promise<ReturnType<PushSender[K]>>;
};

export interface CreatePushSenderOptions {
  /** Shared hosted write connection; absent for standalone synchronous callers. */
  writer?: SqliteWriter;
  /** Injection seam for tests — the real webpush.sendNotification otherwise. */
  send?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
      timeout?: number;
    }
  ) => Promise<unknown>;
  /** `mailto:` or https contact required by the VAPID spec. */
  subject?: string;
  log?: Logger;
  /** Where subscription bookkeeping commits: the write worker (#2850). Absent: on `db`, at once. */
  writes?: PushWrites;
}

/** Per-send cap: a hung push service rejects instead of wedging the
 *  delivering guard (the tick's reentrancy flag) forever. */
const SEND_TIMEOUT_MS = 10_000;

type ManagedPushSender = AwaitablePushSender & { close(): Promise<void> };
type ManagedInlinePushSender = PushSender & { close(): Promise<void> };

export function createPushSender(db: Database, options: CreatePushSenderOptions & { writer: SqliteWriter }): ManagedPushSender;
export function createPushSender(db: Database, options?: CreatePushSenderOptions & { writer?: undefined }): ManagedInlinePushSender;
export function createPushSender(db: Database, options: CreatePushSenderOptions): ManagedPushSender;
export function createPushSender(db: Database, options: CreatePushSenderOptions = {}): ManagedPushSender {
  const log = options.log;
  const writes: PushWrites = options.writes ?? {
    async touch(endpoint, at, principalId) {
      if (principalId === undefined) db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?").run(at, endpoint);
      else db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ? AND principal_id = ?").run(at, endpoint, principalId);
    },
    async drop(endpoint) { db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint); },
  };
  const subject = options.subject ?? "mailto:admin@localhost";
  // web-push's socket timeout is an inactivity limit. Own an agent per send
  // so the absolute deadline also destroys a trickling/stalled transport.
  // The same deadline covers the injected transport without changing outcomes.
  const send: NonNullable<CreatePushSenderOptions["send"]> = async (sub, payload, opts) => {
    const agent = options.send ? undefined : new Agent({ keepAlive: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => options.send
          ? options.send(sub, payload, opts)
          : webpush.sendNotification(sub, payload, { ...opts, agent })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            agent?.destroy();
            reject(new Error("Push send deadline exceeded"));
          }, SEND_TIMEOUT_MS);
        }),
      ]);
    } finally { clearTimeout(timer); agent?.destroy(); }
  };
  let closing = false;
  let closed: Promise<void> | undefined;
  const flights = new Map<string, Promise<number>>();
  // Runtime and sampler catches report failures before app shutdown reaches
  // this owner. Settled failures must outlive removal from the pending set.
  // Keep the first four distinct original causes, not an app-lifetime error log.
  // Count failed operations (not distinct identities); saturation bounds the counter.
  const failures = new Set<unknown>();
  let failureCount = 0;
  function retain(error: unknown): void {
    failureCount = Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1);
    if (failures.size < 4) failures.add(error);
  }
  async function settleWrites(writes: Promise<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(writes);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Push outcome writes failed");
  }
  function deliver(kind: string, run: () => Promise<number>): Promise<number> {
    if (closing) return Promise.resolve(0);
    const existing = flights.get(kind);
    if (existing) return existing;
    // Install ownership before invoking any caller-supplied code.
    const flight = Promise.resolve().then(run);
    flights.set(kind, flight);
    const done = () => { flights.delete(kind); };
    void flight.then(done, error => { retain(error); done(); });
    return flight;
  }

  // The worker serializes each first-use check and insert, including races
  // between delivery passes and the public-key route.
  const admin = options.writer ? createPushWrites(db, options.writer) : inlinePushWrites(db);

  function mapRows(dbRows: any[]): PushSubscriptionRow[] {
    return (
      dbRows
    ).map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      principalId: r.principal_id,
      timeZone: r.time_zone ?? null,
    }));
  }

  function rows(principalId?: string): PushSubscriptionRow[] {
    const dbRows = principalId === undefined
      ? db.query("SELECT * FROM push_subscriptions ORDER BY created_at").all()
      : db
          .query(
            `SELECT * FROM push_subscriptions
             WHERE principal_id = ? ORDER BY created_at`
          )
          .all(principalId);
    return mapRows(dbRows as any[]);
  }

  function deliverableRows(now: number): PushSubscriptionRow[] {
    return mapRows(
      db
        .query(
          `SELECT s.* FROM push_subscriptions s
           JOIN principals p ON p.id = s.principal_id
           WHERE p.revoked_at IS NULL
             AND typeof(p.expires_at) = 'integer'
             AND p.expires_at > ?
           ORDER BY s.created_at`
        )
        .all(now) as any[]
    );
  }

  const sender: AwaitablePushSender = {
    publicKey() {
      const keys = admin.vapid();
      return keys instanceof Promise ? keys.then(row => row.publicKey) : keys.publicKey;
    },
    subscribe: (sub, principalId, label) => admin.subscribe(sub, principalId, label, Date.now()),
    unsubscribe: (endpoint, principalId) => admin.unsubscribe(endpoint, principalId),
    subscriptions: rows,
    unbindPrincipal: principalId => admin.unbindPrincipal(principalId),

    async deliverPending(notifier) {
      const pending = notifier.pending();
      if (pending.length === 0) return 0;
      if (deliverableRows(Date.now()).length === 0) {
        // No devices: the inbox already has it; nothing to deliver. Leave
        // the intents pending so a device subscribing later still gets them
        // if they are fresh, and the boot sweep can retry.
        return 0;
      }
      const keys = await admin.vapid();
      let attempts = 0;

      for (const intent of pending) {
        if (closing) break;
        // Re-read per intent: an endpoint pruned as dead during the previous
        // intent's pass must not be attempted again in this one.
        const subs = deliverableRows(Date.now());
        if (subs.length === 0) break;
        // Minimized payload; the tag coalesces repeats per run across devices.
        const payload = JSON.stringify({
          title: intent.title,
          body: intent.body,
          tag: `brain-activity:${intent.runId}`,
          url: `/#/activity/${encodeURIComponent(intent.runId)}`,
        });
        attempts += subs.length;
        const results = await Promise.allSettled(
          subs.map((sub) =>
            send(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
              {
                vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
                timeout: SEND_TIMEOUT_MS,
              }
            )
          )
        );
        // DB writes only after the whole settled pass — never concurrent
        // with in-flight sends against the same handle.
        let delivered = 0;
        const touched: string[] = [];
        const dead: string[] = [];
        results.forEach((result, i) => {
          const sub = subs[i]!;
          if (result.status === "fulfilled") {
            delivered++;
            touched.push(sub.endpoint);
            return;
          }
          const err = result.reason;
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The push service says this device is gone.
            dead.push(sub.endpoint);
            log?.emit({
              severityText: "INFO",
              body: "pruned dead push subscription",
              attributes: { status: status },
            });
          } else {
            log?.emit({
              severityText: "WARN",
              body: "push send failed",
              attributes: {
                error: err instanceof Error ? err.message : String(err),
                ...(status ? { status } : {}),
              },
            });
          }
        });
        // Committed before the next intent re-reads its devices, and before
        // the next pass re-reads what is still pending.
        const at = Date.now();
        await settleWrites([...touched.map(endpoint => Promise.resolve().then(() => writes.touch(endpoint, at))), ...dead.map(endpoint => Promise.resolve().then(() => writes.drop(endpoint)))]);
        await notifier.markDelivered(intent.id, delivered > 0 ? "sent" : "send_failed");
        if (delivered === 0) {
          // Every device failed — the all-devices signal (invalid VAPID after
          // a restore, typically). Loud, because it is silent on every phone.
          log?.emit({
            severityText: "ERROR",
            body: "push delivery failed on every subscription",
            attributes: { subscriptions: subs.length },
          });
        }
      }
      return attempts;
    },

    async deliverStorage(notices, at, signal) {
      let attempts = 0;
      // Resolve credentials first, then acquire each durable intent immediately
      // before its transport call. Authority/zone/time are rechecked per device.
      const subs = deliverableRows(at ?? Date.now());
      if (!subs.length) return 0;
      const keys = await admin.vapid();
      for (const sub of subs) {
        if (closing || signal?.aborted) break;
        const attempt = await notices.begin(sub.endpoint, at ?? Date.now());
        if (!attempt) continue;
        let outcome: StorageNoticeOutcome;
        attempts++;
        try {
          await send(attempt.subscription, JSON.stringify(attempt.payload), {
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, timeout: SEND_TIMEOUT_MS,
          });
          outcome = "accepted";
        } catch (error) {
          const status = (error as { statusCode?: number } | null)?.statusCode;
          outcome = status === 404 || status === 410 ? "gone" : typeof status === "number" && status >= 400 && status <= 599 ? "failed" : "unknown";
        }
        // A database failure after transport leaves the durable sending intent;
        // recovery makes it unknown and never retries a possible acceptance.
        await notices.finish(attempt.id, outcome, at ?? Date.now());
        if (outcome === "gone") await writes.drop(sub.endpoint);
        else if (outcome === "accepted") await writes.touch(sub.endpoint, at ?? Date.now(), attempt.principalId);
      }
      return attempts;
    },

    async deliverActions(notices, at) {
      const now = at ?? Date.now();
      // Each destination is evaluated on its own: its zone, quiet hours,
      // current binding and known receipts. The notifier freezes the payload
      // and components in the same transaction that rechecks them.
      const planned: Array<{ sub: PushSubscriptionRow; attempt: ActionAttempt }> = [];
      for (const sub of deliverableRows(now)) {
        if (closing) break;
        const attempt = await notices.beginAttempt({ endpoint: sub.endpoint, principalId: sub.principalId! }, now);
        if (attempt) planned.push({ sub, attempt });
      }
      if (planned.length === 0) return 0;
      const keys = await admin.vapid();
      const results = await Promise.allSettled(
        planned.map(({ sub, attempt }) =>
          send(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(attempt.payload),
            {
              vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
              timeout: SEND_TIMEOUT_MS,
            }
          )
        )
      );
      const bookkeeping: Promise<void>[] = [];
      results.forEach((result, i) => {
        const { sub, attempt } = planned[i]!;
        let outcome: ActionAttemptOutcome;
        if (result.status === "fulfilled") {
          // Provider acceptance: a submission receipt, not display or reading.
          outcome = "success";
          bookkeeping.push(Promise.resolve().then(() => writes.touch(sub.endpoint, Date.now())));
        } else {
          const status = (result.reason as { statusCode?: number } | null)?.statusCode;
          if (status === 404 || status === 410) {
            outcome = "gone";
            bookkeeping.push(Promise.resolve().then(() => writes.drop(sub.endpoint)));
          } else {
            // A provider status is a known refusal. Without one (timeout,
            // dropped connection) the request may have arrived: ambiguous.
            outcome = typeof status === "number" ? "failed" : "ambiguous";
          }
          log?.emit({
            severityText: "WARN",
            body: "action notice send did not succeed",
            attributes: { outcome, ...(status ? { status } : {}) },
          });
        }
        bookkeeping.push(Promise.resolve().then(() => notices.finishAttempt(attempt.attemptId, outcome)));
      });
      await settleWrites(bookkeeping);
      return planned.length;
    },
  };
  return {
    ...sender,
    deliverPending: notifier => deliver("activity", () => sender.deliverPending(notifier)),
    deliverActions: (notices, at) => deliver("actions", () => sender.deliverActions(notices, at)),
    deliverStorage: (notices, at, signal) => deliver("storage", () => sender.deliverStorage(notices, at, signal)),
    close() {
      return closed ??= (() => {
        closing = true;
        // Stop admission, then join transport AND its committed outcome writes.
        // Do not turn a failed persistence write into successful shutdown.
        return Promise.allSettled([...flights.values()]).then(() => {
          // Each flight's earlier rejection observer has already retained it once.
          const errors = [...failures];
          if (failureCount === 1) throw errors[0];
          if (failureCount) throw new AggregateError(errors,
            `Push delivery drain failed: ${failureCount === Number.MAX_SAFE_INTEGER ? "at least " : ""}${failureCount} failed operations; ${errors.length} error representatives retained`,
            { cause: errors[0] });
        });
      })();
    },
  };
}
