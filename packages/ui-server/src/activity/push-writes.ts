/** Push registration, revocation and lazy VAPID creation off the app connection (#3002). */
import type { Database } from "bun:sqlite";
import webpush from "web-push";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";

export const url = import.meta.url;
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

export function setup(db: Database) {
  const readKeys = () => db.query("SELECT public_key AS publicKey, private_key AS privateKey FROM vapid_keys WHERE id = 1")
    .get() as { publicKey: string; privateKey: string } | null;
  return {
    vapid() {
      const row = readKeys();
      if (row) return row;
      const generated = webpush.generateVAPIDKeys();
      db.query("INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)")
        .run(generated.publicKey, generated.privateKey, Date.now());
      return readKeys()!;
    },
    subscribe(sub: Subscription, principalId: string, label: string | undefined, now: number) {
      return db.query(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at, principal_id)
        SELECT ?, ?, ?, ?, ?, id FROM principals WHERE id = ? AND revoked_at IS NULL
          AND typeof(expires_at) = 'integer' AND expires_at > ?
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
          label = excluded.label, principal_id = excluded.principal_id`)
        .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, label ?? null, now, principalId, now).changes > 0;
    },
    unsubscribe(endpoint: string, principalId: string) {
      return db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND principal_id = ?").run(endpoint, principalId).changes > 0;
    },
    unbindPrincipal(principalId: string) {
      return db.query("UPDATE push_subscriptions SET principal_id = NULL WHERE principal_id = ?").run(principalId).changes;
    },
  };
}

export function createPushWrites(db: Database, writer: SqliteWriter) {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  return {
    vapid: () => call<ReturnType<ReturnType<typeof setup>["vapid"]>>("vapid"),
    subscribe: (sub: Subscription, principalId: string, label: string | undefined, now: number) => call<boolean>("subscribe", sub, principalId, label, now),
    unsubscribe: (endpoint: string, principalId: string) => call<boolean>("unsubscribe", endpoint, principalId),
    unbindPrincipal: (principalId: string) => call<number>("unbindPrincipal", principalId),
  };
}
