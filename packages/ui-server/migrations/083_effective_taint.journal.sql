-- Historical rows retain their original attribution. Only new observations
-- capture effective restriction, including unknown coverage with no source row.
ALTER TABLE journal.turn_journal_changes ADD COLUMN effective_taint INTEGER CHECK (effective_taint IN (0,1));
