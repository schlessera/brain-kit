-- Loss generations (#4351): one row per chat ('session:<id>'), per turn
-- ('turn:<id>') and for the whole brain ('brain'). Every contained write
-- loss increments its rows; nothing ever lowers or filters them, so an
-- answered Network card can tell that any new loss happened after it opened.
CREATE TABLE safety_loss_generations (
  key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
) WITHOUT ROWID;
