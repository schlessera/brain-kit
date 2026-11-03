-- External compute on the host (#3108).
-- 1. Activity gains the additive `compute` origin: each hosted job is its own
--    root run `compute:<job id>`. Append-only rebuild, as 023 did for
--    `autonomous`; every existing row, id and index is kept.
CREATE TABLE activity_spans_compute (
  span_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'subagent', 'cron')),
  origin TEXT NOT NULL CHECK (origin IN ('session', 'cron', 'autonomous', 'compute')),
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
INSERT INTO activity_spans_compute SELECT * FROM activity_spans;
DROP TABLE activity_spans;
ALTER TABLE activity_spans_compute RENAME TO activity_spans;
CREATE INDEX idx_activity_spans_run ON activity_spans(run_id, started_at);
CREATE INDEX idx_activity_spans_open ON activity_spans(started_at DESC) WHERE outcome IS NULL AND parent_span_id IS NULL;
CREATE INDEX idx_activity_spans_job ON activity_spans(job_name, started_at DESC) WHERE job_name IS NOT NULL;

-- 2. A hosted job's cost reservation against its turn's, session's and UTC
--    day's budgets. `reserved_usd` NULL: no hourly ceiling, so the cost is
--    unknown (ruling 4), never zero. Settled exactly once, with the actual
--    cost or NULL when unknown.
CREATE TABLE compute_budget_reservations (
  job_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  session_id TEXT,
  day_start INTEGER NOT NULL,
  reserved_usd REAL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled')),
  actual_usd REAL,
  reserved_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX compute_budget_reservations_turn ON compute_budget_reservations(turn_id);
CREATE INDEX compute_budget_reservations_session ON compute_budget_reservations(session_id);
CREATE INDEX compute_budget_reservations_day ON compute_budget_reservations(day_start);

-- 3. What the host needs to drive, cancel and observe a hosted job after its
--    turn ends or the server restarts: the caller it was admitted for, the
--    instance configuration it was admitted under (data, no credential) and
--    its Activity run. The job record itself stays in the compute state
--    directory, which is the authority for its lifecycle.
CREATE TABLE compute_hosted_jobs (
  job_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_use_id TEXT,
  instance TEXT NOT NULL,
  instance_config TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  observed TEXT
);
CREATE INDEX compute_hosted_jobs_open ON compute_hosted_jobs(settled_at) WHERE settled_at IS NULL;
CREATE INDEX compute_hosted_jobs_session ON compute_hosted_jobs(session_id);
