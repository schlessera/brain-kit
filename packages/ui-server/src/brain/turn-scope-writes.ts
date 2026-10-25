/**
 * Turn scope writes off the event loop (#2850). The hosted server commits
 * every `turn_scope` row on the `ui.db` write worker at `synchronous=FULL`,
 * in submission order with the journal's, Activity's and governance writes;
 * the scope monitor keeps each live turn's summary in memory and reads its
 * own rows back only for turns it no longer runs.
 */
import type { Database } from "bun:sqlite";
import type { TurnScopeSummary } from "@schlessera/brain-ui-sdk/protocol";

import type { WriteProcedures } from "../db/write-worker.js";
import { recordTurnRoadblocks } from "../governance/roadblocks.js";
import { processAlive } from "./writer-gate.js";

export const url = import.meta.url;

export function setup(db: Database): WriteProcedures {
  return {
    /** A restart cannot resume a kernel process or turn whose authority ended. */
    recover(now: number) {
      for (const row of db.query("SELECT s.turn_id,s.session_id,s.summary,j.actor,j.profile,j.started_at,j.pid,j.pid_start FROM turn_scope s LEFT JOIN turn_journal_turns j ON j.turn_id=s.turn_id WHERE s.ended_at IS NULL").all() as { turn_id: string; session_id: string | null; summary: string; actor: "interactive" | "voice" | "user" | null; profile: "strict" | "governed" | null; started_at: number | null; pid: number | null; pid_start: string | null }[]) {
        if (row.pid !== null && row.pid_start !== null && processAlive(row.pid, row.pid_start)) continue;
        const summary = JSON.parse(row.summary) as TurnScopeSummary;
        for (const receipt of summary.receipts) if (receipt.state === "paused") {
          receipt.state = "ended_before_answer"; receipt.reason = "Host restarted; the turn was interrupted.";
        }
        if (summary.receipts.some(receipt => receipt.state === "ended_before_answer")) recordTurnRoadblocks(db, { turnId: row.turn_id, sessionId: row.session_id, actor: row.actor ?? "interactive", model: null, profile: row.profile },
          { startedAt: row.started_at ?? summary.observedAt, endedAt: now, calls: [], usage: [], finalUsage: null, outcomeDetail: null });
        db.query("UPDATE turn_scope SET summary=?,ended_at=? WHERE turn_id=?").run(JSON.stringify(summary), now, row.turn_id);
      }
    },
    insert(turnId: string, sessionId: string | null, principalId: string, summary: string) {
      db.query("INSERT INTO turn_scope(turn_id,session_id,principal_id,summary) VALUES (?,?,?,?)").run(turnId, sessionId, principalId, summary);
    },
    save(turnId: string, sessionId: string | null, summary: string) {
      db.query("UPDATE turn_scope SET session_id=?,summary=? WHERE turn_id=?").run(sessionId, summary, turnId);
    },
    end(turnId: string, endedAt: number) {
      db.query("UPDATE turn_scope SET ended_at=? WHERE turn_id=?").run(endedAt, turnId);
    },
  };
}
