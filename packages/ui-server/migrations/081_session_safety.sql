-- Host evidence, independent of Activity detail and provider transcripts.
CREATE TABLE safety_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0, reason TEXT,
  used_rows INTEGER NOT NULL DEFAULT 0, used_bytes INTEGER NOT NULL DEFAULT 0,
  scope_rows INTEGER NOT NULL DEFAULT 0, scope_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO safety_meta(singleton,revision) VALUES(1,'0');
CREATE TABLE safety_sessions (
  session_id TEXT PRIMARY KEY, history_owner_id TEXT NOT NULL, generation TEXT NOT NULL,
  principal_id TEXT, origin_turn TEXT, classification TEXT NOT NULL, backend_id TEXT
);
INSERT INTO safety_sessions
 SELECT s.id,COALESCE(d.id,lower(hex(randomblob(16)))),CAST(COALESCE(d.generation,1) AS TEXT),
 COALESCE(d.principal_id,o.principal_id),NULL,'legacy',s.backend_id
 FROM sessions s LEFT JOIN dialogue_owners d ON d.session_id=s.id LEFT JOIN chat_session_owners o ON o.session_id=s.id;
CREATE TRIGGER safety_catalog_capacity BEFORE INSERT ON sessions
 WHEN NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.id) AND
 (SELECT used_rows+scope_rows+1>1000000 OR used_bytes+scope_bytes+2048>536870912 FROM safety_meta WHERE singleton=1)
 BEGIN SELECT RAISE(ABORT,'safety identity capacity exhausted'); END;
CREATE TRIGGER safety_catalog_discovery AFTER INSERT ON sessions BEGIN
 INSERT INTO safety_sessions VALUES(NEW.id,lower(hex(randomblob(16))),'1',NULL,NULL,'discovered',NEW.backend_id);
 UPDATE safety_meta SET scope_rows=scope_rows+1,scope_bytes=scope_bytes+2048 WHERE singleton=1;
END;
CREATE TABLE safety_collections (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE, session_id TEXT,
  principal_id TEXT, history_owner_id TEXT, generation TEXT NOT NULL DEFAULT '1',
  backend_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
  acknowledged TEXT NOT NULL DEFAULT '[]', gap TEXT, failure TEXT,
  policy_hash TEXT, start_revision TEXT NOT NULL, end_revision TEXT
);
CREATE INDEX safety_collections_session ON safety_collections(session_id);
CREATE TABLE safety_records (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES safety_collections(id),
  sequence TEXT NOT NULL UNIQUE, observed_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('occurrence','exposure')), occurrence_id TEXT NOT NULL,
  source TEXT, detector TEXT, state TEXT, payload TEXT NOT NULL,
  bytes INTEGER NOT NULL, reserved_rows INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL,
  detail_pruned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX safety_records_collection ON safety_records(collection_id,sequence);
CREATE INDEX safety_records_occurrence ON safety_records(occurrence_id,kind);
-- Empty foundation for #3601's independently authorized append path. This
-- slice supplies no decision writer, review endpoint or clearing capability.
CREATE TABLE safety_decisions (
  id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE REFERENCES safety_records(id),
  session_id TEXT NOT NULL, history_owner_id TEXT NOT NULL, generation TEXT NOT NULL,
  sequence TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  decided_at INTEGER NOT NULL, verdict TEXT NOT NULL CHECK(verdict='safe'),
  channel TEXT NOT NULL CHECK(channel IN ('owner_settings','owner_history'))
);
CREATE TABLE safety_pending (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES safety_collections(id),
  bytes INTEGER NOT NULL, rows INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL
);
CREATE INDEX safety_pending_collection ON safety_pending(collection_id);
-- Classify even legacy sessions with NO old taint. Old rows prove their own
-- occurrence only; no absence of later input can be reconstructed from them.
INSERT INTO safety_collections(id,turn_id,session_id,principal_id,history_owner_id,generation,backend_id,started_at,ended,gap,start_revision,end_revision)
 SELECT lower(hex(randomblob(16))),'legacy_'||lower(hex(randomblob(16))),session_id,principal_id,history_owner_id,generation,
 COALESCE(backend_id,'unknown'),0,1,'missing_historical_signals','0','0' FROM safety_sessions;
CREATE TRIGGER safety_decisions_immutable BEFORE UPDATE ON safety_decisions BEGIN SELECT RAISE(ABORT,'immutable safety decision'); END;
CREATE TRIGGER safety_records_immutable BEFORE UPDATE ON safety_records
 WHEN NEW.id!=OLD.id OR NEW.collection_id!=OLD.collection_id OR NEW.sequence!=OLD.sequence
 OR NEW.kind!=OLD.kind OR NEW.occurrence_id!=OLD.occurrence_id OR NEW.source IS NOT OLD.source
 OR NEW.detector IS NOT OLD.detector OR NEW.state IS NOT OLD.state
 OR NEW.reserved_rows!=OLD.reserved_rows OR NEW.reserved_bytes!=OLD.reserved_bytes
 BEGIN SELECT RAISE(ABORT,'immutable safety identity'); END;
CREATE TABLE safety_legacy_events (event_id INTEGER PRIMARY KEY, record_id TEXT NOT NULL);
CREATE TABLE safety_bindings (binding_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,history_owner_id TEXT NOT NULL,generation TEXT NOT NULL,sequence TEXT NOT NULL);
CREATE TABLE safety_emergency_reserve (singleton INTEGER PRIMARY KEY CHECK(singleton=1),padding BLOB NOT NULL);
INSERT INTO safety_emergency_reserve VALUES(1,zeroblob(65536));
-- Permanent negative turn identities for retired provisional chats too.
CREATE TABLE safety_retired_turns (turn_id TEXT PRIMARY KEY,lifecycle_id TEXT NOT NULL REFERENCES chat_lifecycles(id));
CREATE TRIGGER safety_retired_turns_permanent BEFORE DELETE ON safety_retired_turns BEGIN SELECT RAISE(ABORT,'permanent safety retirement fence'); END;
CREATE TRIGGER safety_retired_turns_fixed BEFORE UPDATE ON safety_retired_turns BEGIN SELECT RAISE(ABORT,'permanent safety retirement fence'); END;
-- Provisional retained histories are legacy too, even before a native session exists.
INSERT INTO safety_collections(id,turn_id,session_id,principal_id,history_owner_id,generation,backend_id,started_at,ended,gap,start_revision,end_revision)
 SELECT lower(hex(randomblob(16))),'legacy_'||lower(hex(randomblob(16))),NULL,principal_id,id,CAST(generation AS TEXT),
 'unknown',created_at,1,'missing_historical_signals','0','0' FROM dialogue_owners WHERE session_id IS NULL;

-- Account compact epoch/binding/future fence metadata as well as detail rows.
UPDATE safety_meta SET scope_rows=(SELECT COUNT(*) FROM safety_sessions)+(SELECT COUNT(*) FROM safety_collections),
 scope_bytes=((SELECT COUNT(*) FROM safety_sessions)+(SELECT COUNT(*) FROM safety_collections))*2048;
-- #3601 owns authorization and publication; even its committed rows must
-- target the exact bound generation and a terminal, finalized exposure.
CREATE TRIGGER safety_decision_identity BEFORE INSERT ON safety_decisions
 WHEN NOT EXISTS (
 SELECT 1 FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
 JOIN safety_sessions s ON s.session_id=c.session_id
 WHERE r.id=NEW.occurrence_id AND r.kind='occurrence'
 AND s.session_id=NEW.session_id AND s.history_owner_id=NEW.history_owner_id AND s.generation=NEW.generation
 AND COALESCE((SELECT x.state FROM safety_records x WHERE x.occurrence_id=r.id AND x.kind='exposure'
 ORDER BY length(x.sequence) DESC,x.sequence DESC LIMIT 1),r.state)='finalized'
 ) BEGIN SELECT RAISE(ABORT,'safety decision identity or exposure mismatch'); END;
