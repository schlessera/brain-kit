-- Durable operational work, distinct from Activity's notification inbox and
-- from disposable brain.db content indexes. All writes use the concrete store.
-- Separate state machines; trust/provenance and audit history are immutable.
CREATE TABLE inbox_threads (
  id TEXT PRIMARY KEY,
  trust_class TEXT NOT NULL CHECK (trust_class IN ('trusted', 'untrusted')),
  source TEXT NOT NULL CHECK (source IN ('share', 'cli')),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  stakes INTEGER NOT NULL CHECK (stakes BETWEEN 1 AND 3),
  deadline INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  state_md TEXT NOT NULL DEFAULT '' CHECK (length(CAST(state_md AS BLOB)) <= 4096),
  projection_seq INTEGER NOT NULL DEFAULT 0,
  compaction_pending INTEGER NOT NULL DEFAULT 0 CHECK (compaction_pending IN (0, 1)),
  deleted_at INTEGER,
  CHECK ((source = 'cli' AND trust_class = 'trusted') OR (source = 'share' AND trust_class = 'untrusted'))
);
CREATE TRIGGER inbox_thread_provenance_immutable
BEFORE UPDATE OF id, trust_class, source, created_at ON inbox_threads
WHEN NEW.id IS NOT OLD.id OR NEW.trust_class IS NOT OLD.trust_class OR NEW.source IS NOT OLD.source OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'Immutable inbox provenance'); END;

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES inbox_threads(id),
  dedup_key TEXT NOT NULL UNIQUE,
  queue TEXT NOT NULL CHECK (queue IN ('queue', 'actions')),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  expires_at INTEGER NOT NULL,
  wait_until INTEGER,
  run_id TEXT,
  claimed_at INTEGER,
  lease_until INTEGER,
  attempts INTEGER,
  max_attempts INTEGER,
  blocked_by_item_id TEXT REFERENCES inbox_items(id),
  deleted_at INTEGER,
  CHECK ((queue = 'queue' AND type IN ('triage', 'execute', 'cleanup_pending') AND status IN ('scheduled', 'ready', 'claimed', 'done', 'blocked', 'failed', 'superseded', 'expired', 'dropped')) OR
         (queue = 'actions' AND type IN ('approve', 'choose', 'fyi') AND status IN ('pending', 'snoozed', 'resolved', 'dismissed', 'expired', 'dropped')))
);
CREATE INDEX inbox_items_thread ON inbox_items(thread_id);
CREATE INDEX inbox_items_ready ON inbox_items(queue, status, wait_until, expires_at) WHERE deleted_at IS NULL;
-- Sequence rows outlive removed projections. Change payloads are frozen at
-- commit time, so tombstones and old deltas never join today's mutable rows.
CREATE TABLE inbox_thread_sequences (thread_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE inbox_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  item_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upsert_thread', 'upsert_item', 'remove_item', 'remove_thread')),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  UNIQUE(thread_id, seq)
);
CREATE INDEX inbox_changes_thread ON inbox_changes(thread_id, seq);

CREATE TABLE inbox_checkpoints (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES inbox_threads(id),
  item_id TEXT REFERENCES inbox_items(id),
  run_id TEXT,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'compaction')),
  state_md TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
  UNIQUE(thread_id, seq)
);
CREATE TRIGGER inbox_checkpoint_no_update BEFORE UPDATE ON inbox_checkpoints
BEGIN SELECT RAISE(ABORT, 'Append-only inbox checkpoint'); END;
CREATE TRIGGER inbox_checkpoint_no_delete BEFORE DELETE ON inbox_checkpoints
BEGIN SELECT RAISE(ABORT, 'Append-only inbox checkpoint'); END;

CREATE TABLE inbox_resolutions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES inbox_items(id),
  thread_id TEXT NOT NULL REFERENCES inbox_threads(id),
  option_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  reason TEXT CHECK (reason IN ('dont_ask_again', 'wrong_call', 'need_more_info', 'no_longer_relevant')),
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  created_at INTEGER NOT NULL
);
CREATE TRIGGER inbox_resolution_no_update BEFORE UPDATE ON inbox_resolutions
BEGIN SELECT RAISE(ABORT, 'Write-once inbox resolution'); END;
CREATE TRIGGER inbox_resolution_no_delete BEFORE DELETE ON inbox_resolutions
BEGIN SELECT RAISE(ABORT, 'Write-once inbox resolution'); END;
CREATE TABLE inbox_suppressions (
  class_key TEXT PRIMARY KEY,
  evidence_boundary TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  reraise_condition TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE inbox_scheduler_heartbeats (
  name TEXT PRIMARY KEY,
  tick_at INTEGER NOT NULL,
  change_cursor INTEGER NOT NULL
);
-- U4 owns admission/settlement policy. These explicit records survive leases,
-- count in-flight spend/turns, and preserve the admission day and observed cost.
CREATE TABLE inbox_budget_reservations (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('triage', 'execute', 'retry', 'redo', 'compaction')),
  run_id TEXT,
  principal_id TEXT NOT NULL,
  model TEXT NOT NULL,
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('subscription', 'api')),
  local_day TEXT NOT NULL,
  reserve_kind TEXT NOT NULL CHECK (reserve_kind IN ('normal', 'emergency')),
  reserved_cost_usd REAL NOT NULL CHECK (reserved_cost_usd >= 0),
  reserved_turns INTEGER NOT NULL CHECK (reserved_turns >= 0),
  observed_cost_usd REAL CHECK (observed_cost_usd >= 0),
  charged_cost_usd REAL CHECK (charged_cost_usd >= 0),
  charged_turns INTEGER CHECK (charged_turns >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  started_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX inbox_reservations_day ON inbox_budget_reservations(local_day, status);
