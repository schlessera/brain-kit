-- Continuity is checked only for allowance sessions affected by a change that
-- can restore normal state. Empty allowance storage is an O(1) fast path.
-- safetyCommit releases its pending reservation before inserting its occurrence:
-- a session restricted ONLY by that reservation loses its allowance on commit,
-- even though the same transaction ends restricted. This deliberate fail-closed
-- behavior leaves the safety store's commit ordering unchanged.
CREATE INDEX google_safety_collections_owner ON safety_collections(history_owner_id,generation,id);
CREATE INDEX google_safety_sessions_owner ON safety_sessions(history_owner_id,generation,session_id);
CREATE INDEX google_dialogue_aliases_owner ON dialogue_aliases(owner_id,id);

CREATE VIEW google_allowance_targets AS
SELECT DISTINCT a.session_id, s.classification, COALESCE(s.generation,'1') generation,
  COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=s.history_owner_id),s.history_owner_id) owner
FROM google_session_allowances a LEFT JOIN safety_sessions s ON s.session_id=a.session_id;

-- Each correlated UNION uses equality lookups and deduplicates scope membership.
-- Keep these subqueries correlated: a shared materialized scope can scan the brain.
-- Every trigger below evaluates this view, so a JSON function that throws here
-- would refuse that trigger's write, brain-wide latch recovery included (#4631).
-- One rule, shared with safetyProjection: an acknowledgement or occurrence
-- payload that single-argument json_valid rejects is unreadable, even where
-- SQLite's extractors could read it (JSON5, JSONB). Its safety scope is never
-- normal here, decided or not, and keeps its allowances. The projection throws
-- for that scope, so they cannot be used while the value remains. CASE, unlike
-- AND, guarantees no JSON function ever sees that value.
CREATE VIEW google_normal_allowance_sessions AS
SELECT t.session_id FROM google_allowance_targets t
WHERE (SELECT failed=0 AND (reason IS NULL OR reason<>'capacity') FROM safety_meta WHERE singleton=1)
  AND (t.classification IS NULL OR t.classification='new')
  AND (SELECT COUNT(*) FROM safety_collections c WHERE c.id IN (
        SELECT c.id FROM safety_collections c INDEXED BY safety_collections_session WHERE c.session_id=t.session_id
        UNION SELECT c.id FROM safety_collections c INDEXED BY google_safety_collections_owner
          WHERE c.history_owner_id=t.owner AND c.generation=t.generation
        UNION SELECT c.id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
          CROSS JOIN safety_collections c INDEXED BY google_safety_collections_owner
          ON c.history_owner_id=a.id AND c.generation=t.generation WHERE a.owner_id=t.owner)) BETWEEN 1 AND 128
  AND NOT EXISTS (
    SELECT 1 FROM safety_collections c WHERE c.id IN (
        SELECT c.id FROM safety_collections c INDEXED BY safety_collections_session WHERE c.session_id=t.session_id
        UNION SELECT c.id FROM safety_collections c INDEXED BY google_safety_collections_owner
          WHERE c.history_owner_id=t.owner AND c.generation=t.generation
        UNION SELECT c.id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
          CROSS JOIN safety_collections c INDEXED BY google_safety_collections_owner
          ON c.history_owner_id=a.id AND c.generation=t.generation WHERE a.owner_id=t.owner)
      AND (NULLIF(c.gap,'') IS NOT NULL OR NULLIF(c.failure,'') IS NOT NULL
        OR CASE WHEN json_valid(c.acknowledged) THEN json_array_length(c.acknowledged) ELSE 0 END<9))
  AND NOT EXISTS (
    SELECT 1 FROM safety_collections c
    CROSS JOIN safety_pending p INDEXED BY safety_pending_collection ON p.collection_id=c.id
    WHERE c.id IN (
        SELECT c.id FROM safety_collections c INDEXED BY safety_collections_session WHERE c.session_id=t.session_id
        UNION SELECT c.id FROM safety_collections c INDEXED BY google_safety_collections_owner
          WHERE c.history_owner_id=t.owner AND c.generation=t.generation
        UNION SELECT c.id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
          CROSS JOIN safety_collections c INDEXED BY google_safety_collections_owner
          ON c.history_owner_id=a.id AND c.generation=t.generation WHERE a.owner_id=t.owner))
  AND NOT EXISTS (
    SELECT 1 FROM safety_collections c
    CROSS JOIN safety_records r INDEXED BY safety_records_collection ON r.collection_id=c.id
    WHERE c.id IN (
        SELECT c.id FROM safety_collections c INDEXED BY safety_collections_session WHERE c.session_id=t.session_id
        UNION SELECT c.id FROM safety_collections c INDEXED BY google_safety_collections_owner
          WHERE c.history_owner_id=t.owner AND c.generation=t.generation
        UNION SELECT c.id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
          CROSS JOIN safety_collections c INDEXED BY google_safety_collections_owner
          ON c.history_owner_id=a.id AND c.generation=t.generation WHERE a.owner_id=t.owner)
      AND r.kind='occurrence'
      AND CASE WHEN json_valid(r.payload)
        THEN COALESCE(json_extract(r.payload,'$.occurrence.admission.trusted'),json_extract(r.payload,'$.admission.trusted'),0)<>1
          AND NOT EXISTS (SELECT 1 FROM safety_decisions d WHERE d.occurrence_id=r.id)
        ELSE 1 END);

CREATE TRIGGER google_continuity_safety_meta_update AFTER UPDATE OF failed,reason ON safety_meta
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1) AND (OLD.failed IS NOT NEW.failed OR OLD.reason IS NOT NEW.reason)
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions
  );
END;

CREATE TRIGGER google_continuity_safety_sessions_update AFTER UPDATE OF classification,generation,history_owner_id,session_id ON safety_sessions
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT OLD.session_id UNION SELECT NEW.session_id))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT OLD.session_id UNION SELECT NEW.session_id)
  );
END;

CREATE TRIGGER google_continuity_safety_sessions_delete AFTER DELETE ON safety_sessions
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT OLD.session_id))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT OLD.session_id)
  );
END;

CREATE TRIGGER google_continuity_safety_collections_update AFTER UPDATE OF session_id,history_owner_id,generation,acknowledged,gap,failure ON safety_collections
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT OLD.session_id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner
        WHERE s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id) AND s.generation=OLD.generation
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=OLD.generation
        WHERE a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id) UNION SELECT NEW.session_id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner
        WHERE s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=NEW.history_owner_id),NEW.history_owner_id) AND s.generation=NEW.generation
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=NEW.generation
        WHERE a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=NEW.history_owner_id),NEW.history_owner_id)))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT OLD.session_id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner
        WHERE s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id) AND s.generation=OLD.generation
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=OLD.generation
        WHERE a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id) UNION SELECT NEW.session_id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner
        WHERE s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=NEW.history_owner_id),NEW.history_owner_id) AND s.generation=NEW.generation
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=NEW.generation
        WHERE a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=NEW.history_owner_id),NEW.history_owner_id))
  );
END;

CREATE TRIGGER google_continuity_safety_collections_delete AFTER DELETE ON safety_collections
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT OLD.session_id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner
        WHERE s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id) AND s.generation=OLD.generation
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=OLD.generation
        WHERE a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id)))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT OLD.session_id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner
        WHERE s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id) AND s.generation=OLD.generation
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=OLD.generation
        WHERE a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=OLD.history_owner_id),OLD.history_owner_id))
  );
END;

CREATE TRIGGER google_continuity_safety_records_delete AFTER DELETE ON safety_records
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=OLD.collection_id
    ) affected))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=OLD.collection_id
    ) affected)
  );
END;

CREATE TRIGGER google_continuity_safety_decisions_insert AFTER INSERT ON safety_decisions
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
    ) affected))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
    ) affected)
  );
END;

CREATE TRIGGER google_continuity_safety_decisions_update AFTER UPDATE ON safety_decisions
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
    ) affected UNION SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
    ) affected))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
    ) affected UNION SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=NEW.occurrence_id)
    ) affected)
  );
END;

CREATE TRIGGER google_continuity_safety_decisions_delete AFTER DELETE ON safety_decisions
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
    ) affected))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=(SELECT collection_id FROM safety_records WHERE id=OLD.occurrence_id)
    ) affected)
  );
END;

CREATE TRIGGER google_continuity_safety_pending_delete AFTER DELETE ON safety_pending
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=OLD.collection_id
    ) affected))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT affected.session_id FROM (
      SELECT c.session_id FROM safety_collections c WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
          AND s.generation=c.generation WHERE c.id=OLD.collection_id
      UNION SELECT s.session_id FROM safety_collections c
        CROSS JOIN dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        ON a.owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=c.history_owner_id),c.history_owner_id)
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner
        ON s.history_owner_id=a.id AND s.generation=c.generation WHERE c.id=OLD.collection_id
    ) affected)
  );
END;

CREATE TRIGGER google_continuity_dialogue_aliases_insert AFTER INSERT ON dialogue_aliases
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=NEW.owner_id))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=NEW.owner_id)
  );
END;

CREATE TRIGGER google_continuity_dialogue_aliases_update AFTER UPDATE ON dialogue_aliases
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=OLD.owner_id UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=NEW.owner_id))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=OLD.owner_id UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=NEW.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=NEW.owner_id)
  );
END;

CREATE TRIGGER google_continuity_dialogue_aliases_delete AFTER DELETE ON dialogue_aliases
WHEN EXISTS (SELECT 1 FROM google_session_allowances LIMIT 1)
  AND EXISTS (SELECT 1 FROM google_session_allowances WHERE session_id IN (SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=OLD.owner_id))
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (
    SELECT session_id FROM google_normal_allowance_sessions WHERE session_id IN (SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.id
      UNION SELECT s.session_id FROM safety_sessions s INDEXED BY google_safety_sessions_owner WHERE s.history_owner_id=OLD.owner_id
      UNION SELECT s.session_id FROM dialogue_aliases a INDEXED BY google_dialogue_aliases_owner
        CROSS JOIN safety_sessions s INDEXED BY google_safety_sessions_owner ON s.history_owner_id=a.id
        WHERE a.owner_id=OLD.owner_id)
  );
END;
