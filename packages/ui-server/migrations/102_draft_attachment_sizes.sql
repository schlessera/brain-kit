-- Draft byte totals and a save's attachment metadata read from an index, never
-- from rows whose image BLOB comes before the columns they need (#4803).
DROP INDEX session_draft_attachments_draft;
CREATE INDEX session_draft_attachments_sizes ON session_draft_attachments(draft_id, attachment_id, size_bytes, attached);
