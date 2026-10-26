/** Shared scan transactions run unchanged on the FULL write connection. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { processAlive } from "../brain/writer-gate.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { bucket, type Source } from "./history-model.js";
export const url = import.meta.url;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type Worker = { pid: number; start: string };
type Result = { id: string; scope: string; at: number; cached: boolean; failed: boolean };
export interface Row { brain: string; job_id: string | null; pid: number | null; process_start: string | null; principal_id: string | null; started_at: number | null; scope: string | null; source: Source | null; workers_json: string; shared: number; results_json: string; cancel_requested: number; last_request_at: number | null; last_attempt_bucket: number | null }
export interface SharedScan {
  id: string; principal: string; scope: string; source: Source; owner: boolean; inherited: Worker[];
}
export function alive(worker: Worker) {
  if (!processAlive(worker.pid, worker.start)) return false;
  try { const text = readFileSync(`/proc/${worker.pid}/stat`, "utf8"); return text.slice(text.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
  catch { return true; }
}
function workers(row: Row): Worker[] {
  const value = JSON.parse(row.workers_json) as Worker[];
  if (!Array.isArray(value) || value.length > 2 || value.some(item => !Number.isSafeInteger(item.pid) || item.pid <= 0 || !/^\d+$/.test(item.start))) throw Error("storage-lease-workers-unavailable");
  return value;
}
export function results(row: Row): Result[] {
  const value = JSON.parse(row.results_json) as Result[];
  if (!Array.isArray(value) || value.length > 2 || value.some(item => !UUID.test(item.id) || !/^[a-f0-9]{32}$/.test(item.scope) || !Number.isSafeInteger(item.at) || typeof item.cached !== "boolean" || typeof item.failed !== "boolean")) throw Error("storage-lease-results-unavailable");
  return value;
}
export function setup(db: Database, { brain, self: SELF }: { brain: string; self: { pid: number; start: string } }, authorized = (id: string) => {
  const principal = resolvePrincipal(db, id);
  return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now());
}) {
  const row = () => db.query("SELECT * FROM storage_scan_leases WHERE brain = ?").get(brain) as Row | null;
  function authorize(principal: string) { if (!authorized(principal)) throw Error("storage-scan-owner-revoked"); }
  function owned(scan: SharedScan): Row {
    authorize(scan.principal);
    const value = row();
    if (!scan.owner || value?.job_id !== scan.id || value.pid !== SELF.pid || value.process_start !== SELF.start || value.scope !== scan.scope || value.cancel_requested) throw Error("storage-scan-authority-lost");
    return value;
  }
  return {
    acquire(principal: string, id: string, scope: string, source: Source, fresh: boolean, now = Date.now()): SharedScan | null {
      authorize(principal);
      if (!UUID.test(id) || !/^[a-f0-9]{32}$/.test(scope)) throw Error("storage-scan-identity-invalid");
      return db.transaction(() => {
        const current = row();
        if (current?.job_id && current.pid && current.process_start !== null && alive({ pid: current.pid, start: current.process_start })) {
          if (current.scope !== scope) throw Error("storage-scan-other-scope-busy");
          db.query("UPDATE storage_scan_leases SET shared = 1 WHERE brain = ? AND job_id = ?").run(brain, current.job_id);
          return { id: current.job_id, principal, scope, source: current.source!, owner: false, inherited: [] };
        }
        if (current?.last_request_at !== null && current?.last_request_at !== undefined && now < current.last_request_at) throw Error("storage-scan-clock-reversal");
        if (source === 0 && current?.last_attempt_bucket !== null && current?.last_attempt_bucket !== undefined && current.last_attempt_bucket >= bucket(0, now)) return null;
        if (!fresh && current?.last_request_at !== null && current?.last_request_at !== undefined && now - current.last_request_at < 5000) throw Error("storage-scan-cooldown");
        const inherited = current ? workers(current) : [];
        db.query(`INSERT INTO storage_scan_leases (brain, job_id, pid, process_start, principal_id, started_at, scope, source, last_request_at, last_attempt_bucket)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(brain) DO UPDATE SET job_id = excluded.job_id, pid = excluded.pid, process_start = excluded.process_start,
            principal_id = excluded.principal_id, started_at = excluded.started_at, scope = excluded.scope, source = excluded.source,
            cancel_requested = 0, shared = 0, last_request_at = excluded.last_request_at, last_attempt_bucket = excluded.last_attempt_bucket`)
          .run(brain, id, SELF.pid, SELF.start, principal, now, scope, source, now, bucket(0, now));
        return { id, principal, scope, source, owner: true, inherited };
      }).immediate();
    },
    check: owned,
    reap(scan: SharedScan) {
      db.transaction(() => { owned(scan); db.query("UPDATE storage_scan_leases SET workers_json = '[]' WHERE brain = ? AND job_id = ?").run(brain, scan.id); }).immediate();
    },
    register(scan: SharedScan, pid: number, start: string) {
      db.transaction(() => {
        const value = workers(owned(scan));
        if (value.length >= 2) throw Error("storage-scan-worker-budget");
        value.push({ pid, start });
        db.query("UPDATE storage_scan_leases SET workers_json = ? WHERE brain = ? AND job_id = ?").run(JSON.stringify(value), brain, scan.id);
      }).immediate();
    },
    unregister(scan: SharedScan, pid: number) {
      db.transaction(() => {
        const value = row();
        if (value?.job_id !== scan.id || value.pid !== SELF.pid || value.process_start !== SELF.start) return;
        db.query("UPDATE storage_scan_leases SET workers_json = ? WHERE brain = ? AND job_id = ?").run(JSON.stringify(workers(value).filter(worker => worker.pid !== pid)), brain, scan.id);
      }).immediate();
    },
    cancel(scan: SharedScan) {
      authorize(scan.principal);
      db.query("UPDATE storage_scan_leases SET cancel_requested = 1 WHERE brain = ? AND job_id = ? AND scope = ?").run(brain, scan.id, scan.scope);
    },
    finish(scan: SharedScan, cached: boolean, failed: boolean, at = Date.now()): boolean {
      return db.transaction(() => {
        const current = row();
        if (current?.job_id !== scan.id || current.pid !== SELF.pid || current.process_start !== SELF.start) return false;
        if (!failed) owned(scan);
        if (workers(current).some(alive)) return false;
        // A joiner may arrive just after publish() checked the flag. Keep the
        // lease until its full result has been published, then retry finish.
        if (!failed && current.shared && !cached) return false;
        const completed = [...results(current), { id: scan.id, scope: scan.scope, at, cached, failed }].slice(-2);
        db.query(`UPDATE storage_scan_leases SET job_id = NULL, pid = NULL, process_start = NULL, principal_id = NULL,
          started_at = NULL, scope = NULL, source = NULL, workers_json = '[]', cancel_requested = 0, shared = 0,
          results_json = ?, result_id = ?, result_at = ?, failure = ? WHERE brain = ? AND job_id = ?`)
          .run(JSON.stringify(completed), scan.id, at, failed ? "collection-unavailable" : null, brain, scan.id);
        return true;
      }).immediate();
    },
  };
}
