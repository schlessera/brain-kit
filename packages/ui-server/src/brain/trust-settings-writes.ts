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
    stage(id: string, stage: string, receipt: string, proof: string | null, now: number,
      boundary?: { brain: string; ruleId: string; selector: string; identity: string }) {
      return db.transaction(() => {
        db.query("UPDATE trust_settings_operations SET stage=?, receipt=?, proof=coalesce(?,proof), retain_until=max(retain_until,?) WHERE request_id=?").run(stage, receipt, proof, now + 86400000, id);
        if (boundary) {
          if (stage !== "file_published" || !proof) throw new Error("A GitHub boundary requires this operation's durable publication proof");
          db.query(`INSERT INTO trust_settings_github_boundaries VALUES (?,?,?,?,?)
            ON CONFLICT(brain_id,rule_id) DO UPDATE SET selector=excluded.selector,identity=excluded.identity,proof=excluded.proof`)
            .run(boundary.brain, boundary.ruleId, boundary.selector, boundary.identity, proof);
        }
      }).immediate();
    },
    projection(brain: string, revision: string, rules: string, hash: string | null, error: string | null) {
      return db.transaction(() => {
        const prior = db.query("SELECT rules,rule_instances FROM trust_settings_projection WHERE brain_id=?").get(brain) as { rules:string;rule_instances:string } | null;
        const oldRules = new Map((JSON.parse(prior?.rules ?? "[]") as {id:string;selector:unknown;incomingContent:boolean}[]).map(rule=>[rule.id,JSON.stringify([rule.selector,rule.incomingContent])]));
        const oldInstances = JSON.parse(prior?.rule_instances ?? "{}") as Record<string,string>;
        const instances:Record<string,string> = Object.create(null);
        for (const rule of JSON.parse(rules) as {id:string;selector:unknown;incomingContent:boolean}[]) {
          const same = oldRules.get(rule.id) === JSON.stringify([rule.selector,rule.incomingContent]);
          instances[rule.id] = (error || same) && typeof oldInstances[rule.id] === "string" ? oldInstances[rule.id]! : revision;
        }
        db.query(`INSERT INTO trust_settings_projection (brain_id,revision,rules,policy_hash,error,rule_instances) VALUES (?,?,?,?,?,?)
          ON CONFLICT(brain_id) DO UPDATE SET revision=excluded.revision,rules=excluded.rules,policy_hash=excluded.policy_hash,error=excluded.error,rule_instances=excluded.rule_instances`)
          .run(brain, revision, rules, hash, error, JSON.stringify(instances));
        // At most one retained boundary per current rule; equal file bytes
        // alone never create one. Invalid policy retains last-valid facts.
        if (!error) {
          const current = new Map((JSON.parse(rules) as { id: string; selector: unknown }[]).map(rule => [rule.id, JSON.stringify(rule.selector)]));
          const boundaries = db.query("SELECT rule_id,selector FROM trust_settings_github_boundaries WHERE brain_id=?").all(brain) as { rule_id: string; selector: string }[];
          for (const row of boundaries) if (current.get(row.rule_id) !== row.selector)
            db.query("DELETE FROM trust_settings_github_boundaries WHERE brain_id=? AND rule_id=?").run(brain, row.rule_id);
        }
        return instances;
      }).immediate();
    },
  };
}
