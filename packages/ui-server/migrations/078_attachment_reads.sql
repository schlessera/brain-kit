-- One row per read_attachment call that reached an authorized original (#3154,
-- docs/plans/chat-attachments.md §5 and §7.2). They drive the UI's sent-row
-- status and are never sent to a provider. Operational state, never brain.db.
-- No extracted text is kept: there is no derived cache.
CREATE TABLE attachment_reads (
  file_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('read', 'partial', 'no_text', 'encrypted', 'malformed', 'failed', 'unavailable', 'changed')),
  -- JSON AttachmentReadResult.scope, or NULL when nothing was read.
  scope_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachment_reads_session ON attachment_reads(session_id, file_id);
CREATE INDEX attachment_reads_file ON attachment_reads(file_id);
