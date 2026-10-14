/** Concrete native-root ownership across app/cron crashes, separate from UI database creation. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { NativeBrainManagerError, type createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { processAlive, SELF } from "./writer-gate.js";

type Client = ReturnType<typeof createNativeBrainManagerClient>;
type Lease = { id: string; kind: "checkpoint" | "stage"; checkpoint_uuid: string | null; stage_lower_id: string | null; stage_allowance: number | null; owner_pid: number; owner_start: string; owner_generation: string; owner_boot: string; owner_pid_namespace: string; state: "creating" | "sealed" | "deleting" };

export async function createNativeBrainLeaseManager(raw: Client, options: {
  statePath: string; brainPath: string; fsid: string; brainUuid: string;
}): Promise<{
  client: Client;
  recoverDeadOwners(): Promise<{ released: string[]; retainedLive: number; retainedUnverifiable: number; unknown: string[] }>;
  close(): Promise<void>;
}> {
  if (!isAbsolute(options.statePath) || options.statePath.includes("\0") || options.statePath.split("/").includes(".."))
    throw Error("Native root leases require one fixed absolute persistent state path.");
  const brain = realpathSync(options.brainPath), parent = dirname(options.statePath);
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), pidNamespace = String(statSync("/proc/self/ns/pid", { bigint: true }).ino);
  // NSpid starts at the mounted procfs PID view. An ancestor's procfs would
  // make processAlive(pid,start) inspect a different task with the same number.
  const procIds = /^NSpid:\s*([^\n]+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1]?.trim().split(/\s+/);
  if (procIds?.length !== 1 || procIds[0] !== String(process.pid)) throw Error("Native lease recovery requires procfs mounted for this process's own PID namespace.");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot) || !SELF.start || !/^[1-9][0-9]*$/.test(pidNamespace)) throw Error("Native lease recovery requires verified Linux boot and PID-namespace identities.");
  if (options.statePath === brain || options.statePath.startsWith(brain + "/")) throw Error("Native root lease state must remain outside the brain.");
  let ancestor = parent;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const futureParent = join(realpathSync(ancestor), relative(ancestor, parent));
  if (futureParent === brain || futureParent.startsWith(brain + "/")) throw Error("Native root lease state is redirected into the brain; no directory may be created there.");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentInfo = lstatSync(parent), actualParent = realpathSync(parent);
  if (actualParent === brain || actualParent.startsWith(brain + "/") || !parentInfo.isDirectory()
    || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o022) !== 0 || ![0, process.geteuid!()].includes(parentInfo.uid))
    throw Error("Native root leases require a protected app-state directory outside the brain.");
  if (!existsSync(options.statePath)) {
    const fd = openSync(options.statePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
  }
  const info = lstatSync(options.statePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.geteuid!() || (info.mode & 0o077))
    throw Error("Native root lease state must be one protected app-owned file.");
  const db = new Database(options.statePath);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if ((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "wal"
      || (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous !== 2)
      throw Error("Native lease state requires durable SQLite WAL/FULL mode before any manager request.");
    db.exec(`CREATE TABLE IF NOT EXISTS native_lease_store (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,brain TEXT NOT NULL,fsid TEXT NOT NULL,brain_uuid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_root_leases (id TEXT PRIMARY KEY,owner_pid INTEGER NOT NULL,owner_start TEXT NOT NULL,owner_generation TEXT NOT NULL,owner_boot TEXT NOT NULL,owner_pid_namespace TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('creating','sealed','deleting')),kind TEXT NOT NULL DEFAULT 'checkpoint' CHECK(kind IN ('checkpoint','stage')),checkpoint_uuid TEXT,stage_lower_id TEXT,stage_allowance INTEGER);`);
    // Earlier records in this same new feature are checkpoint leases.
    if (!(db.query("PRAGMA table_info(native_root_leases)").all() as { name: string }[]).some(column => column.name === "kind"))
      db.exec("ALTER TABLE native_root_leases ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkpoint' CHECK(kind IN ('checkpoint','stage'))");
    for (const [name, type] of [["checkpoint_uuid", "TEXT"], ["stage_lower_id", "TEXT"], ["stage_allowance", "INTEGER"]] as const)
      if (!(db.query("PRAGMA table_info(native_root_leases)").all() as { name: string }[]).some(column => column.name === name)) db.exec(`ALTER TABLE native_root_leases ADD COLUMN ${name} ${type}`);
    const bind = db.transaction(() => {
      const old = db.query("SELECT * FROM native_lease_store WHERE id=1").get() as { version: number; brain: string; fsid: string; brain_uuid: string } | null;
      if (old && (old.version !== 1 || old.brain !== brain || old.fsid !== options.fsid || old.brain_uuid !== options.brainUuid))
        throw Error("Native root lease state belongs to another managed brain; no recovery is authorized.");
      if (!old) db.query("INSERT INTO native_lease_store VALUES (1,1,?,?,?)").run(brain, options.fsid, options.brainUuid);
    }); bind.immediate();
    // WAL FULL syncs committed contents. Explicit directory sync also makes
    // this newly created state path and every mkdir-created ancestor durable;
    // unlike SQLite's portability-oriented directory sync, failures refuse RPC.
    const existingAncestor = realpathSync(ancestor);
    for (let directory = actualParent;; directory = dirname(directory)) {
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      if (directory === existingAncestor) break;
    }
  } catch (error) { db.close(); throw error; }
  const generation = randomUUID();
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  function operation<T>(run: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(Error("Native root lease owner is closed."));
    const result = run(); pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => {}); return result;
  }
  const row = (id: string) => db.query("SELECT * FROM native_root_leases WHERE id=?").get(id) as Lease | null;
  const live = (lease: Lease): boolean | null => lease.owner_boot !== boot ? false
    : lease.owner_pid_namespace !== pidNamespace ? null : processAlive(lease.owner_pid, lease.owner_start);
  const mine = (lease: Lease) => lease.owner_pid === SELF.pid && lease.owner_start === SELF.start && lease.owner_generation === generation && lease.owner_boot === boot && lease.owner_pid_namespace === pidNamespace;
  async function releaseOwned(lease: Lease, signal?: AbortSignal): Promise<{ id: string; state: "deleted" }> {
    // This intent must survive a lost delete reply, and never uses admission's aborted signal.
    db.query("UPDATE native_root_leases SET state='deleting' WHERE id=?").run(lease.id);
    if (lease.kind === "checkpoint" && db.query("SELECT 1 FROM native_root_leases WHERE kind='stage' AND stage_lower_id=? LIMIT 1").get(lease.id))
      throw new NativeBrainManagerError("unknown", "A retained native stage still depends on this checkpoint; reconcile stage deletion first.");
    const result = await (lease.kind === "stage" ? raw.releaseStage(lease.id, signal) : raw.release(lease.id, signal));
    if (result.id !== lease.id || result.state !== "deleted") throw new NativeBrainManagerError("unknown", "Native lease deletion receipt is unreadable; retain and reconcile the same identity.");
    db.query("DELETE FROM native_root_leases WHERE id=? AND owner_pid=? AND owner_start=? AND owner_generation=?").run(lease.id, lease.owner_pid, lease.owner_start, lease.owner_generation);
    return result;
  }
  const client: Client = {
    ...raw,
    checkpoint(id, signal) { return operation(async () => {
      signal?.throwIfAborted();
      db.transaction(() => {
        const lease = row(id);
        if (lease && (!mine(lease) || lease.kind !== "checkpoint" || lease.state === "deleting")) throw new NativeBrainManagerError("unknown", "Checkpoint identity belongs to another live owner or deletion; no admission is authorized.");
        if (!lease) db.query("INSERT INTO native_root_leases(id,owner_pid,owner_start,owner_generation,owner_boot,owner_pid_namespace,state) VALUES (?,?,?,?,?,?,'creating')").run(id, SELF.pid, SELF.start, generation, boot, pidNamespace);
      }).immediate();
      const checkpoint = await raw.checkpoint(id, signal);
      if (checkpoint.id !== id || checkpoint.fsid !== options.fsid || checkpoint.sourceUuid !== options.brainUuid) throw new NativeBrainManagerError("unknown", "Native checkpoint reply does not match its durable lease identity.");
      db.query("UPDATE native_root_leases SET state='sealed',checkpoint_uuid=? WHERE id=? AND owner_pid=? AND owner_start=? AND owner_generation=? AND state='creating'").run(checkpoint.uuid, id, SELF.pid, SELF.start, generation);
      return checkpoint;
    }); },
    delta(from, to, signal) { return operation(async () => {
      for (const id of [from, to]) { const lease = row(id); if (!lease || lease.kind !== "checkpoint" || !mine(lease) || lease.state !== "sealed") throw new NativeBrainManagerError("unknown", "Native delta requires this owner's retained sealed checkpoint leases."); }
      return raw.delta(from, to, signal);
    }); },
    inspectStage(id, signal) { return operation(async () => {
      const lease = row(id); if (!lease || lease.kind !== "stage" || !mine(lease) || lease.state !== "sealed") throw new NativeBrainManagerError("unknown", "Stage inspection requires this owner's retained prepared stage lease.");
      return raw.inspectStage(id, signal);
    }); },
    prepareStage(id, checkpointId, allowanceBytes, signal) { return operation(async () => {
      signal?.throwIfAborted();
      let lowerUuid: string | null = null;
      db.transaction(() => {
        const lower = row(checkpointId), lease = row(id);
        if (!lower || lower.kind !== "checkpoint" || !mine(lower) || lower.state !== "sealed" || !lower.checkpoint_uuid) throw new NativeBrainManagerError("unknown", "Native stage requires this owner's retained sealed checkpoint lease.");
        if (lease && (!mine(lease) || lease.kind !== "stage" || lease.state === "deleting" || lease.stage_lower_id !== checkpointId || lease.stage_allowance !== allowanceBytes)) throw new NativeBrainManagerError("unknown", "Native stage identity belongs to another owner or deletion.");
        lowerUuid = lower.checkpoint_uuid;
        if (!lease) db.query("INSERT INTO native_root_leases(id,owner_pid,owner_start,owner_generation,owner_boot,owner_pid_namespace,state,kind,stage_lower_id,stage_allowance) VALUES (?,?,?,?,?,?,'creating','stage',?,?)").run(id, SELF.pid, SELF.start, generation, boot, pidNamespace, checkpointId, allowanceBytes);
      }).immediate();
      const stage = await raw.prepareStage(id, checkpointId, allowanceBytes, signal);
      if (stage.id !== id || stage.checkpointId !== checkpointId || stage.checkpointUuid !== lowerUuid || stage.sourceUuid !== options.brainUuid || stage.allowanceBytes !== allowanceBytes) throw new NativeBrainManagerError("unknown", "Native stage reply does not match its durable lease identity.");
      db.query("UPDATE native_root_leases SET state='sealed' WHERE id=? AND owner_pid=? AND owner_start=? AND owner_generation=? AND state='creating'").run(id, SELF.pid, SELF.start, generation);
      return stage;
    }); },
    releaseStage(id, signal) { return operation(async () => {
      const lease = row(id);
      if (!lease || lease.kind !== "stage") throw new NativeBrainManagerError("unknown", "This native stage has no recorded lease; arbitrary broker stages cannot be deleted.");
      if (!mine(lease) && lease.state !== "deleting" && live(lease) !== false) throw new NativeBrainManagerError("unknown", "This native stage is still pinned by another live app or cron owner.");
      return releaseOwned(lease, signal);
    }); },
    release(id, signal) { return operation(async () => {
      const lease = row(id);
      if (!lease || lease.kind !== "checkpoint") throw new NativeBrainManagerError("unknown", "This native root has no recorded checkpoint lease; arbitrary broker roots cannot be deleted.");
      if (!mine(lease) && lease.state !== "deleting" && live(lease) !== false) throw new NativeBrainManagerError("unknown", "This native root is still pinned by another live app or cron owner.");
      return releaseOwned(lease, signal);
    }); },
  };
  async function recoverDeadOwners(): Promise<{ released: string[]; retainedLive: number; retainedUnverifiable: number; unknown: string[] }> {
    return operation(async () => {
      const result = { released: [] as string[], retainedLive: 0, retainedUnverifiable: 0, unknown: [] as string[] };
      const leases = db.query("SELECT * FROM native_root_leases ORDER BY (kind='stage') DESC,id").all() as Lease[];
      for (const lease of leases) {
        // A deleting intent already certifies final-pin release, even if the
        // owner's process remains alive after a lost reply or closed instance.
        if (lease.state !== "deleting") {
          const owner = live(lease);
          if (owner === null) { result.retainedUnverifiable++; continue; }
          if (owner) { result.retainedLive++; continue; }
        }
        try { await releaseOwned(lease); result.released.push(lease.id); }
        catch { result.unknown.push(lease.id); }
      }
      return result;
    });
  }
  let closing: Promise<void> | undefined;
  return { client, recoverDeadOwners, close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...pending]);
      const failures: unknown[] = [];
      try {
        const owned = db.query("SELECT * FROM native_root_leases WHERE owner_pid=? AND owner_start=? AND owner_generation=? ORDER BY (kind='stage') DESC,id").all(SELF.pid, SELF.start, generation) as Lease[];
        for (const lease of owned) { try { await releaseOwned(lease); } catch (error) { failures.push(error); } }
      } finally { db.close(); }
      if (failures.length) throw new AggregateError(failures, "Native lease close retains unknown root outcomes for later owner recovery.");
    })();
    return closing;
  } };

}
