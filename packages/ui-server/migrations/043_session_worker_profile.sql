-- Session preferences are operational state; in-brain policy remains authoritative.
CREATE TABLE session_worker_profiles (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  preference TEXT NOT NULL CHECK (preference IN ('governed', 'strict')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  actual_profile TEXT CHECK (actual_profile IN ('governed', 'strict')),
  origin TEXT NOT NULL DEFAULT 'interactive' CHECK (origin IN ('interactive', 'voice'))
);
-- Existing client draft identity, not a session allocation or reservation.
CREATE TABLE draft_worker_profiles (
  principal_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  preference TEXT NOT NULL CHECK (preference IN ('governed', 'strict')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, draft_id)
);
