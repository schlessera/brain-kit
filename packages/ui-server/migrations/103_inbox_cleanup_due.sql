-- Triage items whose thread holds no staging cleanup for their staging id yet
-- (#4897). The lifecycle sweep finds finished work to clean up from here, so
-- its candidate read no longer probes every finished item of every thread
-- whose cleanup is already queued. Derived from inbox_items alone: the
-- triggers below keep it exact, and no code writes it.
CREATE TABLE inbox_cleanup_due (
  item_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  staging_id TEXT
);
CREATE INDEX inbox_cleanup_due_thread ON inbox_cleanup_due(thread_id, staging_id);

INSERT INTO inbox_cleanup_due (item_id, thread_id, staging_id)
SELECT t.id, t.thread_id, json_extract(t.data_json, '$.payload.stagingId') FROM inbox_items t
WHERE t.queue = 'queue' AND t.type = 'triage' AND NOT EXISTS (
  SELECT 1 FROM inbox_items c WHERE c.thread_id = t.thread_id AND c.type = 'cleanup_pending'
    AND json_extract(c.data_json, '$.payload.stagingId') = json_extract(t.data_json, '$.payload.stagingId'));

-- A new triage item is due unless its thread already holds its cleanup.
CREATE TRIGGER inbox_cleanup_due_triage AFTER INSERT ON inbox_items
WHEN NEW.queue = 'queue' AND NEW.type = 'triage'
BEGIN
  INSERT INTO inbox_cleanup_due (item_id, thread_id, staging_id)
  SELECT NEW.id, NEW.thread_id, json_extract(NEW.data_json, '$.payload.stagingId')
  WHERE NOT EXISTS (
    SELECT 1 FROM inbox_items c WHERE c.thread_id = NEW.thread_id AND c.type = 'cleanup_pending'
      AND json_extract(c.data_json, '$.payload.stagingId') = json_extract(NEW.data_json, '$.payload.stagingId'));
END;

-- A new cleanup settles every triage item of its thread with its staging id.
CREATE TRIGGER inbox_cleanup_due_cleanup AFTER INSERT ON inbox_items
WHEN NEW.type = 'cleanup_pending'
BEGIN
  DELETE FROM inbox_cleanup_due
  WHERE thread_id = NEW.thread_id AND staging_id = json_extract(NEW.data_json, '$.payload.stagingId');
END;

-- The store never moves an item between threads, types or staging ids, nor
-- deletes one; if anything ever does, the threads it touches are recomputed.
CREATE TRIGGER inbox_cleanup_due_moved AFTER UPDATE OF thread_id, queue, type, data_json ON inbox_items
WHEN (OLD.type IN ('triage', 'cleanup_pending') OR NEW.type IN ('triage', 'cleanup_pending')) AND (
  OLD.thread_id IS NOT NEW.thread_id OR OLD.queue IS NOT NEW.queue OR OLD.type IS NOT NEW.type
  OR json_extract(OLD.data_json, '$.payload.stagingId') IS NOT json_extract(NEW.data_json, '$.payload.stagingId'))
BEGIN
  DELETE FROM inbox_cleanup_due WHERE thread_id IN (OLD.thread_id, NEW.thread_id);
  INSERT INTO inbox_cleanup_due (item_id, thread_id, staging_id)
  SELECT t.id, t.thread_id, json_extract(t.data_json, '$.payload.stagingId') FROM inbox_items t
  WHERE t.thread_id IN (OLD.thread_id, NEW.thread_id) AND t.queue = 'queue' AND t.type = 'triage' AND NOT EXISTS (
    SELECT 1 FROM inbox_items c WHERE c.thread_id = t.thread_id AND c.type = 'cleanup_pending'
      AND json_extract(c.data_json, '$.payload.stagingId') = json_extract(t.data_json, '$.payload.stagingId'));
END;

CREATE TRIGGER inbox_cleanup_due_deleted AFTER DELETE ON inbox_items
WHEN OLD.type IN ('triage', 'cleanup_pending')
BEGIN
  DELETE FROM inbox_cleanup_due WHERE thread_id = OLD.thread_id;
  INSERT INTO inbox_cleanup_due (item_id, thread_id, staging_id)
  SELECT t.id, t.thread_id, json_extract(t.data_json, '$.payload.stagingId') FROM inbox_items t
  WHERE t.thread_id = OLD.thread_id AND t.queue = 'queue' AND t.type = 'triage' AND NOT EXISTS (
    SELECT 1 FROM inbox_items c WHERE c.thread_id = t.thread_id AND c.type = 'cleanup_pending'
      AND json_extract(c.data_json, '$.payload.stagingId') = json_extract(t.data_json, '$.payload.stagingId'));
END;
