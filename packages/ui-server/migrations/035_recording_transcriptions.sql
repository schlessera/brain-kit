-- Host-wide ids. Account identity authorizes access; it is not an idempotency key.
-- Deliberately no principal foreign key or expiry: login rows can be pruned.
CREATE TABLE recording_transcriptions (
  recording_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  sha256 TEXT,
  provider_id TEXT,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  failure TEXT,
  failures TEXT NOT NULL DEFAULT '[]',
  disposition TEXT
);
