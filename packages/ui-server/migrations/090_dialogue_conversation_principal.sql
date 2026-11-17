-- A chat's retained dialogue belongs to its account (#3963), as its safety
-- history does (#3962): another login of the same owner continues it by voice
-- from another device. A live conversation does not: only the login that
-- opened it reopens or closes its epochs.
--
-- `principal_id` names that login. The server writes it when the conversation
-- first opens and never rewrites it. The history's ownership stays on
-- dialogue_owners (`principal_id` and 089's `principal_account`); this column
-- is no second ownership record and grants no history access.
--
-- Before this migration an owner opened only with its own exact principal,
-- and adoption joined only two owners of that same principal, so every
-- existing conversation was opened by its owner's principal. That is the
-- verified evidence the backfill copies. Nothing else changes.
ALTER TABLE dialogue_conversations ADD COLUMN principal_id TEXT;
UPDATE dialogue_conversations SET principal_id=
  (SELECT o.principal_id FROM dialogue_owners o WHERE o.id=dialogue_conversations.owner_id);
