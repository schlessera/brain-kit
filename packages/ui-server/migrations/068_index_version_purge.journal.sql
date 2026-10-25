-- Progress of the one-time purge of index-family bytes retained before #2873
-- (#2903): 0 not run, 1 versions made metadata-only and their pins dropped,
-- 2 the objects they left unreferenced collected. The journal runs it at open.
ALTER TABLE journal.turn_journal_allocation ADD COLUMN index_purge INTEGER NOT NULL DEFAULT 0;
