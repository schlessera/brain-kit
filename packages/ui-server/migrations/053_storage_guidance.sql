-- Bounded operational evidence, separate from disposable content indexing.
CREATE TABLE storage_history (
  brain TEXT PRIMARY KEY CHECK (length(brain) = 32),
  payload_json TEXT NOT NULL CHECK (length(CAST(payload_json AS BLOB)) <= 262144),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
-- Coordination and delivery receipts are operational overhead, not history payload.
CREATE TABLE storage_scan_leases (
  brain TEXT PRIMARY KEY CHECK (length(brain) = 32),
  job_id TEXT,
  pid INTEGER,
  process_start TEXT,
  principal_id TEXT,
  started_at INTEGER,
  scope TEXT,
  source INTEGER CHECK (source BETWEEN 0 AND 2),
  workers_json TEXT NOT NULL DEFAULT '[]' CHECK (length(workers_json) <= 1024),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  results_json TEXT NOT NULL DEFAULT '[]' CHECK (length(results_json) <= 2048),
  last_request_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  last_attempt_bucket INTEGER,
  result_id TEXT,
  result_at INTEGER,
  failure TEXT,
  CHECK ((job_id IS NULL AND pid IS NULL AND process_start IS NULL AND principal_id IS NULL AND started_at IS NULL)
      OR (job_id IS NOT NULL AND pid > 0 AND process_start IS NOT NULL AND principal_id IS NOT NULL AND started_at >= 0))
);
CREATE TABLE storage_notice_receipts (
  brain TEXT NOT NULL REFERENCES storage_history(brain) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'accepted', 'failed', 'unknown', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  attempted_at INTEGER,
  next_at INTEGER,
  batch_id TEXT,
  pid INTEGER,
  process_start TEXT,
  PRIMARY KEY (brain, episode, endpoint)
);
