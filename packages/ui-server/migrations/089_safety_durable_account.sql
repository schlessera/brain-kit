-- A chat's safety history keeps the account that owned it after the login
-- that wrote it is pruned (#3962). Principal rows do not last: cleanup deletes
-- a login 30 days after it expires or is revoked, and an owner login then
-- became an id nobody could vouch for, so no later login could continue the
-- chat it started.
--
-- `principal_account` sits beside each record's `principal_id`. The server
-- writes it from the principal row when the record is written: 'owner' for an
-- owner login, NULL for a principal whose account is only itself (an agent,
-- an ambient identity, a system principal). `principal_id` stays the
-- attribution and is never rewritten. The account is evidence, not a
-- credential: the caller still has to be a current, authorized login.
--
-- Legacy rows gain an account only from verified evidence: a principal row
-- that still exists and is an owner login. A row whose principal is already
-- gone keeps NULL and stays unknown. Nothing is owner by default, and no
-- record, verdict, gap or generation changes.
ALTER TABLE safety_sessions ADD COLUMN principal_account TEXT;
ALTER TABLE safety_collections ADD COLUMN principal_account TEXT;
ALTER TABLE dialogue_owners ADD COLUMN principal_account TEXT;
UPDATE safety_sessions SET principal_account='owner'
 WHERE principal_id IN (SELECT id FROM principals WHERE kind='owner');
UPDATE safety_collections SET principal_account='owner'
 WHERE principal_id IN (SELECT id FROM principals WHERE kind='owner');
UPDATE dialogue_owners SET principal_account='owner'
 WHERE principal_id IN (SELECT id FROM principals WHERE kind='owner');

-- 081's discovery trigger inserted by position; name the columns now.
DROP TRIGGER IF EXISTS safety_catalog_discovery;
CREATE TRIGGER safety_catalog_discovery AFTER INSERT ON sessions BEGIN
 INSERT INTO safety_sessions(session_id,history_owner_id,generation,principal_id,origin_turn,classification,backend_id)
  VALUES(NEW.id,lower(hex(randomblob(16))),'1',NULL,NULL,'discovered',NEW.backend_id);
 UPDATE safety_meta SET scope_rows=scope_rows+1,scope_bytes=scope_bytes+2048 WHERE singleton=1;
END;

-- Same account, as `sameAccount` in `src/middleware/account-partition.ts`
-- decides it. A record's evidence is consistent when its account is NULL, or
-- 'owner' with no principal row that says otherwise. Corrupt or
-- contradictory evidence matches nobody, not even its own principal. A
-- consistent record matches its exact principal, and an owner record (its
-- account is 'owner', or it has none and its principal row is an owner login)
-- matches any owner login. Every other boundary of 087 is unchanged.
-- Comparisons use IS: inside the dialogue owner's NOT EXISTS a NULL would
-- skip the rejection and admit the verdict, so no term there may be NULL.
DROP TRIGGER IF EXISTS safety_decision_identity;
CREATE TRIGGER safety_decision_identity BEFORE INSERT ON safety_decisions
 WHEN NOT EXISTS (
 SELECT 1 FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
 JOIN safety_sessions s ON s.session_id=NEW.session_id
 WHERE r.id=NEW.occurrence_id AND r.kind='occurrence'
 AND s.history_owner_id=NEW.history_owner_id AND s.generation=NEW.generation
 AND (s.principal_account IS NULL OR (s.principal_account IS 'owner'
   AND NOT EXISTS (SELECT 1 FROM principals WHERE id=s.principal_id AND kind<>'owner')))
 AND (s.principal_id=NEW.principal_id OR (
   (s.principal_account IS 'owner' OR EXISTS (SELECT 1 FROM principals WHERE id=s.principal_id AND kind='owner'))
   AND EXISTS (SELECT 1 FROM principals WHERE id=NEW.principal_id AND kind='owner')))
 AND (c.principal_account IS NULL OR (c.principal_account IS 'owner'
   AND NOT EXISTS (SELECT 1 FROM principals WHERE id=c.principal_id AND kind<>'owner')))
 AND (c.principal_id=NEW.principal_id OR (
   (c.principal_account IS 'owner' OR EXISTS (SELECT 1 FROM principals WHERE id=c.principal_id AND kind='owner'))
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
   AND (CAST(d.generation AS TEXT) IS NOT NEW.generation
     OR NOT (d.principal_account IS NULL OR (d.principal_account IS 'owner'
       AND NOT EXISTS (SELECT 1 FROM principals WHERE id=d.principal_id AND kind<>'owner')))
     OR NOT (d.principal_id IS NEW.principal_id OR (
       (d.principal_account IS 'owner' OR EXISTS (SELECT 1 FROM principals WHERE id=d.principal_id AND kind='owner'))
       AND EXISTS (SELECT 1 FROM principals WHERE id=NEW.principal_id AND kind='owner')))))
 AND COALESCE((SELECT x.state FROM safety_records x WHERE x.occurrence_id=r.id AND x.kind='exposure'
   ORDER BY length(x.sequence) DESC,x.sequence DESC LIMIT 1),r.state)='finalized'
 ) BEGIN SELECT RAISE(ABORT,'safety decision identity or exposure mismatch'); END;
