-- Independent of occurrence-ledger migrations 079 and 081+; no ledger objects.
CREATE TABLE trust_settings_operations (
  request_id TEXT PRIMARY KEY,
  brain_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  authority TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  stage TEXT NOT NULL,
  proof TEXT,
  receipt TEXT NOT NULL
);
CREATE INDEX trust_settings_owner ON trust_settings_operations(brain_id, principal_id);
CREATE TABLE trust_settings_projection (
  brain_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  rules TEXT NOT NULL,
  policy_hash TEXT,
  error TEXT
);
