-- One operational review, using the shared inbox Actions and change cursors.
CREATE TABLE hygiene_review (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
);
CREATE TABLE hygiene_action_revisions (
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  version INTEGER NOT NULL,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  PRIMARY KEY (item_id, version)
);
CREATE TRIGGER hygiene_revision_no_update BEFORE UPDATE ON hygiene_action_revisions
BEGIN SELECT RAISE(ABORT, 'Immutable hygiene revision'); END;
CREATE TRIGGER hygiene_revision_no_delete BEFORE DELETE ON hygiene_action_revisions
BEGIN SELECT RAISE(ABORT, 'Retained hygiene revision'); END;
CREATE TABLE hygiene_effect_attempts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  principal_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  wait_until INTEGER,
  status TEXT NOT NULL CHECK (status IN ('started', 'finished')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE UNIQUE INDEX hygiene_one_effect ON hygiene_effect_attempts(item_id) WHERE status = 'started';
CREATE TRIGGER hygiene_attempt_identity_immutable BEFORE UPDATE ON hygiene_effect_attempts
WHEN NEW.id != OLD.id OR NEW.item_id != OLD.item_id OR NEW.principal_id != OLD.principal_id
  OR NEW.request_json != OLD.request_json OR NEW.effect_json != OLD.effect_json
  OR NEW.wait_until IS NOT OLD.wait_until OR OLD.status = 'finished'
BEGIN SELECT RAISE(ABORT, 'Immutable hygiene attempt'); END;
CREATE TRIGGER hygiene_attempt_no_delete BEFORE DELETE ON hygiene_effect_attempts
BEGIN SELECT RAISE(ABORT, 'Retained hygiene attempt'); END;
