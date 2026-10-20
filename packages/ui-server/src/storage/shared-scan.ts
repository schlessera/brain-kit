import type { Database } from "bun:sqlite";
import { constants, readFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { processAlive, processStart, SELF } from "../brain/writer-gate.js";
import { bucket, type Source } from "./history-model.js";
import { storageBrainKey } from "./history-store.js";
import { STORAGE_SERVER_LIMITS, type StorageCollection } from "./collect.js";
const CACHE_LIFETIME = 120_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Worker = { pid: number; start: string };
type Result = { id: string; scope: string; at: number; cached: boolean; failed: boolean };
interface Row { brain: string; job_id: string | null; pid: number | null; process_start: string | null; principal_id: string | null; started_at: number | null; scope: string | null; source: Source | null; workers_json: string; shared: number; results_json: string; cancel_requested: number; last_request_at: number | null; last_attempt_bucket: number | null }
export interface SharedScan {
  id: string; principal: string; scope: string; source: Source; owner: boolean; inherited: Worker[];
}
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
function alive(worker: Worker) {
  if (!processAlive(worker.pid, worker.start)) return false;
  try { const text = readFileSync(`/proc/${worker.pid}/stat`, "utf8"); return text.slice(text.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
  catch { return true; }
}
function workers(row: Row): Worker[] {
  const value = JSON.parse(row.workers_json) as Worker[];
  if (!Array.isArray(value) || value.length > 2 || value.some(item => !Number.isSafeInteger(item.pid) || item.pid <= 0 || !/^\d+$/.test(item.start))) throw Error("storage-lease-workers-unavailable");
  return value;
}
function results(row: Row): Result[] {
  const value = JSON.parse(row.results_json) as Result[];
  if (!Array.isArray(value) || value.length > 2 || value.some(item => !UUID.test(item.id) || !/^[a-f0-9]{32}$/.test(item.scope) || !Number.isSafeInteger(item.at) || typeof item.cached !== "boolean" || typeof item.failed !== "boolean")) throw Error("storage-lease-results-unavailable");
  return value;
}
/** One operational lease for the brain. Only actual cross-process/instance joiners need a disposable file transfer. */
export function createSharedStorageScan(db: Database, brainPath: string, cacheRoot: string, authorized: (principal: string) => boolean) {
  const brain = storageBrainKey(brainPath);
  const row = () => db.query("SELECT * FROM storage_scan_leases WHERE brain = ?").get(brain) as Row | null;
  function authorize(principal: string) { if (!authorized(principal)) throw Error("storage-scan-owner-revoked"); }
  function owned(scan: SharedScan): Row {
    authorize(scan.principal);
    const value = row();
    if (!scan.owner || value?.job_id !== scan.id || value.pid !== SELF.pid || value.process_start !== SELF.start || value.scope !== scan.scope || value.cancel_requested) throw Error("storage-scan-authority-lost");
    return value;
  }
  async function cleanupCache(reserveSlot: boolean, now = Date.now()) {
    if (reserveSlot) await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const directory = await open(cacheRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(error => { if (!reserveSlot && error.code === "ENOENT") return null; throw error; });
    if (!directory) return;
    try {
      const names = await readdir(cacheRoot);
      if (names.length > 8 || names.some(name => !/^[a-f0-9-]{36}\.(?:json|partial)$/.test(name))) throw Error("storage-shared-cache-unavailable");
      const files = await Promise.all(names.map(async name => ({ name, info: await stat(join(cacheRoot, name)) })));
      if (!reserveSlot && row()?.job_id) return;
      for (const file of files) if (file.name.endsWith(".partial") || now - file.info.mtimeMs > CACHE_LIFETIME) await rm(join(cacheRoot, file.name));
      const kept = files.filter(file => !file.name.endsWith(".partial") && now - file.info.mtimeMs <= CACHE_LIFETIME).sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
      while (kept.length > (reserveSlot ? 1 : 2)) await rm(join(cacheRoot, kept.shift()!.name));
    } finally { await directory.close(); }
  }
  return {
    cacheRoot,
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
    async reap(scan: SharedScan) {
      // A dead coordinator's exact worker identities remain durable until their
      // processes stop. Never signal a reused PID or a different owner.
      for (const worker of scan.inherited) {
        if (!alive(worker)) continue;
        try { process.kill(worker.pid, "SIGTERM"); } catch { /* already exited */ }
      }
      const deadline = Date.now() + 1500;
      while (scan.inherited.some(alive) && Date.now() < deadline) await sleep(20);
      for (const worker of scan.inherited) if (alive(worker)) { try { process.kill(worker.pid, "SIGKILL"); } catch { /* already exited */ } }
      const forceDeadline = Date.now() + 1500;
      while (scan.inherited.some(alive) && Date.now() < forceDeadline) await sleep(20);
      if (scan.inherited.some(alive)) throw Error("storage-scan-worker-reap-unavailable");
      db.transaction(() => { owned(scan); db.query("UPDATE storage_scan_leases SET workers_json = '[]' WHERE brain = ? AND job_id = ?").run(brain, scan.id); }).immediate();
    },
    register(scan: SharedScan, pid: number) {
      const start = processStart(pid);
      if (!start) return; // a child which already exited needs no reap authority
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
    async publish(scan: SharedScan, collection: StorageCollection) {
      // An uncontended scan stays in the original bounded memory cache: it does
      // not write a second copy of every filename to disk merely for sampling.
      const needsCache = db.transaction(() => owned(scan).shared === 1).immediate();
      if (!needsCache) return false;
      const serialized = JSON.stringify(collection);
      if (Buffer.byteLength(serialized) > STORAGE_SERVER_LIMITS.cacheBytes / 2) throw Error("storage-shared-cache-budget");
      await cleanupCache(true);
      owned(scan);
      const temporary = join(cacheRoot, `${scan.id}.partial`), destination = join(cacheRoot, `${scan.id}.json`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(serialized); await file.sync(); owned(scan); await rename(temporary, destination); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
      finally { await file.close(); }
      return true;
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
    async wait(scan: SharedScan, signal: AbortSignal): Promise<StorageCollection> {
      const deadline = Date.now() + STORAGE_SERVER_LIMITS.milliseconds;
      while (Date.now() <= deadline) {
        signal.throwIfAborted(); authorize(scan.principal);
        const current = row(), completed = current && results(current).find(value => value.id === scan.id && value.scope === scan.scope);
        if (completed) {
          if (completed.failed || !completed.cached || Date.now() - completed.at > CACHE_LIFETIME || completed.at > Date.now()) throw Error("storage-shared-result-unavailable");
          const file = await open(join(cacheRoot, `${scan.id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await file.stat();
            if (!info.isFile() || info.size > STORAGE_SERVER_LIMITS.cacheBytes / 2) throw Error("storage-shared-result-budget");
            const result = JSON.parse(await file.readFile("utf8")) as StorageCollection;
            if (result.summary?.id !== scan.id || !Array.isArray(result.entries) || result.entries.length > STORAGE_SERVER_LIMITS.entries || result.bytes > STORAGE_SERVER_LIMITS.cacheBytes / 2) throw Error("storage-shared-result-invalid");
            signal.throwIfAborted(); authorize(scan.principal); return result;
          } finally { await file.close(); }
        }
        if (!current?.job_id || current.job_id !== scan.id || !current.pid || current.process_start === null || !alive({ pid: current.pid, start: current.process_start })) throw Error("storage-shared-scan-interrupted");
        await sleep(100);
      }
      throw Error("storage-shared-scan-time-budget");
    },
    cleanupCache() { return cleanupCache(false); },
  };
}
export type SharedStorageScan = ReturnType<typeof createSharedStorageScan>;
