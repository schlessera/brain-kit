import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

export const MAX_LIVE_PRINCIPALS = 100;
export const PRINCIPAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const MAX_LABEL_LENGTH = 64;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export type PrincipalKind = "owner" | "agent" | "ambient" | "system";
export type PrincipalAuthMethod =
  | "password"
  | "passkey"
  | "delegated"
  | "ambient";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  authMethod: PrincipalAuthMethod;
  label: string;
  credentialId: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface CreatePrincipalInput {
  kind: PrincipalKind;
  authMethod: PrincipalAuthMethod;
  label: string;
  credentialId?: string;
  createdBy?: string;
  ttlSeconds: number;
}

export class PrincipalLimitError extends Error {
  constructor() {
    super(`live principal limit of ${MAX_LIVE_PRINCIPALS} reached`);
    this.name = "PrincipalLimitError";
  }
}

interface PrincipalDbRow {
  id: string;
  kind: PrincipalKind;
  auth_method: PrincipalAuthMethod;
  label: string;
  credential_id: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const PRINCIPAL_COLUMNS = `id, kind, auth_method, label, credential_id,
  created_by, created_at, expires_at, last_seen_at, revoked_at`;

function rowToPrincipal(row: PrincipalDbRow): Principal {
  return {
    id: row.id,
    kind: row.kind,
    authMethod: row.auth_method,
    label: row.label,
    credentialId: row.credential_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function validateLabel(label: string): void {
  if (typeof label !== "string") throw new TypeError("principal label must be a string");
  if (label.length > MAX_LABEL_LENGTH) {
    throw new RangeError(`principal label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  if (CONTROL_CHARACTER.test(label)) {
    throw new RangeError("principal label must not contain control characters");
  }
}

function expiryFromTtl(now: number, ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError("principal ttlSeconds must be a positive safe integer");
  }
  const expiresAt = now + ttlSeconds * 1_000;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("principal expiry must be a safe integer");
  }
  return expiresAt;
}

function generatePrincipalId(): string {
  return randomBytes(16).toString("base64url");
}

export function createPrincipal(db: Database, input: CreatePrincipalInput): Principal {
  validateLabel(input.label);
  const now = Date.now();
  const expiresAt = expiryFromTtl(now, input.ttlSeconds);

  return db.transaction(() => {
    if (countLivePrincipals(db, now) >= MAX_LIVE_PRINCIPALS) {
      throw new PrincipalLimitError();
    }

    let id = generatePrincipalId();
    const idExists = db.prepare("SELECT 1 FROM principals WHERE id = ?");
    while (idExists.get(id)) id = generatePrincipalId();

    db.prepare(
      `INSERT INTO principals
         (id, kind, auth_method, label, credential_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.kind,
      input.authMethod,
      input.label,
      input.credentialId ?? null,
      input.createdBy ?? null,
      now,
      expiresAt
    );

    return resolvePrincipal(db, id)!;
  }).immediate();
}

export function resolvePrincipal(db: Database, id: string): Principal | null {
  const row = db
    .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals WHERE id = ?`)
    .get(id) as PrincipalDbRow | null;
  return row ? rowToPrincipal(row) : null;
}

export function isUsablePrincipal(row: Principal, now: number): boolean {
  assertPrincipalTimestamp(row, "created_at", row.createdAt, false);
  assertPrincipalTimestamp(row, "expires_at", row.expiresAt, false);
  assertPrincipalTimestamp(row, "last_seen_at", row.lastSeenAt, true);
  assertPrincipalTimestamp(row, "revoked_at", row.revokedAt, true);
  return row.revokedAt === null && now < row.expiresAt;
}

function assertPrincipalTimestamp(
  row: Principal,
  column: string,
  value: number | null,
  nullable: boolean
): void {
  if ((nullable && value === null) || Number.isSafeInteger(value)) return;
  throw new Error(`Corrupt principal ${row.id}: ${column} must be an integer`);
}

export function touchLastSeen(db: Database, id: string, now: number): void {
  db.prepare(
    `UPDATE principals SET last_seen_at = ?
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`
  ).run(now, id, now - LAST_SEEN_WRITE_INTERVAL_MS);
}

export function revokePrincipal(db: Database, id: string, now: number): string[] {
  return idsFromRows(
    db
      .prepare(
        "UPDATE principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id"
      )
      .all(now, id) as Array<{ id: string }>
  );
}

export function revokeAllPrincipals(db: Database, now: number): string[] {
  return idsFromRows(
    db
      .prepare(
        "UPDATE principals SET revoked_at = ? WHERE revoked_at IS NULL RETURNING id"
      )
      .all(now) as Array<{ id: string }>
  );
}

export function revokeByCredential(
  db: Database,
  credentialId: string,
  now: number
): string[] {
  return idsFromRows(
    db
      .prepare(
        `UPDATE principals SET revoked_at = ?
         WHERE credential_id = ? AND revoked_at IS NULL RETURNING id`
      )
      .all(now, credentialId) as Array<{ id: string }>
  );
}

function idsFromRows(rows: Array<{ id: string }>): string[] {
  return rows.map(({ id }) => id);
}

export function prunePrincipals(db: Database, now: number): void {
  // Thirty days preserves a useful audit/debug window after a principal stops
  // being usable while still placing a fixed bound on terminal-row growth.
  const cutoff = now - PRINCIPAL_RETENTION_MS;
  db.prepare(
    `DELETE FROM principals
     WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
        OR expires_at < ?`
  ).run(cutoff, cutoff);
}

export function countLivePrincipals(db: Database, now: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM principals WHERE revoked_at IS NULL AND expires_at > ?"
    )
    .get(now) as { count: number };
  return row.count;
}
