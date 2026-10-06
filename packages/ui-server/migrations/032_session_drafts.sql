-- Per-session composer drafts stored on the host (#979, D52 §5-6). Unsent
-- operational UI state: never canonical Markdown and never brain.db. One
-- namespace per host database; every principal of the host shares it.
--
-- A deleted or sent draft keeps its row as a tombstone (deleted_at set,
-- text and attachments gone) so a stale save, delayed acknowledgement or
-- replay cannot resurrect it: revisions only ever grow.
CREATE TABLE session_drafts (
  draft_id TEXT PRIMARY KEY,
  session_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  text TEXT NOT NULL DEFAULT '',
  -- JSON array of attachment ids, in display order.
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  -- UTF-8 text bytes plus referenced attachment bytes.
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted_at INTEGER,
  -- 'deleted' (DELETE) or 'sent' (consumed by an accepted chat message).
  deleted_reason TEXT CHECK (deleted_reason IN ('deleted', 'sent'))
);
CREATE INDEX session_drafts_live ON session_drafts(updated_at) WHERE deleted_at IS NULL;

-- Uploaded image bytes. `attached` is 1 while the current revision lists the
-- attachment; an upload not yet referenced stays 0 until a save names it, and
-- is swept an hour after upload if no save ever does.
CREATE TABLE session_draft_attachments (
  attachment_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  name TEXT,
  bytes BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  attached INTEGER NOT NULL DEFAULT 0 CHECK (attached IN (0, 1)),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX session_draft_attachments_draft ON session_draft_attachments(draft_id);
CREATE INDEX session_draft_attachments_pending ON session_draft_attachments(created_at) WHERE attached = 0;

-- Idempotency receipts for successful saves and uploads. A retried key with
-- the same request returns the stored response; a different request under
-- the same key is refused.
CREATE TABLE session_draft_receipts (
  draft_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('save', 'attachment')),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  PRIMARY KEY (draft_id, operation, idempotency_key)
);

-- Accepted first messages of new conversations that carried a draft, so a
-- delayed acknowledgement can bind that draft (and only that draft) to the
-- session the host actually created for it.
CREATE TABLE session_draft_sends (
  draft_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (draft_id, request_id)
);
