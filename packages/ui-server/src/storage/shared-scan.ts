import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { processStart, SELF } from "../brain/writer-gate.js";
import type { Source } from "./history-model.js";
import { storageBrainKey } from "./history-store.js";
import { STORAGE_SERVER_LIMITS, type StorageCollection } from "./collect.js";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import * as scanWrites from "./shared-scan-writes.js";
import { alive, results, type Row, type SharedScan } from "./shared-scan-writes.js";
export type { SharedScan } from "./shared-scan-writes.js";
const CACHE_LIFETIME = 120_000;
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
/** One operational lease for the brain. Only actual cross-process/instance joiners need a disposable file transfer. */
function sharedStorageScan(db: Database, brainPath: string, cacheRoot: string, authorized: (principal: string) => boolean, writer?: SqliteWriter) {
  const brain = storageBrainKey(brainPath);
  const row = () => db.query("SELECT * FROM storage_scan_leases WHERE brain = ?").get(brain) as Row | null;
  function authorize(principal: string) { if (!authorized(principal)) throw Error("storage-scan-owner-revoked"); }
  const procedures = scanWrites.setup(db, { brain, self: SELF }, authorized);
  const call = writer ? procedureCaller(db, scanWrites, { brain, self: SELF }, writer) : null;
  const owned = procedures.check;
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
    acquire(principal: string, id: string, scope: string, source: Source, fresh: boolean, now = Date.now()) {
      if (!call) return procedures.acquire(principal, id, scope, source, fresh, now);
      authorize(principal);
      return call<SharedScan | null>("acquire", principal, id, scope, source, fresh, now);
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
      if (call) await call("reap", scan); else procedures.reap(scan);
    },
    register(scan: SharedScan, pid: number) {
      // Capture the spawned child's identity before queueing: a delayed worker
      // lookup could otherwise record a reused PID as this collector.
      const start = processStart(pid);
      if (!start) return; // a child which already exited needs no reap authority
      return call ? call<void>("register", scan, pid, start) : procedures.register(scan, pid, start);
    },
    unregister(scan: SharedScan, pid: number) { return call ? call<void>("unregister", scan, pid) : procedures.unregister(scan, pid); },
    cancel(scan: SharedScan) {
      if (!call) return procedures.cancel(scan);
      authorize(scan.principal);
      return call<void>("cancel", scan);
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
    finish(scan: SharedScan, cached: boolean, failed: boolean, at = Date.now()) {
      return call ? call<boolean>("finish", scan, cached, failed, at) : procedures.finish(scan, cached, failed, at);
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
export type SharedStorageScan = ReturnType<typeof sharedStorageScan>;
export type InlineSharedScan = Omit<SharedStorageScan, "acquire" | "register" | "unregister" | "cancel" | "finish"> & {
  [K in "acquire" | "register" | "unregister" | "cancel" | "finish"]: (...args: Parameters<SharedStorageScan[K]>) => Awaited<ReturnType<SharedStorageScan[K]>>;
};
export function createSharedStorageScan(db: Database, brainPath: string, cacheRoot: string, authorized: (principal: string) => boolean): InlineSharedScan;
export function createSharedStorageScan(db: Database, brainPath: string, cacheRoot: string, authorized: (principal: string) => boolean, writer?: SqliteWriter): SharedStorageScan;
export function createSharedStorageScan(db: Database, brainPath: string, cacheRoot: string, authorized: (principal: string) => boolean, writer?: SqliteWriter): SharedStorageScan {
  return sharedStorageScan(db, brainPath, cacheRoot, authorized, writer);
}
