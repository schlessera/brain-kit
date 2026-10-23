-- Managed worktree hygiene (#2431). Worktrees are volatile hosting state, so
-- their findings and dispositions live here, never in the brain's Markdown
-- hygiene log. Cleanup receipts record each destructive effect once.
ALTER TABLE reference_worktrees ADD COLUMN root_uuid TEXT;  -- native identity recorded at allocation
CREATE TABLE reference_worktree_findings (
  id                      TEXT PRIMARY KEY NOT NULL,  -- core hygieneId over the worktree's logical path
  worktree_id             TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('retained', 'unknown', 'cleanup-failed')),
  state                   TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'snoozed', 'resolved')),
  fingerprint             TEXT NOT NULL,              -- last detected evidence fingerprint
  fields_json             TEXT NOT NULL,              -- each fingerprint field's hash, so invalidation can name changes
  first_seen              INTEGER NOT NULL,
  last_seen               INTEGER NOT NULL,
  disposition_fingerprint TEXT,                       -- the fingerprint a dismissal or snooze applies to
  disposition_fields_json TEXT,
  disposed_at             INTEGER,
  due_at                  INTEGER,                    -- snooze due time
  reason                  TEXT,
  invalidation_json       TEXT,                       -- why a disposition stopped applying
  resolved_by             TEXT,
  resolved_at             INTEGER
);
CREATE INDEX reference_worktree_findings_worktree ON reference_worktree_findings (worktree_id);
CREATE TABLE reference_worktree_cleanups (
  worktree_id TEXT PRIMARY KEY NOT NULL,
  trigger     TEXT NOT NULL CHECK (trigger IN ('automatic', 'review')),
  state       TEXT NOT NULL CHECK (state IN ('started', 'deleted', 'reclaimed', 'failed', 'interrupted')),
  premise     TEXT NOT NULL,                          -- fingerprint or eligibility the effect was admitted under
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  error       TEXT
);
