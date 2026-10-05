/**
 * The accelerator tier: web push delivery for pending notification intents.
 *
 * VAPID keys are generated at first boot into their own table (see migration
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
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import webpush from "web-push";

import type { ActivityNotifier } from "./notify.js";
import type { ActionAttemptOutcome, ActionNotifier } from "../inbox/notify.js";

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
  deliverActions(notices: ActionNotifier, now?: number): Promise<number>;
}

export interface CreatePushSenderOptions {
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
}

/** Per-send cap: a hung push service rejects instead of wedging the
 *  delivering guard (the tick's reentrancy flag) forever. */
const SEND_TIMEOUT_MS = 10_000;

export function createPushSender(
  db: Database,
  options: CreatePushSenderOptions = {}
): PushSender {
  const log = options.log;
  const subject = options.subject ?? "mailto:admin@localhost";
  const send =
    options.send ??
    ((sub, payload, opts) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        { vapidDetails: opts.vapidDetails, timeout: opts.timeout }
      ));

  // Generate-once VAPID keys. Concurrent first boots are safe: the INSERT is
  // OR IGNORE and the read-back wins.
  function vapid(): { publicKey: string; privateKey: string } {
    const row = db
      .query("SELECT public_key AS publicKey, private_key AS privateKey FROM vapid_keys WHERE id = 1")
      .get() as { publicKey: string; privateKey: string } | null;
    if (row) return row;
    const generated = webpush.generateVAPIDKeys();
    db.query(
      "INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)"
    ).run(generated.publicKey, generated.privateKey, Date.now());
    return vapid();
  }

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

  return {
    publicKey() {
      return vapid().publicKey;
    },

    subscribe(sub, principalId, label) {
      const now = Date.now();
      return db.query(
        `INSERT INTO push_subscriptions
           (endpoint, p256dh, auth, label, created_at, principal_id)
         SELECT ?, ?, ?, ?, ?, id FROM principals
         WHERE id = ? AND revoked_at IS NULL
           AND typeof(expires_at) = 'integer' AND expires_at > ?
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           label = excluded.label,
           principal_id = excluded.principal_id`
      ).run(
        sub.endpoint,
        sub.keys.p256dh,
        sub.keys.auth,
        label ?? null,
        now,
        principalId,
        now
      ).changes > 0;
    },

    unsubscribe(endpoint, principalId) {
      return db
        .query(
          "DELETE FROM push_subscriptions WHERE endpoint = ? AND principal_id = ?"
        )
        .run(endpoint, principalId).changes > 0;
    },

    subscriptions: rows,

    unbindPrincipal(principalId) {
      return db
        .query(
          "UPDATE push_subscriptions SET principal_id = NULL WHERE principal_id = ?"
        )
        .run(principalId).changes;
    },

    async deliverPending(notifier) {
      const pending = notifier.pending();
      if (pending.length === 0) return 0;
      if (deliverableRows(Date.now()).length === 0) {
        // No devices: the inbox already has it; nothing to deliver. Leave
        // the intents pending so a device subscribing later still gets them
        // if they are fresh, and the boot sweep can retry.
        return 0;
      }
      const keys = vapid();
      let attempts = 0;

      for (const intent of pending) {
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
        for (const endpoint of touched) {
          db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?").run(
            Date.now(),
            endpoint
          );
        }
        for (const endpoint of dead) {
          db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
        }
        notifier.markDelivered(intent.id, delivered > 0 ? "sent" : "send_failed");
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

    async deliverActions(notices, at) {
      const now = at ?? Date.now();
      // Each destination is evaluated on its own: its zone, quiet hours,
      // current binding and known receipts. The notifier freezes the payload
      // and components in the same transaction that rechecks them.
      const planned = deliverableRows(now).flatMap((sub) => {
        const attempt = notices.beginAttempt({ endpoint: sub.endpoint, principalId: sub.principalId! }, now);
        return attempt ? [{ sub, attempt }] : [];
      });
      if (planned.length === 0) return 0;
      const keys = vapid();
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
      results.forEach((result, i) => {
        const { sub, attempt } = planned[i]!;
        let outcome: ActionAttemptOutcome;
        if (result.status === "fulfilled") {
          // Provider acceptance: a submission receipt, not display or reading.
          outcome = "success";
          db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?").run(Date.now(), sub.endpoint);
        } else {
          const status = (result.reason as { statusCode?: number } | null)?.statusCode;
          if (status === 404 || status === 410) {
            outcome = "gone";
            db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
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
        notices.finishAttempt(attempt.attemptId, outcome);
      });
      return planned.length;
    },
  };
}
