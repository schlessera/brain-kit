-- Agent activity record: one span per unit of agent activity (turn, tool
-- call, subagent run, cron run), forming a tree per run. Current state lives
-- in activity_spans; append-only transcript/progress increments live in
-- activity_events; every committed write also lands one row in
-- activity_changes, which is BOTH the global change cursor (change_id, for
-- the server's foreign-write poller) and the per-run sequence authority
-- (seq, for the client's snapshot-then-delta discard rule).
--
-- Outcome is write-once: 'interrupted' is assigned only by a sweeper, never
-- by a live writer. last_heartbeat_at is touched by external writers (the
-- cron wrapper) so staleness is judged on heartbeat age, not span age.
CREATE TABLE IF NOT EXISTS activity_spans (
  span_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'subagent', 'cron')),
  origin TEXT NOT NULL CHECK (origin IN ('session', 'cron')),
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
  last_heartbeat_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_activity_spans_run ON activity_spans(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_activity_spans_open ON activity_spans(outcome) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_activity_spans_session ON activity_spans(session_id, started_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_spans_job ON activity_spans(job_name, started_at DESC) WHERE job_name IS NOT NULL;

-- Append-only span events (subagent transcript excerpts, progress notes).
-- Payloads are capped at persist time (stored truncation marker) so a single
-- WS delta can never approach the frame size cap.
CREATE TABLE IF NOT EXISTS activity_events (
  span_id TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  PRIMARY KEY (span_id, event_index)
);

-- Change log: one row per committed write. change_id is the global monotonic
-- cursor (a brand-new foreign run is discoverable only through this); seq is
-- per-run monotonic and totally orders every delta-visible write within a
-- run. event_index is NULL for span-state changes.
CREATE TABLE IF NOT EXISTS activity_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  span_id TEXT NOT NULL,
  event_index INTEGER
);

CREATE INDEX IF NOT EXISTS idx_activity_changes_run ON activity_changes(run_id, seq);

-- Per-run rollups survive span pruning forever: any run id that ever existed
-- resolves to at least this row ("detail pruned"), and cost/token aggregation
-- reads ROOT rollups only (subagent usage is display-only enrichment —
-- result-level accounting already includes subagent consumption).
CREATE TABLE IF NOT EXISTS activity_run_rollups (
  run_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  session_id TEXT,
  job_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  duration_ms INTEGER,
  span_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  failure_reason TEXT,
  detail_pruned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activity_rollups_started ON activity_run_rollups(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_rollups_job ON activity_run_rollups(job_name, started_at DESC) WHERE job_name IS NOT NULL;

-- Notification intents: persisted with the triggering event so delivery is
-- at-least-once (pending rows are swept on boot). status transitions:
-- pending -> sent | send_failed | suppressed. tag deduplicates per run so
-- repeats coalesce instead of stacking.
CREATE TABLE IF NOT EXISTS notification_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  span_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('failure', 'completion', 'stuck')),
  tag TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'send_failed', 'suppressed')),
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_intents_status ON notification_intents(status, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_intents_tag ON notification_intents(tag, created_at DESC);
