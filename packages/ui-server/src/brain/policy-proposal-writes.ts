/**
 * A policy proposal joins its session off the event loop (#2850): the bind
 * references the session's catalog row, which commits on the `ui.db` write
 * worker once `session_info` names the session, so the bind commits there
 * too, after it, at `synchronous=FULL`. A proposal recorded before the row
 * exists keeps a null session until the bind lands.
 */
import type { Database } from "bun:sqlite";

import type { WriteProcedures } from "../db/write-worker.js";

export const url = import.meta.url;

export function bindPolicyProposals(db: Database, turnId: string, sessionId: string) {
  db.query("UPDATE policy_proposals SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
}

export function setup(db: Database): WriteProcedures {
  return { bind: (turnId: string, sessionId: string) => bindPolicyProposals(db, turnId, sessionId) };
}
