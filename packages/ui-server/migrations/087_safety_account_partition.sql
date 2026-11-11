-- A chat's safety history belongs to its account, not to the one login that
-- started it (#3952). The owner mints a principal at every sign-in, so another
-- device's owner login may review the chat's occurrences too. The verdict
-- still names the exact principal that gave it.
--
-- Same account, as `sameAccount` in `src/middleware/account-partition.ts`
-- decides it: a principal id always matches itself, and two different ids
-- match only when both resolve to owner logins. An agent, ambient or system
-- principal matches only itself, and a missing or unresolvable principal
-- matches no other id. Every other boundary of 084 is unchanged, and no
-- existing row is rewritten.
DROP TRIGGER safety_decision_identity;
CREATE TRIGGER safety_decision_identity BEFORE INSERT ON safety_decisions
 WHEN NOT EXISTS (
 SELECT 1 FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
 JOIN safety_sessions s ON s.session_id=NEW.session_id
 WHERE r.id=NEW.occurrence_id AND r.kind='occurrence'
 AND s.history_owner_id=NEW.history_owner_id AND s.generation=NEW.generation
 AND (s.principal_id=NEW.principal_id OR (
   EXISTS (SELECT 1 FROM principals WHERE id=s.principal_id AND kind='owner')
   AND EXISTS (SELECT 1 FROM principals WHERE id=NEW.principal_id AND kind='owner')))
 AND (c.principal_id=NEW.principal_id OR (
   EXISTS (SELECT 1 FROM principals WHERE id=c.principal_id AND kind='owner')
   AND EXISTS (SELECT 1 FROM principals WHERE id=NEW.principal_id AND kind='owner')))
 AND c.generation=s.generation
 AND (c.session_id=s.session_id OR (c.generation=s.generation AND (
   c.history_owner_id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=s.history_owner_id),s.history_owner_id)
   OR c.history_owner_id IN (SELECT id FROM dialogue_aliases WHERE owner_id=
     COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=s.history_owner_id),s.history_owner_id)))))
 AND NOT EXISTS (SELECT 1 FROM safety_retired_turns WHERE turn_id=c.turn_id)
 AND NOT EXISTS (SELECT 1 FROM chat_retired_identities WHERE kind='session' AND id=s.session_id)
 AND NOT EXISTS (SELECT 1 FROM chat_retired_identities WHERE kind='dialogue_owner' AND id=s.history_owner_id)
 AND NOT EXISTS (SELECT 1 FROM chat_retired_identities WHERE kind='dialogue_owner' AND id=
   COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=s.history_owner_id),s.history_owner_id))
 AND NOT EXISTS (SELECT 1 FROM dialogue_owners d WHERE d.id=
   COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=s.history_owner_id),s.history_owner_id)
   AND (CAST(d.generation AS TEXT)!=NEW.generation OR NOT (d.principal_id=NEW.principal_id OR (
     EXISTS (SELECT 1 FROM principals WHERE id=d.principal_id AND kind='owner')
     AND EXISTS (SELECT 1 FROM principals WHERE id=NEW.principal_id AND kind='owner')))))
 AND COALESCE((SELECT x.state FROM safety_records x WHERE x.occurrence_id=r.id AND x.kind='exposure'
   ORDER BY length(x.sequence) DESC,x.sequence DESC LIMIT 1),r.state)='finalized'
 ) BEGIN SELECT RAISE(ABORT,'safety decision identity or exposure mismatch'); END;
