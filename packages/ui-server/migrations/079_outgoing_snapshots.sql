-- A draft keeps a list of outgoing snapshots instead of one slot (#3588, the
-- #3155 G1 A ruling): each is a held, returned or unconfirmed send with its
-- own id, text and files. A chat keeps at most ten of them across its drafts.
-- JSON array of DraftSnapshot, oldest first.
ALTER TABLE session_drafts ADD COLUMN outgoing_snapshots TEXT NOT NULL DEFAULT '[]';

-- The one slot a draft saved before becomes the first snapshot of its list.
-- Its id is its request id, which is how the single-slot write addresses it.
UPDATE session_drafts SET outgoing_snapshots = json_array(json_object(
    'snapshotId', json_extract(outgoing_json, '$.requestId'),
    'requestId', json_extract(outgoing_json, '$.requestId'),
    'text', json_extract(outgoing_json, '$.text'),
    'fileIds', json(json_extract(outgoing_json, '$.fileIds')),
    'state', json_extract(outgoing_json, '$.state'),
    'createdAt', updated_at))
  WHERE outgoing_json IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE session_drafts DROP COLUMN outgoing_json;
