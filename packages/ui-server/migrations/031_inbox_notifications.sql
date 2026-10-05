-- Durable Action notices (U9). Authoritative operational state: it survives
-- restart and the operational backup, and never lives in disposable brain.db.
-- Persisted instants are UTC milliseconds from the server clock; a reported
-- zone only selects civil-time schedules and never grants authority.

-- The last zone a destination reported. NULL means missing or unusable
-- metadata: timed notices for that device stay pending until a refresh.
ALTER TABLE push_subscriptions ADD COLUMN time_zone TEXT;
ALTER TABLE push_subscriptions ADD COLUMN time_zone_reported_at INTEGER;

-- An authenticated client context: the principal plus the client's own
-- persisted identifier, because one principal can serve several browsers
-- (ambient and proxy modes share one). It owns the last reported zone, its
-- in-app digest coverage and its own dismissal. No foreign key, so principal
-- retention pruning keeps working; authority is rechecked at every use.
CREATE TABLE inbox_notice_clients (
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  time_zone TEXT,
  reported_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  PRIMARY KEY (principal_id, client_id)
);

-- A waiting episode starts when a decision becomes pending: a new Action or an
-- explicit snooze-to-pending reactivation. Clock, version, retry and restart
-- never start one. At most one open episode per Action.
CREATE TABLE inbox_notice_episodes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (item_id, ordinal)
);
CREATE UNIQUE INDEX inbox_notice_episodes_open ON inbox_notice_episodes(item_id) WHERE ended_at IS NULL;
CREATE TRIGGER inbox_notice_episode_identity BEFORE UPDATE ON inbox_notice_episodes
WHEN NEW.id IS NOT OLD.id OR NEW.item_id IS NOT OLD.item_id OR NEW.thread_id IS NOT OLD.thread_id OR
  NEW.ordinal IS NOT OLD.ordinal OR NEW.started_at IS NOT OLD.started_at OR OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Immutable notice episode'); END;
CREATE TRIGGER inbox_notice_episode_no_delete BEFORE DELETE ON inbox_notice_episodes
BEGIN SELECT RAISE(ABORT, 'Retained notice episode'); END;
-- Decisions already waiting when this migration runs begin their episode now.
INSERT INTO inbox_notice_episodes (id, item_id, thread_id, ordinal, started_at)
SELECT id || '#1', id, thread_id, 1, CAST(json_extract(data_json, '$.updatedAt') AS INTEGER)
FROM inbox_items
WHERE queue = 'actions' AND type != 'fyi' AND status = 'pending' AND deleted_at IS NULL;

-- A fixed 60-second push window per recipient principal + channel + class.
-- Thread identity is kept on each constituent, not in the grouping key.
CREATE TABLE inbox_notice_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'push'),
  delivery_class TEXT NOT NULL CHECK (delivery_class = 'push'),
  opened_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL CHECK (due_at > opened_at)
);
CREATE INDEX inbox_notice_batches_principal ON inbox_notice_batches(principal_id, due_at);
CREATE TRIGGER inbox_notice_batch_no_update BEFORE UPDATE ON inbox_notice_batches
BEGIN SELECT RAISE(ABORT, 'Immutable notice batch'); END;
CREATE TRIGGER inbox_notice_batch_no_delete BEFORE DELETE ON inbox_notice_batches
BEGIN SELECT RAISE(ABORT, 'Retained notice batch'); END;

-- An episode joins at most one push aggregate per recipient principal.
CREATE TABLE inbox_notice_constituents (
  batch_id INTEGER NOT NULL REFERENCES inbox_notice_batches(id),
  episode_id TEXT NOT NULL REFERENCES inbox_notice_episodes(id),
  principal_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, episode_id),
  UNIQUE (principal_id, episode_id)
);
CREATE TRIGGER inbox_notice_constituent_no_update BEFORE UPDATE ON inbox_notice_constituents
BEGIN SELECT RAISE(ABORT, 'Immutable notice constituent'); END;
CREATE TRIGGER inbox_notice_constituent_no_delete BEFORE DELETE ON inbox_notice_constituents
BEGIN SELECT RAISE(ABORT, 'Retained notice constituent'); END;

-- Per-destination attempt history. The destination is a SHA-256 of the push
-- endpoint, so history never holds a device capability URL or key. Payload and
-- count are frozen at submission; only an in-flight outcome may settle once.
-- 'success' means the push service accepted the submission, never display or
-- reading. 'ambiguous' means the request may have reached the service.
CREATE TABLE inbox_notice_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destination TEXT NOT NULL CHECK (length(destination) = 64),
  principal_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('in_flight', 'success', 'failed', 'ambiguous', 'gone')),
  settled_at INTEGER,
  count INTEGER NOT NULL CHECK (count >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX inbox_notice_attempts_destination ON inbox_notice_attempts(destination, attempted_at);
CREATE TRIGGER inbox_notice_attempt_frozen BEFORE UPDATE ON inbox_notice_attempts
WHEN OLD.outcome != 'in_flight' OR NEW.id IS NOT OLD.id OR NEW.destination IS NOT OLD.destination OR
  NEW.principal_id IS NOT OLD.principal_id OR NEW.attempted_at IS NOT OLD.attempted_at OR
  NEW.count IS NOT OLD.count OR NEW.payload_json IS NOT OLD.payload_json
BEGIN SELECT RAISE(ABORT, 'Immutable notice attempt'); END;
CREATE TRIGGER inbox_notice_attempt_no_delete BEFORE DELETE ON inbox_notice_attempts
BEGIN SELECT RAISE(ABORT, 'Retained notice attempt'); END;

CREATE TABLE inbox_notice_attempt_components (
  attempt_id INTEGER NOT NULL REFERENCES inbox_notice_attempts(id),
  episode_id TEXT NOT NULL REFERENCES inbox_notice_episodes(id),
  batch_id INTEGER NOT NULL REFERENCES inbox_notice_batches(id),
  PRIMARY KEY (attempt_id, episode_id)
);
CREATE INDEX inbox_notice_attempt_components_episode ON inbox_notice_attempt_components(episode_id);
CREATE TRIGGER inbox_notice_component_no_update BEFORE UPDATE ON inbox_notice_attempt_components
BEGIN SELECT RAISE(ABORT, 'Immutable notice component'); END;
CREATE TRIGGER inbox_notice_component_no_delete BEFORE DELETE ON inbox_notice_attempt_components
BEGIN SELECT RAISE(ABORT, 'Retained notice component'); END;

-- One stored in-app summary per client context and civil-time slot. Coverage
-- commits in the same transaction, so no generation consumes work without
-- its stored result.
CREATE TABLE inbox_notice_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  slot_at INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  UNIQUE (principal_id, client_id, slot_at)
);
CREATE TRIGGER inbox_notice_digest_no_update BEFORE UPDATE ON inbox_notice_digests
BEGIN SELECT RAISE(ABORT, 'Immutable notice digest'); END;

CREATE TABLE inbox_notice_coverage (
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('episode', 'fyi')),
  subject_id TEXT NOT NULL,
  digest_id INTEGER NOT NULL REFERENCES inbox_notice_digests(id),
  PRIMARY KEY (principal_id, client_id, subject_kind, subject_id)
);
CREATE TRIGGER inbox_notice_coverage_no_update BEFORE UPDATE ON inbox_notice_coverage
BEGIN SELECT RAISE(ABORT, 'Immutable notice coverage'); END;
