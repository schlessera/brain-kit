-- Bounded storage events timeline (#4541): operational evidence recorded at its
-- source. A full kind stops recording; no event is ever updated, or deleted to
-- make room. A start's own seq is its episode, so only later steps store one.
CREATE TABLE storage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  brain TEXT NOT NULL CHECK (length(brain) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('pressure', 'refusal', 'scope', 'maintenance')),
  phase TEXT NOT NULL CHECK (phase IN ('start', 'step', 'recovery-started', 'end', 'refused', 'succeeded', 'changed', 'requested', 'finished')),
  at INTEGER NOT NULL CHECK (at >= 0),
  identity TEXT CHECK (identity IS NULL OR length(identity) = 32),
  severity TEXT CHECK (severity IS NULL OR severity IN ('observed', 'low', 'critical')),
  episode INTEGER,
  target TEXT CHECK (target IS NULL OR length(target) = 32),
  resource TEXT CHECK (resource IS NULL OR resource IN ('bytes', 'quota', 'inodes', 'unknown')),
  root_scope TEXT CHECK (root_scope IS NULL OR length(root_scope) = 32),
  previous_root_scope TEXT CHECK (previous_root_scope IS NULL OR length(previous_root_scope) = 32),
  receipt TEXT CHECK (receipt IS NULL OR length(receipt) BETWEEN 16 AND 96),
  operation TEXT CHECK (operation IS NULL OR operation IN ('pack-git', 'prune-scratch', 'cleanup-staging')),
  state TEXT CHECK (state IS NULL OR state IN ('complete', 'partial', 'refused', 'cancelled', 'unknown')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 64),
  principal_id TEXT,
  CHECK ((kind = 'maintenance') = (receipt IS NOT NULL AND operation IS NOT NULL AND principal_id IS NOT NULL AND identity IS NULL)),
  CHECK (kind = 'maintenance' OR identity IS NOT NULL)
);
CREATE INDEX storage_events_kind ON storage_events(brain, kind, identity, seq);
CREATE UNIQUE INDEX storage_events_receipt ON storage_events(brain, receipt, phase) WHERE receipt IS NOT NULL;
-- The last scope each capacity was observed with, whatever its evidence quality,
-- so scope events chain from it. Tracking only: at most 16 capacities per brain,
-- the least recently observed forgotten first; no event is derived from a guess.
CREATE TABLE storage_event_scopes (
  brain TEXT NOT NULL CHECK (length(brain) = 32),
  identity TEXT NOT NULL CHECK (length(identity) = 32),
  root_scope TEXT NOT NULL CHECK (length(root_scope) = 32),
  at INTEGER NOT NULL CHECK (at >= 0),
  PRIMARY KEY (brain, identity)
);
-- A kind paused before its limit because the evidence that times it was dropped
-- (more owner reports in one history write than the timeline keeps). Permanent,
-- like a full kind: no later event of the kind could be timed reliably.
CREATE TABLE storage_event_pauses (
  brain TEXT NOT NULL CHECK (length(brain) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('pressure', 'refusal', 'scope', 'maintenance')),
  at INTEGER NOT NULL CHECK (at >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('owner-evidence-overflow')),
  PRIMARY KEY (brain, kind)
);
