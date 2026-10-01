-- Preserve all existing Activity rows/cursors while adding autonomous origin.
-- Append-only migration: do not rewrite migration 007 on installed hosts.
CREATE TABLE activity_spans_autonomous (
  span_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'subagent', 'cron')),
  origin TEXT NOT NULL CHECK (origin IN ('session', 'cron', 'autonomous')),
  session_id TEXT,
  job_name TEXT,
  attrs TEXT,
  started_at INTEGER NOT NULL,
  wait_until INTEGER,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success', 'error', 'timeout', 'cancelled', 'denied', 'interrupted')),
  outcome_reason TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  model TEXT,
  writer TEXT NOT NULL,
  last_heartbeat_at INTEGER,
  principal_id TEXT
);
INSERT INTO activity_spans_autonomous SELECT * FROM activity_spans;
DROP TABLE activity_spans;
ALTER TABLE activity_spans_autonomous RENAME TO activity_spans;
CREATE INDEX idx_activity_spans_run ON activity_spans(run_id, started_at);
CREATE INDEX idx_activity_spans_open ON activity_spans(started_at DESC) WHERE outcome IS NULL AND parent_span_id IS NULL;
CREATE INDEX idx_activity_spans_job ON activity_spans(job_name, started_at DESC) WHERE job_name IS NOT NULL;
