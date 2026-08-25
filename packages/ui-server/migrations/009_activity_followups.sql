-- Review follow-ups on the activity layer.

-- Retry budget for push delivery: a send_failed intent is retried (with
-- backoff, see notify.ts) until this counter reaches the cap — one transient
-- push-service failure no longer forfeits push for the intent.
ALTER TABLE notification_intents ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0;

-- The hourly prune's candidate query filters on detail_pruned = 0 and
-- ended_at; without an index it scans every already-pruned row, growing with
-- exactly the table it is trying to shrink. Partial: pruned rows leave it.
CREATE INDEX IF NOT EXISTS idx_activity_rollups_prunable
  ON activity_run_rollups(ended_at) WHERE detail_pruned = 0;

-- No query reads spans by (session_id, started_at): session-scoped reads go
-- through run_id (runs are looked up first). Drop the write-amplifying index.
DROP INDEX IF EXISTS idx_activity_spans_session;
