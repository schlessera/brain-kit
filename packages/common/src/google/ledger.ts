import { isWithin } from "../safe-path.js";
/** Private Google approvals, outside the index and worker mounts. No session or mail content. */
import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { GOOGLE_OPERATIONS, type GoogleOperation } from "./catalog.js";

const key = z.string().min(1).max(2048);
const scopeSchema = z.strictObject({ principal_id: key, brain_id: key, account_identity: key });
export interface GoogleApprovalScope { principal_id: string; brain_id: string; account_identity: string }
export interface GoogleApproval extends GoogleApprovalScope {
  id: string; operation: GoogleOperation; entity: string; approved_at: number;
}
export interface GoogleLedger {
  list(brainId: string, principalId?: string): GoogleApproval[];
  approvals(scope: GoogleApprovalScope): GoogleApproval[];
  remember(scope: GoogleApprovalScope, operation: GoogleOperation, entities: readonly string[], at: number): void;
  revoke(brainId: string, id: string, principalId?: string): boolean;
  close(): void;
}

/** The same opaque identity for server and CLI, including symlinked brain paths. */
export function googleBrainId(root: string): string {
  let canonical = root;
  try { canonical = realpathSync(root); } catch { /* Match the missing-root convention of apifyBrainId. */ }
  return createHash("sha256").update(`brain:${canonical}`).digest("hex").slice(0, 32);
}

/** Resolve links before "..", including a not-yet-created ledger tail. */
function canonicalPath(path: string, links = 0): string {
  if (links > 40) throw new Error("Google ledger path has too many links");
  let current = "/";
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    const info = lstatSync(next, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      const link = readlinkSync(next);
      return canonicalPath(`${isAbsolute(link) ? link : current + "/" + link}/${parts.slice(i + 1).join("/")}`, links + 1);
    }
    current = next;
  }
  return current;
}
/** Callers keep this host-only path out of worker environments and mounts. */
export function googleLedgerPath(path: string, brainRoot: string): string {
  if (!isAbsolute(path)) throw new Error("Google ledger requires an absolute path");
  const canonical = canonicalPath(path), brain = realpathSync(brainRoot);
  if (isWithin(brain, canonical, { trailingSeparator: "boundary" })) throw new Error("Google ledger must be outside the brain");
  return canonical;
}

/** Reopen per operation: deletion/replacement must never retain an unlinked approval database.
 * Reads of a missing file are empty and do not create state. Only a grant creates it. */
export function openGoogleLedger(path: string): GoogleLedger {
  let closed = false;
  function use<T>(create: boolean, absent: T, work: (db: Database) => T): T {
    if (closed) throw new Error("Google ledger is closed");
    if (!create && !lstatSync(path, { throwIfNoEntry: false })) return absent;
    if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const uid = process.getuid?.() ?? 0, directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) throw new Error("Google ledger directory must be private");
    if (create) {
      try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    }
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o077) !== 0) throw new Error("Google ledger must be a private regular file");
    const db = new Database(path, { strict: true, create: false });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
      const version = hasMeta ? db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get() : null;
      if (version && version.value !== "1") throw new Error("Google ledger schema version is incompatible");
      if (!version && !create) throw new Error("Google ledger schema version is absent");
      if (create) db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO meta VALUES('schema_version','1');
        CREATE TABLE IF NOT EXISTS remembered_approvals (
          id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, brain_id TEXT NOT NULL, account_identity TEXT NOT NULL,
          operation TEXT NOT NULL, entity TEXT NOT NULL, approved_at INTEGER NOT NULL,
          UNIQUE(principal_id,brain_id,account_identity,operation,entity));`);
      return work(db);
    } finally { db.close(); }
  }
  return {
    list: (brainId, principalId) => {
      key.parse(brainId); if (principalId !== undefined) key.parse(principalId);
      return use(false, [], db => db.query<GoogleApproval, [string, string | null, string | null]>(`SELECT * FROM remembered_approvals
        WHERE brain_id=? AND (? IS NULL OR principal_id=?) ORDER BY approved_at,id`).all(brainId, principalId ?? null, principalId ?? null));
    },
    approvals: raw => {
      const s = scopeSchema.parse(raw);
      return use(false, [], db => db.query<GoogleApproval, [string, string, string]>(`SELECT * FROM remembered_approvals
        WHERE principal_id=? AND brain_id=? AND account_identity=?`).all(s.principal_id, s.brain_id, s.account_identity));
    },
    remember: (raw, operation, entities, at) => use(true, undefined, db => db.transaction(() => {
      const s = scopeSchema.parse(raw); z.enum(GOOGLE_OPERATIONS).parse(operation);
      z.array(key).min(1).max(100).parse(entities); z.number().int().nonnegative().parse(at);
      for (const entity of new Set(entities)) db.query(`INSERT INTO remembered_approvals VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(principal_id,brain_id,account_identity,operation,entity) DO NOTHING`)
        .run(randomUUID(), s.principal_id, s.brain_id, s.account_identity, operation, entity, at);
    }).immediate()),
    revoke: (brainId, id, principalId) => {
      key.parse(brainId); key.parse(id); if (principalId !== undefined) key.parse(principalId);
      return use(false, false, db => db.query("DELETE FROM remembered_approvals WHERE brain_id=? AND id=? AND (? IS NULL OR principal_id=?)")
        .run(brainId, id, principalId ?? null, principalId ?? null).changes > 0);
    },
    close: () => { closed = true; },
  };
}
