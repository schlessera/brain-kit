-- Untraced configuration inputs are a property of the brain's configuration,
-- not of a turn (#3257): each distinct set is stored once, keyed by the
-- SHA-256 of its sorted path list, and a turn references it. The empty set is
-- a set like any other, so a turn that recorded none stays distinguishable
-- from one that recorded nothing (NULL).
--
-- The journal moves the per-turn arrays of `steering_inventory_missing` into
-- sets at open, in code, because SQLite cannot hash. Until it has, readers
-- still understand the array; a legacy `'[]'` stays "no set recorded".
-- An ordinary rowid table, as every journal table is: the operational backup
-- copies and compares rows in rowid order.
CREATE TABLE journal.turn_journal_configuration_sets (
  hash TEXT PRIMARY KEY,
  paths TEXT NOT NULL,
  count INTEGER NOT NULL
);
ALTER TABLE journal.turn_journal_turns ADD COLUMN configuration_set TEXT REFERENCES turn_journal_configuration_sets(hash);
-- Capture takes the configuration inventory only for an observation that saw
-- a change. A turn whose observations never took it records the empty set for
-- its own coverage, but says nothing about the brain's current set.
ALTER TABLE journal.turn_journal_turns ADD COLUMN configuration_inventoried INTEGER NOT NULL DEFAULT 0;
CREATE INDEX journal.turn_journal_turns_configuration_set ON turn_journal_turns(configuration_set);
-- A set lives exactly as long as a turn references it, whichever path removes
-- or re-points the turn.
CREATE TRIGGER journal.turn_journal_configuration_set_release AFTER DELETE ON turn_journal_turns
WHEN OLD.configuration_set IS NOT NULL BEGIN
  DELETE FROM turn_journal_configuration_sets WHERE hash = OLD.configuration_set
    AND NOT EXISTS (SELECT 1 FROM turn_journal_turns WHERE configuration_set = OLD.configuration_set);
END;
CREATE TRIGGER journal.turn_journal_configuration_set_replace AFTER UPDATE OF configuration_set ON turn_journal_turns
WHEN OLD.configuration_set IS NOT NULL AND OLD.configuration_set IS NOT NEW.configuration_set BEGIN
  DELETE FROM turn_journal_configuration_sets WHERE hash = OLD.configuration_set
    AND NOT EXISTS (SELECT 1 FROM turn_journal_turns WHERE configuration_set = OLD.configuration_set);
END;
