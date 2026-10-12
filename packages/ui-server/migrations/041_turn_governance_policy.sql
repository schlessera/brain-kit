-- Per-admission policy identity, including strict turns. Journal integration
-- consumes this immutable receipt; invalid edit diagnostics are host state.
CREATE TABLE turn_governance_policy (
  turn_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('interactive', 'voice')),
  profile TEXT NOT NULL CHECK (profile IN ('governed', 'strict')),
  policy_hash TEXT,
  source TEXT NOT NULL CHECK (source IN ('policy', 'default', 'last_valid')),
  policy TEXT NOT NULL,
  errors TEXT NOT NULL,
  admitted_at INTEGER NOT NULL
);
