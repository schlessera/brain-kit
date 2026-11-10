-- Safety-recording failures are contained to what they put at risk and keep
-- their cause (#3812, #3810).
--
-- A collection begun while the brain-wide recorder was failed carries a
-- permanent pre-delivery gap: losing more of its evidence cannot weaken
-- anything, so it runs under its tainted policy instead of being refused.
ALTER TABLE safety_collections ADD COLUMN restricted_begin INTEGER NOT NULL DEFAULT 0;
-- The first cause of a chat-scoped failure: identifiers and error text only.
ALTER TABLE safety_collections ADD COLUMN failure_cause TEXT;
-- The first cause of the brain-wide latch. Later latches only count.
CREATE TABLE safety_latch (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  since INTEGER NOT NULL, reason TEXT NOT NULL, site TEXT NOT NULL, turn_id TEXT,
  error_class TEXT NOT NULL, message TEXT NOT NULL, stack TEXT, count INTEGER NOT NULL DEFAULT 1,
  -- Some latched loss named no chat: recovery must gap every collection.
  unscoped INTEGER NOT NULL DEFAULT 0,
  -- The safety revision when this latch was set. Only a collection begun
  -- restricted after it may run beside its automatic recovery; every earlier
  -- producer, even one begun restricted under an earlier latch, drains first.
  revision TEXT NOT NULL DEFAULT '0'
);
-- A latch already set before this migration has no recorded cause.
INSERT INTO safety_latch(singleton,since,reason,site,turn_id,error_class,message,stack,revision)
  SELECT 1,0,COALESCE(reason,'recording_failed'),'unknown',NULL,'unknown','The latch predates cause recording.',NULL,revision
  FROM safety_meta WHERE singleton=1 AND failed=1;
-- Every recovery: who or what cleared the latch, when, and the cause it cleared.
CREATE TABLE safety_recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('boot','automatic','owner')), actor TEXT NOT NULL,
  scope TEXT NOT NULL, cause TEXT, gapped INTEGER NOT NULL
);
-- A tool call admitted before it runs owes its result's record. Its row is
-- the obligation: it goes when that record is durable, or when the backend
-- refuses the call, which proves it never ran. A row still here when its
-- collection ends, or at boot, leaves that chat a permanent gap.
CREATE TABLE safety_obligations (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES safety_collections(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL, tool TEXT NOT NULL, opened_at INTEGER NOT NULL
);
CREATE INDEX safety_obligations_collection ON safety_obligations(collection_id);
