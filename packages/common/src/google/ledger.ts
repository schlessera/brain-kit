/** Private Google approvals, outside the index and worker mounts. No session or mail content. */
import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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

/** The caller validates the home and keeps it outside worker mounts. */
export function openGoogleLedger(path: string): GoogleLedger {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const uid = process.getuid?.() ?? 0, directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) throw new Error("Google ledger directory must be private");
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  const file = lstatSync(path);
  if (!file.isFile() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o077) !== 0) throw new Error("Google ledger must be a private regular file");
  const db = new Database(path, { strict: true });
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS remembered_approvals (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, brain_id TEXT NOT NULL, account_identity TEXT NOT NULL,
        operation TEXT NOT NULL, entity TEXT NOT NULL, approved_at INTEGER NOT NULL,
        UNIQUE(principal_id,brain_id,account_identity,operation,entity));`);
  } catch (cause) { db.close(); throw cause; }
  return {
    list: (brainId, principalId) => {
      key.parse(brainId); if (principalId !== undefined) key.parse(principalId);
      return db.query<GoogleApproval, [string, string | null, string | null]>(`SELECT * FROM remembered_approvals
        WHERE brain_id=? AND (? IS NULL OR principal_id=?) ORDER BY approved_at,id`).all(brainId, principalId ?? null, principalId ?? null);
    },
    approvals: raw => {
      const s = scopeSchema.parse(raw);
      return db.query<GoogleApproval, [string, string, string]>(`SELECT * FROM remembered_approvals
        WHERE principal_id=? AND brain_id=? AND account_identity=?`).all(s.principal_id, s.brain_id, s.account_identity);
    },
    remember: (raw, operation, entities, at) => db.transaction(() => {
      const s = scopeSchema.parse(raw); z.enum(GOOGLE_OPERATIONS).parse(operation);
      z.array(key).min(1).max(100).parse(entities); z.number().int().nonnegative().parse(at);
      for (const entity of new Set(entities)) db.query(`INSERT INTO remembered_approvals VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(principal_id,brain_id,account_identity,operation,entity) DO NOTHING`)
        .run(randomUUID(), s.principal_id, s.brain_id, s.account_identity, operation, entity, at);
    }).immediate(),
    revoke: (brainId, id, principalId) => {
      key.parse(brainId); key.parse(id); if (principalId !== undefined) key.parse(principalId);
      return db.query("DELETE FROM remembered_approvals WHERE brain_id=? AND id=? AND (? IS NULL OR principal_id=?)")
        .run(brainId, id, principalId ?? null, principalId ?? null).changes > 0;
    },
    close: () => db.close(),
  };
}
