-- Journal writes without per-write WAL truncation (#2789). `writing` is set
-- only inside an accounted write and is cleared before that write commits;
-- connection-local triggers refuse journal rows changed while it is clear.
ALTER TABLE turn_journal_allocation ADD COLUMN writing INTEGER NOT NULL DEFAULT 0;
