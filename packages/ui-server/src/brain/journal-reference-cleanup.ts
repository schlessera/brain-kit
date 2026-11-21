/** Kept inside finish's existing accounted transaction. NULL must not poison NOT IN. */
export const FINISH_REFERENCE_CLEANUP = `DELETE FROM turn_journal_object_refs
WHERE turn_id = ?1 AND hash NOT IN (
  SELECT h FROM (
    SELECT pack_hash AS h FROM turn_journal_code_receipts WHERE turn_id = ?1
    UNION ALL
    SELECT json_extract(before_json, '$.hash') AS h FROM turn_journal_changes WHERE turn_id = ?1
    UNION ALL
    SELECT json_extract(after_json, '$.hash') FROM turn_journal_changes WHERE turn_id = ?1
    UNION ALL
    SELECT json_extract(before_json, '$.hash') FROM turn_journal_claude_memory WHERE turn_id = ?1 AND state != 'saved'
    UNION ALL
    SELECT json_extract(after_json, '$.hash') FROM turn_journal_claude_memory WHERE turn_id = ?1 AND state != 'saved'
  ) WHERE h IS NOT NULL
)`;

/** Older or near-cap stores can finish notes without admitting receipt tables. */
export const FINISH_REFERENCE_CLEANUP_WITHOUT_CODE = FINISH_REFERENCE_CLEANUP.replace("    SELECT pack_hash AS h FROM turn_journal_code_receipts WHERE turn_id = ?1\n    UNION ALL\n", "");
