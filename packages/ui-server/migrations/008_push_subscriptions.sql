-- Web push: per-device subscriptions, modeled on passkey_credentials (the
-- app is single-user — no user_id column; a row IS a device+browser).
-- Endpoints are unique; a 404/410 on send prunes the row.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- The VAPID keypair, generated at first boot. DELIBERATELY its own table,
-- not a settings-KV row: settings are non-secret preferences that a future
-- list/export route may expose wholesale, while this private key must never
-- ride along (a leak lets an attacker send authentic push to the user's
-- device). Nothing may ever add a route that reads this table's private_key
-- out of the process.
CREATE TABLE IF NOT EXISTS vapid_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
