-- Retired chat identities (#3228). Content-free and permanent within the
-- installation: no prompt, result, title, recognition, attachment, hash of
-- short text or free-form error is stored here. Nothing references a content
-- table, so no content cascade or retention eviction can remove a fence.
-- One row per retired chat: its canonical identity (a backend session ID, or
-- a provisional dialogue owner ID), exact owner and terminal generation.
CREATE TABLE chat_lifecycles (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'provisional')),
  principal_id TEXT NOT NULL,
  backend_id TEXT,
  generation INTEGER NOT NULL CHECK (generation > 1),
  operation_id TEXT NOT NULL UNIQUE,
  retired_at INTEGER NOT NULL
);
-- Every identity the retirement consumed: negative lookups that refuse
-- adoption, admission, writes and replay under any of them.
CREATE TABLE chat_retired_identities (
  kind TEXT NOT NULL CHECK (kind IN ('session', 'dialogue_owner', 'conversation', 'task', 'request', 'native_task')),
  id TEXT NOT NULL,
  lifecycle_id TEXT NOT NULL REFERENCES chat_lifecycles(id),
  PRIMARY KEY (kind, id)
);
CREATE INDEX chat_retired_identities_lifecycle ON chat_retired_identities(lifecycle_id);
-- Per-store cleanup under the retirement's intent. Only store categories and
-- outcomes; completion needs every selected store to confirm removal.
CREATE TABLE chat_retirement_stores (
  lifecycle_id TEXT NOT NULL REFERENCES chat_lifecycles(id),
  store TEXT NOT NULL CHECK (store IN ('native', 'dialogue', 'tasks', 'projections', 'drafts')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'partial', 'unknown', 'removed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lifecycle_id, store)
);
CREATE TRIGGER chat_lifecycles_permanent BEFORE DELETE ON chat_lifecycles
BEGIN SELECT RAISE(ABORT, 'chat lifecycle fences are permanent'); END;
CREATE TRIGGER chat_lifecycles_terminal BEFORE UPDATE ON chat_lifecycles
BEGIN SELECT RAISE(ABORT, 'chat lifecycle fences are permanent'); END;
CREATE TRIGGER chat_retired_identities_permanent BEFORE DELETE ON chat_retired_identities
BEGIN SELECT RAISE(ABORT, 'chat lifecycle fences are permanent'); END;
CREATE TRIGGER chat_retired_identities_fixed BEFORE UPDATE ON chat_retired_identities
BEGIN SELECT RAISE(ABORT, 'chat lifecycle fences are permanent'); END;
CREATE TRIGGER chat_retirement_stores_permanent BEFORE DELETE ON chat_retirement_stores
BEGIN SELECT RAISE(ABORT, 'chat lifecycle fences are permanent'); END;
-- A confirmed removal is never reopened; other outcomes may only move forward.
CREATE TRIGGER chat_retirement_stores_removed BEFORE UPDATE ON chat_retirement_stores
WHEN OLD.outcome = 'removed' AND NEW.outcome != 'removed'
BEGIN SELECT RAISE(ABORT, 'a confirmed store removal cannot be reopened'); END;
