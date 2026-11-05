/** FULL write-worker commits for Settings identities and operation-bound publication proofs. */
import type { Database } from "bun:sqlite";
import type { WriteProcedures } from "../db/write-worker.js";
export const url = import.meta.url;
export function setup(db: Database): WriteProcedures {
  return {
    insert(row: { requestId: string; brainId: string; principalId: string; authority: string; expires: number; retain: number; payload: string; receipt: string }, now: number) {
      return db.transaction(() => {
        db.query("DELETE FROM trust_settings_operations WHERE retain_until < ?").run(now);
        const total = db.query("SELECT count(*) n, coalesce(sum(payload_bytes + 16384),0) bytes FROM trust_settings_operations").get() as { n: number; bytes: number };
        const pending = db.query("SELECT count(*) n, coalesce(sum(principal_id = ?),0) own FROM trust_settings_operations WHERE brain_id = ? AND stage = 'prepared' AND expires_at >= ?").get(row.principalId, row.brainId, now) as { n: number; own: number };
        // Reserve terminal/proof capacity for every admitted request, never evict live receipts.
        if (total.n >= 10000 || total.bytes + Buffer.byteLength(row.payload) + 16384 > 16777216 || pending.n >= 256 || pending.own >= 32) return "capacity";
        db.query("INSERT INTO trust_settings_operations VALUES (?,?,?,?,?,?,?,?,? ,NULL,?)").run(row.requestId, row.brainId, row.principalId, row.authority, row.expires, row.retain, row.payload, Buffer.byteLength(row.payload), "prepared", row.receipt);
        return "prepared";
      }).immediate();
    },
    stage(id: string, stage: string, receipt: string, proof: string | null, now: number) {
      db.query("UPDATE trust_settings_operations SET stage=?, receipt=?, proof=coalesce(?,proof), retain_until=max(retain_until,?) WHERE request_id=?").run(stage, receipt, proof, now + 86400000, id);
    },
    projection(brain: string, revision: string, rules: string, hash: string | null, error: string | null) {
      db.query("INSERT INTO trust_settings_projection VALUES (?,?,?,?,?) ON CONFLICT(brain_id) DO UPDATE SET revision=excluded.revision,rules=excluded.rules,policy_hash=excluded.policy_hash,error=excluded.error").run(brain, revision, rules, hash, error);
    },
  };
}
