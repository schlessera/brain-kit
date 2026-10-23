-- Managed reference worktrees (#2430). Ownership, explicit activity and
-- cleanup eligibility are durable host facts; the native pool's intents stay
-- the authority for storage. Nothing here deletes a worktree.
CREATE TABLE reference_worktrees (
  id            TEXT PRIMARY KEY NOT NULL,  -- pool identity of the writable worktree
  principal_id  TEXT NOT NULL,              -- owning principal; access never crosses it
  domain        TEXT NOT NULL,              -- 'public' or 'private:<principal id>' of its source
  repository    TEXT NOT NULL,              -- canonical repository
  revision      TEXT NOT NULL,              -- branch or tag the base came from
  base_commit   TEXT,                       -- fixed reported starting commit
  source_root   TEXT NOT NULL,              -- sealed pool root it was snapshotted from
  baseline      TEXT,                       -- read-only checkpoint taken at creation
  allowance     INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('creating', 'active', 'released', 'expired')),
  created_at    INTEGER NOT NULL,
  accessed_at   INTEGER NOT NULL,           -- last explicit access, resumption or renewal only
  released_at   INTEGER,
  holder        TEXT,                       -- access generation currently holding it
  cleanup       TEXT                        -- JSON eligibility facts from release or expiry
);
CREATE INDEX reference_worktrees_source ON reference_worktrees (source_root);
CREATE TABLE reference_worktree_generations (
  id                  TEXT PRIMARY KEY NOT NULL,  -- native access generation
  principal_id        TEXT NOT NULL,
  turn_id             TEXT NOT NULL,
  profile             TEXT NOT NULL CHECK (profile IN ('governed', 'strict')),
  path                TEXT NOT NULL,              -- manager-reported directory a worker binds
  owner_pid           INTEGER NOT NULL,
  owner_start         TEXT NOT NULL,
  owner_boot          TEXT NOT NULL,
  owner_pid_namespace TEXT NOT NULL,
  opened_at           INTEGER NOT NULL,
  closed_at           INTEGER
);
