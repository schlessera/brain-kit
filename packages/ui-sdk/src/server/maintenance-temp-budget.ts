/** Cross-process admission for maintenance temporary storage (#1708). */
import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { accessSync, closeSync, constants, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkerStateError } from "./worker-state-budget.js";
import { FIRST_PARTY_FAILURE_CLASSES } from "../protocol.js";
import { mib, resolveMaintenanceTempLimits, type WorkerStateLimits } from "./worker-state-limits.js";

interface Identity { pid: number; start: string; boot: string; namespace: string }
interface Entry { id: string; bytes: number; owner: string; worker: string | null; released: number }
/** Internal trusted operational-state identity, never repository-selected. */
export interface MaintenanceTempDomain { statePath: string }
export interface MaintenanceTempReservation {
  readonly id: string;
  readonly directory: string;
  readonly statePath?: string;
  /** The bootstrap attaches its own PID before exec; no repository code has run. */
  release(): void;
}

const directory = () => `/tmp/brain-maintenance-budget-${process.getuid?.() ?? 0}`;
function identity(pid = process.pid): Identity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = fields[19];
  if (!start) throw new Error("maintenance admission requires Linux process start identities");
  return { pid, start, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), namespace: readlinkSync(`/proc/${pid}/ns/pid`) };
}
function alive(value: string): boolean {
  const saved = JSON.parse(value) as Identity;
  try {
    if (saved.boot !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()) return false;
    // A shared ledger must not reinterpret an unrelated PID in another PID
    // namespace as positively dead ownership. Unknown ownership stays held.
    if (saved.namespace !== readlinkSync("/proc/self/ns/pid")) return true;
    const stat = readFileSync(`/proc/${saved.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    if (!state || !fields[19]) throw new Error("maintenance process ownership cannot be verified");
    return state !== "Z" && state !== "X" && fields[19] === saved.start;
  } catch (error) {
    // Only positively dead ownership is recovered. Restricted procfs refuses
    // admission instead of forgetting a live command's reservation.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") {
      // hidepid can conceal a live process as ENOENT. Only the kernel's
      // ESRCH confirms death; a live or inaccessible identity stays held.
      try { process.kill(saved.pid, 0); return true; }
      catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code === "ESRCH") return false;
        if ((signalError as NodeJS.ErrnoException).code === "EPERM") return true;
        throw signalError;
      }
    }
    throw error;
  }
}
/** Canonical state identity also works before the UI database is provisioned. */
function sharedState(domain: MaintenanceTempDomain) {
  if (!isAbsolute(domain.statePath) || domain.statePath === ":memory:") throw new Error("maintenance shared state must be an absolute host path");
  let statePath: string;
  try { statePath = realpathSync(domain.statePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    statePath = join(realpathSync(dirname(domain.statePath)), basename(domain.statePath));
  }
  const parent = dirname(statePath);
  const state = lstatSync(statePath, { throwIfNoEntry: false });
  if (state && !state.isFile()) throw new Error("maintenance state identity must be a regular host file");
  // Preserve existing operational-state access. No chmod/chown of UI state,
  // no new authority for a caller that cannot already write that state.
  accessSync(state ? statePath : parent, constants.R_OK | constants.W_OK | (state ? 0 : constants.X_OK));
  const authority = state ?? lstatSync(parent);
  const mode = state ? state.mode & 0o777 : 0o600;
  const id = createHash("sha256").update(statePath).digest("hex").slice(0, 24);
  return { statePath, parent, authority, mode, file: join(parent, `.brain-maintenance-${id}.db`) };
}
function open(directoryPath: string, domain?: MaintenanceTempDomain): Database {
  let file: string;
  if (domain) {
    const shared = sharedState(domain);
    if (resolve(directoryPath) !== shared.parent) throw new Error("maintenance shared ledger directory does not match its state identity");
    file = shared.file;
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      // Root follows the existing state's owner; a group-authorized caller
      // keeps its own uid and the existing state's group. Kernel permissions
      // determine access, exactly as they do for the shared UI database.
      fchownSync(fd, process.getuid?.() === 0 ? shared.authority.uid : -1, shared.authority.gid);
      fchmodSync(fd, shared.mode);
    } catch (error) {
      if (fd !== undefined) { try { unlinkSync(file); } catch {} }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
    const node = lstatSync(file);
    if (!node.isFile() || node.nlink !== 1 || (node.mode & 0o777 & ~shared.mode) !== 0
      || ((node.mode & 0o070) !== 0 && node.gid !== shared.authority.gid)) {
      throw new Error("maintenance shared ledger must preserve existing state access and be an unlinked regular file");
    }
  } else {
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    const info = lstatSync(directoryPath);
    if (!info.isDirectory() || info.uid !== (process.getuid?.() ?? 0) || (info.mode & 0o077) !== 0) {
      throw new Error("maintenance admission requires an owned private directory outside the brain");
    }
    file = join(directoryPath, "reservations.db");
    try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const node = lstatSync(file);
    if (!node.isFile() || node.nlink !== 1 || node.uid !== info.uid || (node.mode & 0o077) !== 0) throw new Error("maintenance admission database must be an owned private regular file");
  }
  // Node consumers may import the SDK/Claude entry without running Bun-only
  // maintenance. Resolve its database only when that runtime actually runs.
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(file, { strict: true });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, owner TEXT NOT NULL, worker TEXT, released INTEGER NOT NULL DEFAULT 0)");
    return db;
  } catch (error) { db.close(); throw error; }
}
function prune(db: Database): Entry[] {
  const entries = db.query("SELECT * FROM reservations").all() as Entry[];
  return entries.filter(entry => {
    const workerAlive = entry.worker !== null && alive(entry.worker);
    if (!workerAlive && (entry.released || !alive(entry.owner))) {
      db.query("DELETE FROM reservations WHERE id = ?").run(entry.id);
      return false;
    }
    return true;
  });
}

/** Immediate atomic admission, shared by server, cron and recreated backends. */
export function reserveMaintenanceTemp(configured: WorkerStateLimits, domain?: MaintenanceTempDomain): MaintenanceTempReservation {
  const limits = resolveMaintenanceTempLimits(configured);
  const shared = domain ? sharedState(domain) : undefined;
  const path = shared?.parent ?? directory();
  const selected = shared ? { statePath: shared.statePath } : undefined;
  const db = open(path, selected);
  const id = randomUUID();
  try {
    db.transaction(() => {
      const entries = prune(db);
      const held = entries.reduce((total, entry) => total + BigInt(entry.bytes), 0n);
      if (held + BigInt(limits.allowanceBytes) > BigInt(limits.budgetBytes)) {
        throw new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_busy,
          `Maintenance temporary storage is busy: this command needs ${mib(limits.allowanceBytes)}, `
          + `${entries.length} maintenance reservations hold ${mib(Number(held))} of the separate ${mib(limits.budgetBytes)} budget. `
          + "Nothing ran. Retry after a maintenance command finishes; no agent runtime state was lost.");
      }
      db.query("INSERT INTO reservations (id, bytes, owner) VALUES (?, ?, ?)").run(id, limits.allowanceBytes, JSON.stringify(identity()));
    }).immediate();
  } finally { db.close(); }
  let released = false;
  return { id, directory: path, ...(selected ?? {}), release() {
    if (released) return;
    const db = open(path, selected);
    try {
      db.transaction(() => {
        db.query("UPDATE reservations SET released = 1 WHERE id = ?").run(id);
        prune(db);
      }).immediate();
      released = true;
    } finally { db.close(); }
  } };
}

/** Trusted bootstrap only: attach before exec, refusing an abandoned admission. */
export function attachMaintenanceTemp(reservation: Pick<MaintenanceTempReservation, "id" | "directory" | "statePath">): void {
  if (!reservation.statePath && reservation.directory !== directory()) throw new Error("maintenance admission directory does not match the host identity");
  const db = open(reservation.directory, reservation.statePath ? { statePath: reservation.statePath } : undefined);
  try {
    db.transaction(() => {
      const entry = db.query("SELECT * FROM reservations WHERE id = ?").get(reservation.id) as Entry | null;
      if (!entry || entry.released || entry.worker || !alive(entry.owner)) throw new Error("maintenance admission no longer belongs to a live launcher");
      db.query("UPDATE reservations SET worker = ? WHERE id = ?").run(JSON.stringify(identity()), entry.id);
    }).immediate();
  } finally { db.close(); }
}
