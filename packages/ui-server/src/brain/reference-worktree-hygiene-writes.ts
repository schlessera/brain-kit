/** Finding dispositions keep their reads and writes in one worker transaction (#2999). */
import type { Database } from "bun:sqlite";
import type { createReferenceWorktreeHygiene } from "./reference-worktree-hygiene.js";

type Detected = Awaited<ReturnType<ReturnType<typeof createReferenceWorktreeHygiene>["reconcile"]>>;
interface FindingRow {
  id: string; worktree_id: string; kind: "retained" | "unknown" | "cleanup-failed"; state: "open" | "dismissed" | "snoozed" | "resolved"; fingerprint: string; fields_json: string;
  first_seen: number; last_seen: number; disposition_fingerprint: string | null; disposition_fields_json: string | null; disposed_at: number | null;
  due_at: number | null; reason: string | null; invalidation_json: string | null; resolved_by: string | null; resolved_at: number | null;
}

const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
export function hygieneWrites(db: Database) {
  const findingRow = (id: string) => db.query("SELECT * FROM reference_worktree_findings WHERE id = ?").get(id) as FindingRow | null;
  return {
    hygieneReconcile(detected: Detected, at: number) {
      db.transaction(() => {
        for (const [id, { kind, finding, item }] of detected) {
          const prior = findingRow(id), fields = JSON.stringify(finding.fingerprintFields);
          if (!prior) {
            db.query(`INSERT INTO reference_worktree_findings (id, worktree_id, kind, state, fingerprint, fields_json, first_seen, last_seen) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`)
              .run(id, item.row.id, kind, finding.fingerprint, fields, at, at);
            continue;
          }
          let state = prior.state, invalidation = prior.invalidation_json;
          if ((state === "dismissed" || state === "snoozed") && prior.disposition_fingerprint !== finding.fingerprint) {
            const before = JSON.parse(prior.disposition_fields_json ?? "{}") as Record<string, string>;
            const changed = Object.keys(finding.fingerprintFields).filter(key => before[key] !== finding.fingerprintFields[key]);
            invalidation = JSON.stringify({ on: isoDay(at), disposition: state, dispositionOn: prior.disposed_at === null ? null : isoDay(prior.disposed_at), changed, previousId: null });
            state = "open";
          } else if (state === "snoozed" && prior.due_at !== null && prior.due_at <= at) state = "open";
          else if (state === "resolved") { state = "open"; invalidation = null; }
          db.query(`UPDATE reference_worktree_findings SET kind = ?, state = ?, fingerprint = ?, fields_json = ?, last_seen = ?, invalidation_json = ?,
            disposition_fingerprint = CASE WHEN ? = 'open' THEN NULL ELSE disposition_fingerprint END, due_at = CASE WHEN ? = 'open' THEN NULL ELSE due_at END WHERE id = ?`)
            .run(kind, state, finding.fingerprint, fields, at, invalidation, state, state, id);
        }
        for (const row of db.query("SELECT id FROM reference_worktree_findings WHERE state != 'resolved'").all() as { id: string }[])
          if (!detected.has(row.id)) db.query("UPDATE reference_worktree_findings SET state = 'resolved', resolved_by = 'detection', resolved_at = ? WHERE id = ?").run(at, row.id);
      }).immediate();
    },
    hygieneCheck(id: string) {
      db.query("UPDATE reference_worktree_findings SET resolved_by = 'check' WHERE id = ? AND state = 'resolved'").run(id);
    },
    hygieneDispose(state: string, fingerprint: string, fields: string, at: number, dueAt: number | null, reason: string | null, id: string) {
      db.query(`UPDATE reference_worktree_findings SET state = ?, disposition_fingerprint = ?, disposition_fields_json = ?, disposed_at = ?, due_at = ?, reason = ?, invalidation_json = NULL WHERE id = ?`).run(state, fingerprint, fields, at, dueAt, reason, id);
    },
    hygieneResolve(handler: string, id: string) {
      db.query("UPDATE reference_worktree_findings SET resolved_by = ? WHERE id = ? AND state = 'resolved'").run(handler, id);
    },
  };
}
