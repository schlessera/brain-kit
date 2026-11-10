-- Retain the first I/O failure with its still-charged reservation. Recovery
-- deletes both together only after it establishes the object's actual state.
ALTER TABLE journal.turn_journal_reservations ADD COLUMN recovery_failure TEXT;
