-- Machine-readable sandbox and governance interventions (#1651). Host
-- operational state, never brain content: kept with the session's catalog row
-- rather than with the pruned Activity span detail, and deleted with it.
-- `session_id` is NULL until the session's catalog row exists; the turn's
-- first `session_info` binds it (src/governance/events.ts).
CREATE TABLE governance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  actor TEXT NOT NULL CHECK (actor IN ('interactive', 'voice', 'autonomous', 'user', 'server', 'external')),
  model TEXT,
  profile TEXT CHECK (profile IS NULL OR profile IN ('governed', 'strict', 'restricted')),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  dedupe_key TEXT
);

CREATE INDEX idx_governance_events_session ON governance_events(session_id, id);
CREATE INDEX idx_governance_events_turn ON governance_events(turn_id, id);
CREATE INDEX idx_governance_events_kind ON governance_events(kind, id);
CREATE INDEX idx_governance_events_unbound ON governance_events(at) WHERE session_id IS NULL;
CREATE UNIQUE INDEX idx_governance_events_dedupe ON governance_events(kind, dedupe_key) WHERE dedupe_key IS NOT NULL;
