/** Read evidence shares the reference writer FIFO; it never grants source trust. */
import type { Database } from "bun:sqlite";
import { isLiveReferenceGrant } from "../db/reference-grants.js";
import { sourceAuthorityCurrent, type SourceAuthority } from "./reference-source-authority.js";

export interface ReferenceReadRecord {
  id: string;
  turnId: string;
  toolCallId: string;
  principalId: string;
  acquisition: string;
  evidence: string;
  responseDigest: string;
  at: number;
}

export function readWrites(db: Database) {
  return {
    referenceReadPrepare(record: ReferenceReadRecord, rootId: string, grantId: string | null, authority: SourceAuthority) {
      return db.transaction(() => {
        const acquisition = db.query("SELECT * FROM reference_acquisitions WHERE root_id = ?").get(rootId);
        const source = db.query("SELECT 1 FROM reference_sources WHERE root_id = ? AND validated_at > 0").get(rootId);
        if (!source || JSON.stringify(acquisition) !== record.acquisition || !sourceAuthorityCurrent(db, authority)
          || grantId !== null && !isLiveReferenceGrant(db, grantId, Date.now())) throw new Error("Reference read authority changed before recording");
        const count = db.query("SELECT COUNT(*) AS n FROM reference_reads WHERE turn_id = ?").get(record.turnId) as { n: number };
        if (count.n >= 2000) throw new Error("Reference read record capacity exceeded");
        db.query(`INSERT INTO reference_reads (id, turn_id, tool_call_id, principal_id, acquisition, evidence, response_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.turnId, record.toolCallId, record.principalId,
            record.acquisition, record.evidence, record.responseDigest, record.at);
      }).immediate();
    },
    referenceReadObserve(turnId: string, toolCallId: string, digest: string | null, finalized: boolean) {
      db.query(`UPDATE reference_reads SET delivery = CASE WHEN delivery != 'unknown' AND response_digest = ? AND ? THEN 'observed' ELSE 'unknown' END,
        observed_at = ? WHERE turn_id = ? AND tool_call_id = ?`).run(digest, finalized, Date.now(), turnId, toolCallId);
    },
  };
}
