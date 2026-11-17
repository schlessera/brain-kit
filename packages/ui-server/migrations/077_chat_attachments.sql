-- Composer file attachments (#3153, docs/plans/chat-attachments.md §6). The
-- originals live under .brain-ui/attachments/<file_id>/; these rows are the
-- authoritative ownership and accounting records. Operational state, never
-- brain.db.
--
-- A file is minted for one draft (its lineage). Only that draft's revision,
-- its outgoing snapshot and the messages sent from it may reference it.
CREATE TABLE attachment_files (
  file_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  stored_name TEXT NOT NULL,
  incoming_name TEXT,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'text', 'track', 'image', 'archive', 'binary')),
  reader TEXT NOT NULL CHECK (reader IN ('pdf', 'text', 'track', 'image', 'none')),
  track_rejected INTEGER NOT NULL DEFAULT 0 CHECK (track_rejected IN (0, 1)),
  track_json TEXT,
  state TEXT NOT NULL DEFAULT 'stored' CHECK (state IN ('stored', 'deleting', 'missing')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  -- 1 once any reference has named the file; selects the 1 h or 7 d window.
  ever_referenced INTEGER NOT NULL DEFAULT 0 CHECK (ever_referenced IN (0, 1)),
  -- Set in the transaction that removed the last reference; NULL while referenced.
  unreferenced_since INTEGER
);
CREATE INDEX attachment_files_draft ON attachment_files(draft_id);

-- owner 'draft': owner_id = draft id (the current revision's binding);
-- 'outgoing': draft id ":" request id (a held or unconfirmed snapshot);
-- 'message': session id ":" turn id (an accepted send).
CREATE TABLE attachment_refs (
  file_id TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('draft', 'outgoing', 'message')),
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, owner, owner_id)
);
CREATE INDEX attachment_refs_owner ON attachment_refs(owner, owner_id);

-- In-flight uploads, charged to the pool until their bytes are stored.
CREATE TABLE attachment_reservations (
  reservation_id TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  instance_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Idempotency receipts for composer uploads; same shape as draft receipts.
CREATE TABLE attachment_receipts (
  draft_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (draft_id, idempotency_key)
);

-- A draft's one durable outgoing snapshot (JSON DraftOutgoing), or NULL.
ALTER TABLE session_drafts ADD COLUMN outgoing_json TEXT;
-- File ids the current revision binds, in display order.
ALTER TABLE session_drafts ADD COLUMN file_ids TEXT NOT NULL DEFAULT '[]';

-- Composer originals a recorded user message referenced, for replay.
ALTER TABLE message_sources ADD COLUMN attachment_files TEXT;
