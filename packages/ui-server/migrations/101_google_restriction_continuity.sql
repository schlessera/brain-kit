-- Evaluate the durable normal-state predicate on changes to its source tables.
-- This follows safetyProjection's canonical membership and restriction reasons.
-- A normal interval deletes authority even when no Google caller observes it.
CREATE VIEW google_normal_allowance_sessions AS
WITH targets AS (
  SELECT DISTINCT a.session_id, s.classification, COALESCE(s.generation,'1') generation,
    COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=s.history_owner_id),s.history_owner_id) owner
  FROM google_session_allowances a LEFT JOIN safety_sessions s ON s.session_id=a.session_id
), scoped AS (
  SELECT t.session_id target, c.* FROM targets t JOIN safety_collections c
  ON c.session_id=t.session_id OR (t.owner IS NOT NULL AND c.generation=t.generation
    AND (c.history_owner_id=t.owner OR c.history_owner_id IN (SELECT id FROM dialogue_aliases WHERE owner_id=t.owner)))
)
SELECT t.session_id FROM targets t
WHERE (SELECT failed=0 AND (reason IS NULL OR reason<>'capacity') FROM safety_meta WHERE singleton=1)
  AND (t.classification IS NULL OR t.classification='new')
  AND (SELECT COUNT(*) FROM scoped c WHERE c.target=t.session_id) BETWEEN 1 AND 128
  AND NOT EXISTS (SELECT 1 FROM scoped c WHERE c.target=t.session_id
    AND (c.gap IS NOT NULL OR c.failure IS NOT NULL OR json_array_length(c.acknowledged)<9))
  AND NOT EXISTS (SELECT 1 FROM safety_pending p JOIN scoped c ON c.id=p.collection_id WHERE c.target=t.session_id)
  AND NOT EXISTS (SELECT 1 FROM safety_records r JOIN scoped c ON c.id=r.collection_id
    WHERE c.target=t.session_id AND r.kind='occurrence'
      AND COALESCE(json_extract(r.payload,'$.occurrence.admission.trusted'),json_extract(r.payload,'$.admission.trusted'),0)<>1
      AND NOT EXISTS (SELECT 1 FROM safety_decisions d WHERE d.occurrence_id=r.id));

CREATE TRIGGER google_continuity_safety_meta_insert AFTER INSERT ON safety_meta
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_meta_update AFTER UPDATE ON safety_meta
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_meta_delete AFTER DELETE ON safety_meta
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_sessions_insert AFTER INSERT ON safety_sessions
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_sessions_update AFTER UPDATE ON safety_sessions
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_sessions_delete AFTER DELETE ON safety_sessions
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_collections_insert AFTER INSERT ON safety_collections
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_collections_update AFTER UPDATE ON safety_collections
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_collections_delete AFTER DELETE ON safety_collections
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_records_insert AFTER INSERT ON safety_records
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_records_update AFTER UPDATE ON safety_records
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_records_delete AFTER DELETE ON safety_records
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_decisions_insert AFTER INSERT ON safety_decisions
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_decisions_update AFTER UPDATE ON safety_decisions
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_decisions_delete AFTER DELETE ON safety_decisions
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_pending_insert AFTER INSERT ON safety_pending
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_pending_update AFTER UPDATE ON safety_pending
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_safety_pending_delete AFTER DELETE ON safety_pending
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_dialogue_aliases_insert AFTER INSERT ON dialogue_aliases
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_dialogue_aliases_update AFTER UPDATE ON dialogue_aliases
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
CREATE TRIGGER google_continuity_dialogue_aliases_delete AFTER DELETE ON dialogue_aliases
BEGIN
  DELETE FROM google_session_allowances WHERE session_id IN (SELECT session_id FROM google_normal_allowance_sessions);
END;
