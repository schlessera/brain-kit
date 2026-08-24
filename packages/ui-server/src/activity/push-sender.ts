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

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PushSender {
  publicKey(): string;
  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, label?: string): void;
  unsubscribe(endpoint: string): boolean;
  subscriptions(): PushSubscriptionRow[];
  /** Deliver pending intents to every subscription. Returns sends attempted. */
  deliverPending(notifier: ActivityNotifier): Promise<number>;
}

export interface CreatePushSenderOptions {
  /** Injection seam for tests — the real webpush.sendNotification otherwise. */
  send?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string } }
  ) => Promise<unknown>;
  /** `mailto:` or https contact required by the VAPID spec. */
  subject?: string;
  log?: Logger;
}

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
        { vapidDetails: opts.vapidDetails }
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

  function rows(): PushSubscriptionRow[] {
    return (
      db.query("SELECT * FROM push_subscriptions ORDER BY created_at").all() as any[]
    ).map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  return {
    publicKey() {
      return vapid().publicKey;
    },

    subscribe(sub, label) {
      db.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
      ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, label ?? null, Date.now());
    },

    unsubscribe(endpoint) {
      return db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint)
        .changes > 0;
    },

    subscriptions: rows,

    async deliverPending(notifier) {
      const pending = notifier.pending();
      if (pending.length === 0) return 0;
      const subs = rows();
      if (subs.length === 0) {
        // No devices: the inbox already has it; nothing to deliver. Leave
        // the intents pending so a device subscribing later still gets them
        // if they are fresh, and the boot sweep can retry.
        return 0;
      }
      const keys = vapid();
      let attempts = 0;

      for (const intent of pending) {
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
              { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey } }
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
  };
}
