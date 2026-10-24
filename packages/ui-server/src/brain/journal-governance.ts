import type { Database } from "bun:sqlite";

import { GovernanceEventError, recordGovernanceEvent } from "../governance/events.js";

type SteeringRow = {
  turn_id: string; sequence: number; path: string; scope: string; before_json: string | null; after_json: string | null; actor: string;
  overlaps: string; taint_source_event_id: number | null; session_id: string | null; turn_actor: "interactive" | "voice" | "user";
  model: string | null; profile: "strict" | "governed"; at: number;
};

/**
 * Records any `steering_change` event a journal steering change lacks (#2789).
 * The journal and governance events live in different files, and a commit
 * spanning both is atomic per file only, so a crash can keep the change
 * without its event. The journal is authoritative; the event is rebuilt from
 * its row with the same dedupe key, so running this again records nothing.
 * Returns how many events it recorded.
 */
export function replaySteeringEvents(db: Database): number {
  const rows = db.query(`SELECT c.turn_id, c.sequence, c.path, c.scope, c.before_json, c.after_json, c.actor, c.overlaps, c.taint_source_event_id,
      t.session_id, t.actor AS turn_actor, t.model, t.profile, coalesce(t.ended_at, t.started_at) AS at
    FROM turn_journal_changes c JOIN turn_journal_turns t ON t.turn_id = c.turn_id
    WHERE c.class = 'steering' AND NOT EXISTS (SELECT 1 FROM governance_events g
      WHERE g.kind = 'steering_change' AND g.dedupe_key = c.turn_id || ':' || c.sequence)`).all() as SteeringRow[];
  let recorded = 0;
  for (const row of rows) {
    const hash = (json: string | null) => (json ? (JSON.parse(json) as { hash?: string }).hash : undefined) ?? null;
    try {
      recorded += Number(recordGovernanceEvent(db, {
        kind: "steering_change", sessionId: row.session_id, turnId: row.turn_id, model: row.model, profile: row.profile, at: row.at,
        // A saved Claude memory note is attributed to the turn, as when it was recorded.
        actor: row.scope !== "claude_memory" && row.actor === "user" ? "user" : row.turn_actor,
        dedupeKey: `${row.turn_id}:${row.sequence}`,
        payload: { path: row.path, sequence: row.sequence, beforeHash: hash(row.before_json), afterHash: hash(row.after_json),
          taintSourceEventId: row.taint_source_event_id, overlappingTurnIds: JSON.parse(row.overlaps) as string[] },
      }).recorded);
    } catch (error) {
      // A row the event schema refuses could never have been recorded either.
      if (!(error instanceof GovernanceEventError)) throw error;
    }
  }
  return recorded;
}
