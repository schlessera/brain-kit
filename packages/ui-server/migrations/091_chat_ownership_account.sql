-- A chat's deletion ownership keeps the account that owned it after the login
-- that wrote a record is pruned (#4138), as 089 did for its safety history
-- and dialogue owner. Explicit deletion admits any current owner login when
-- every ownership record of the chat proves that same account; a voice epoch
-- or a typed-creation binding whose login was pruned proved nothing, so a
-- chat two logins used became undeletable once either aged out.
--
-- `principal_account` sits beside each record's `principal_id`. The server
-- writes it from the principal row when the record is written: 'owner' for an
-- owner login, NULL for a principal whose account is only itself (an agent,
-- an ambient identity, a system principal). `principal_id` stays the
-- attribution and is never rewritten. The account is evidence, not a
-- credential: the caller still has to be a current, authorized owner login,
-- and live epoch control stays with the exact login that opened it.
--
-- Legacy rows gain an account only from verified evidence: a principal row
-- that still exists and is an owner login. A row whose principal is already
-- gone keeps NULL and stays unknown, so its chat keeps refusing deletion.
-- Nothing is owner by default. IN over a NULL principal_id is not true, so a
-- record without a principal stays NULL as well.
ALTER TABLE conversation_epochs ADD COLUMN principal_account TEXT;
ALTER TABLE chat_session_owners ADD COLUMN principal_account TEXT;
UPDATE conversation_epochs SET principal_account='owner'
 WHERE principal_id IN (SELECT id FROM principals WHERE kind='owner');
UPDATE chat_session_owners SET principal_account='owner'
 WHERE principal_id IN (SELECT id FROM principals WHERE kind='owner');
