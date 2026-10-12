-- Explicit retained observation links; no inferred exclusive writer ownership.
ALTER TABLE turn_journal_changes ADD COLUMN conflict_observations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE turn_journal_revert_operations ADD COLUMN selection TEXT NOT NULL DEFAULT '{}';
