/** SQL owned by the activity store, kept together so the store reads as operations. */
export const ACTIVITY_SQL = {
  nextSeq: "SELECT COALESCE(MAX(seq), 0) AS hi FROM activity_changes WHERE run_id = ?",
  insertChange:
    "INSERT INTO activity_changes (run_id, seq, span_id, event_index) VALUES (?, ?, ?, ?)",
  spanById: "SELECT * FROM activity_spans WHERE span_id = ?",
  spanStateById: "SELECT run_id, outcome, attrs FROM activity_spans WHERE span_id = ?",
  endSpan: `UPDATE activity_spans SET outcome = ?, outcome_reason = ?, ended_at = ?, attrs = ?,
         input_tokens = COALESCE(?, input_tokens),
         output_tokens = COALESCE(?, output_tokens),
         cache_read_tokens = COALESCE(?, cache_read_tokens),
         cache_creation_tokens = COALESCE(?, cache_creation_tokens),
         cost_usd = COALESCE(?, cost_usd),
         model = COALESCE(?, model)
       WHERE span_id = ?`,
  openSpansByRun:
    "SELECT span_id FROM activity_spans WHERE run_id = ? AND outcome IS NULL ORDER BY started_at DESC",
  spansByRun: "SELECT * FROM activity_spans WHERE run_id = ? ORDER BY started_at",
  upsertRollup: `INSERT INTO activity_run_rollups
         (run_id, origin, name, session_id, job_name, principal_id, principal_label,
          principal_kind, started_at, ended_at, outcome,
          duration_ms, span_count, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cost_usd, effective_cost_usd, billing_mode,
          pricing_estimate, failure_reason, detail_pruned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(run_id) DO UPDATE SET
         ended_at = excluded.ended_at, outcome = excluded.outcome,
         duration_ms = excluded.duration_ms, span_count = excluded.span_count,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         cost_usd = COALESCE(activity_run_rollups.cost_usd, excluded.cost_usd),
         effective_cost_usd = CASE
           WHEN activity_run_rollups.effective_cost_usd IS NOT NULL
             THEN activity_run_rollups.effective_cost_usd
           WHEN activity_run_rollups.billing_mode IS NULL
             OR activity_run_rollups.billing_mode = excluded.billing_mode
             THEN excluded.effective_cost_usd
           ELSE NULL
         END,
         billing_mode = COALESCE(activity_run_rollups.billing_mode, excluded.billing_mode),
         pricing_estimate = CASE
           WHEN activity_run_rollups.pricing_estimate IS NOT NULL
             THEN activity_run_rollups.pricing_estimate
           WHEN activity_run_rollups.billing_mode IS NULL
             OR activity_run_rollups.billing_mode = excluded.billing_mode
             THEN excluded.pricing_estimate
           ELSE NULL
         END,
         failure_reason = excluded.failure_reason`,
  insertSpan: `INSERT INTO activity_spans
             (span_id, run_id, parent_span_id, name, kind, origin, session_id, job_name, principal_id,
              attrs, started_at, writer, last_heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  patchSpan: `UPDATE activity_spans SET principal_id = COALESCE(?, principal_id),
             attrs = ?, wait_until = COALESCE(?, wait_until),
             input_tokens = COALESCE(?, input_tokens),
             output_tokens = COALESCE(?, output_tokens),
             cache_read_tokens = COALESCE(?, cache_read_tokens),
             cache_creation_tokens = COALESCE(?, cache_creation_tokens),
             cost_usd = COALESCE(?, cost_usd),
             model = COALESCE(?, model)
           WHERE span_id = ?`,
  spanRunById: "SELECT run_id FROM activity_spans WHERE span_id = ?",
  nextEventIndex:
    "SELECT COALESCE(MAX(event_index), -1) + 1 AS idx FROM activity_events WHERE span_id = ?",
  insertEvent:
    "INSERT INTO activity_events (span_id, event_index, ts, event_type, payload) VALUES (?, ?, ?, ?, ?)",
  heartbeat:
    "UPDATE activity_spans SET last_heartbeat_at = ? WHERE span_id = ? AND outcome IS NULL",
  openSessionRuns:
    "SELECT DISTINCT run_id FROM activity_spans WHERE outcome IS NULL AND origin IN ('session', 'autonomous')",
  staleRoots: `SELECT span_id, run_id FROM activity_spans
           WHERE outcome IS NULL AND parent_span_id IS NULL
             AND writer != ? AND COALESCE(last_heartbeat_at, started_at) < ?`,
  stuckRoots:
    "SELECT * FROM activity_spans WHERE outcome IS NULL AND parent_span_id IS NULL AND started_at < ?",
  spanChanges: `SELECT c.change_id, c.run_id, c.seq, s.*
           FROM activity_changes c
           JOIN activity_spans s ON s.span_id = c.span_id
           WHERE c.change_id > ? AND c.event_index IS NULL
           ORDER BY c.change_id LIMIT ?`,
  eventChanges: `SELECT c.change_id, c.run_id, c.seq, e.*
           FROM activity_changes c
           JOIN activity_events e
             ON e.span_id = c.span_id AND e.event_index = c.event_index
           WHERE c.change_id > ? AND c.event_index IS NOT NULL
           ORDER BY c.change_id LIMIT ?`,
  terminalRootChanges: `SELECT MAX(c.change_id) AS change_id, s.*
           FROM activity_changes c
           JOIN activity_spans s ON s.span_id = c.span_id
           WHERE c.change_id > ? AND c.event_index IS NULL
             AND s.parent_span_id IS NULL AND s.outcome IS NOT NULL
           GROUP BY s.span_id
           ORDER BY change_id LIMIT ?`,
  latestChangeCursor: "SELECT COALESCE(MAX(change_id), 0) AS hi FROM activity_changes",
  eventsByRun: `SELECT e.* FROM activity_events e
               JOIN activity_spans s ON s.span_id = e.span_id
               WHERE s.run_id = ? ORDER BY e.ts, e.event_index`,
  openRootSpans:
    "SELECT * FROM activity_spans WHERE outcome IS NULL AND parent_span_id IS NULL ORDER BY started_at DESC",
  pruneCandidates: `SELECT run_id, ended_at AS ended FROM activity_run_rollups r
             WHERE detail_pruned = 0 AND ended_at IS NOT NULL
               AND ((ended_at < ? AND ended_at < ?) OR ended_at < ?)
               AND NOT EXISTS (
                 SELECT 1 FROM activity_spans s
                 WHERE s.run_id = r.run_id AND s.outcome IS NULL
               )
             LIMIT ?`,
  markDetailPruned: "UPDATE activity_run_rollups SET detail_pruned = 1 WHERE run_id = ?",
  markDigestCoverageGap:
    "UPDATE activity_run_rollups SET failure_reason = COALESCE(failure_reason, 'digest coverage gap') WHERE run_id = ?",
  deleteEventsByRun: `DELETE FROM activity_events WHERE span_id IN
               (SELECT span_id FROM activity_spans WHERE run_id = ?)`,
  deleteSpansByRun: "DELETE FROM activity_spans WHERE run_id = ?",
  deleteChangesByRun: "DELETE FROM activity_changes WHERE run_id = ?",
  compactChanges: `DELETE FROM activity_changes WHERE change_id < (
             SELECT COALESCE(MAX(change_id), 0) FROM activity_changes
           ) - 100000 AND run_id NOT IN (
             SELECT DISTINCT run_id FROM activity_spans WHERE outcome IS NULL
           )`,
} as const;
