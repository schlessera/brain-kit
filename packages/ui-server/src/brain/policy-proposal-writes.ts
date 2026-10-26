/**
 * Policy proposal insert, review saves and session binds commit on the write
 * worker at FULL (#2850). The caller awaits insertion before approval and
 * the writing review before publishing any policy bytes.
 */
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { Database } from "bun:sqlite";

import type { WriteProcedures } from "../db/write-worker.js";

export const url = import.meta.url;

export function bindPolicyProposals(db: Database, turnId: string, sessionId: string) {
  db.query("UPDATE policy_proposals SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
}

export function setup(db: Database): WriteProcedures {
  return {
    bind: (turnId: string, sessionId: string) => bindPolicyProposals(db, turnId, sessionId),
    insert(requestId: string, turnId: string, principalId: string, sessionId: string | null, inputHash: string, review: PolicyChangeReview, at: number) {
      db.query(`INSERT INTO policy_proposals (request_id, turn_id, principal_id, session_id, input_hash, review, created_at)
        VALUES (?, ?, ?, (SELECT id FROM sessions WHERE id = ?), ?, ?, ?)`)
        .run(requestId, turnId, principalId, sessionId, inputHash, JSON.stringify(review), at);
    },
    save(review: PolicyChangeReview, sessionId: string | null) {
      db.query("UPDATE policy_proposals SET review = ?, session_id = (SELECT id FROM sessions WHERE id = ?) WHERE turn_id = ? AND request_id = ?")
        .run(JSON.stringify(review), sessionId, review.turnId, review.requestId);
    },
  };
}
