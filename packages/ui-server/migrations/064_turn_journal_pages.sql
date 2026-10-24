-- Every page a journal commit has written since the last exact measurement
-- (#2789). A journal write learns the pages its commit wrote from that
-- commit's WAL frames and charges them, so admission no longer walks the
-- database. `charged_pages` counts the rows; NULL until a ledger first walks.
CREATE TABLE turn_journal_pages (pageno INTEGER PRIMARY KEY);
ALTER TABLE turn_journal_allocation ADD COLUMN charged_pages INTEGER;
