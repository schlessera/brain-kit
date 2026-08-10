-- Generic server-side settings, stored as a JSON-per-key KV table so a new
-- preference does not need its own migration.
--
-- Keys in use:
--   models.hidden  -> string[] of profile ids kept out of the model picker
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
