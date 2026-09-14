import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

export const MAX_LIVE_PRINCIPALS = 100;
export const PRINCIPAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const PRINCIPAL_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const MAX_LABEL_LENGTH = 64;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const lastPrincipalPruneByDb = new WeakMap<Database, number>();

export type PrincipalKind = "owner" | "agent" | "ambient" | "system";
export type PrincipalAuthMethod =
  | "password"
  | "passkey"
  | "delegated"
  | "ambient";

export type AmbientPrincipalSource = "none" | "proxy" | "tailscale";

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
  authMethod: Exclude<PrincipalAuthMethod, "ambient">;
  label: string;
  credentialId?: string;
  createdBy?: string;
  ttlSeconds: number;
}

export interface ResolveSystemPrincipalInput {
  identity: string;
  label: string;
}

export class PrincipalLimitError extends Error {
  constructor() {
    super(`live principal limit of ${MAX_LIVE_PRINCIPALS} reached`);
    this.name = "PrincipalLimitError";
  }
}

export class PrincipalCredentialNotFoundError extends Error {
  constructor(credentialId: string) {
    super(`passkey credential ${credentialId} no longer exists`);
    this.name = "PrincipalCredentialNotFoundError";
  }
}

export class PrincipalCreatorNotUsableError extends Error {
  constructor(createdBy: string | undefined) {
    super(`principal creator ${createdBy ?? "(missing)"} is not a usable owner`);
    this.name = "PrincipalCreatorNotUsableError";
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

function ambientPrincipalId(
  source: AmbientPrincipalSource,
  identity: string
): string {
  return createHash("sha256")
    .update("brain-ui:ambient-principal:v1\0")
    .update(source)
    .update("\0")
    .update(identity)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function systemPrincipalId(identity: string): string {
  return createHash("sha256")
    .update("brain-ui:system-principal:v1\0")
    .update(identity)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function kindFromAuthMethod(
  authMethod: CreatePrincipalInput["authMethod"]
): "owner" | "agent" {
  switch (authMethod) {
    case "password":
    case "passkey":
      return "owner";
    case "delegated":
      return "agent";
    default:
      throw new TypeError(`unsupported principal auth method: ${String(authMethod)}`);
  }
}

export function createPrincipal(db: Database, input: CreatePrincipalInput): Principal {
  validateLabel(input.label);

  return db.transaction(() => {
    const now = Date.now();
    const expiresAt = expiryFromTtl(now, input.ttlSeconds);
    if (input.authMethod === "delegated") {
      // Request authentication may precede an awaited body read. Re-check the
      // creator only after taking the write lock, in the transaction that
      // inserts the delegated row, so revocation cannot race this authority.
      const creator = input.createdBy
        ? resolvePrincipal(db, input.createdBy)
        : null;
      if (
        !creator ||
        creator.kind !== "owner" ||
        !isUsablePrincipal(creator, now)
      ) {
        throw new PrincipalCreatorNotUsableError(input.createdBy);
      }
    }
    if (
      input.credentialId !== undefined &&
      !db.prepare("SELECT 1 FROM passkey_credentials WHERE id = ?").get(input.credentialId)
    ) {
      throw new PrincipalCredentialNotFoundError(input.credentialId);
    }
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
      kindFromAuthMethod(input.authMethod),
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

/**
 * Resolve the durable attribution row for an ambient authorization identity.
 * The id is deterministic per mode and full identity so repeated requests —
 * including concurrent first requests — cannot grow one row per authorization
 * check, while bounded display-label collisions remain distinct.
 */
export function resolveAmbientPrincipal(
  db: Database,
  source: AmbientPrincipalSource,
  identity: string,
  label: string
): Principal {
  validateLabel(label);
  const id = ambientPrincipalId(source, identity);
  const existing = resolvePrincipal(db, id);
  if (existing) return resolveStoredIdentity(db, existing, label, "ambient");

  return db.transaction(() => {
    let principal = resolvePrincipal(db, id);
    if (!principal) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO principals
           (id, kind, auth_method, label, credential_id, created_by,
            created_at, expires_at, last_seen_at)
         VALUES (?, 'ambient', 'ambient', ?, NULL, NULL, ?, ?, ?)`
      ).run(id, label, now, Number.MAX_SAFE_INTEGER, now);
      principal = resolvePrincipal(db, id)!;
    }

    return resolveStoredIdentity(db, principal, label, "ambient");
  }).immediate();
}

/** Resolve the durable attribution row for a non-cookie system identity. */
export function resolveSystemPrincipal(
  db: Database,
  input: ResolveSystemPrincipalInput
): Principal {
  validateLabel(input.label);
  const id = systemPrincipalId(input.identity);
  const existing = resolvePrincipal(db, id);
  if (existing) return resolveStoredIdentity(db, existing, input.label, "system");

  return db.transaction(() => {
    let principal = resolvePrincipal(db, id);
    if (!principal) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO principals
           (id, kind, auth_method, label, credential_id, created_by,
            created_at, expires_at)
         VALUES (?, 'system', 'ambient', ?, NULL, NULL, ?, ?)`
      ).run(id, input.label, now, Number.MAX_SAFE_INTEGER);
      principal = resolvePrincipal(db, id)!;
    }
    return resolveStoredIdentity(db, principal, input.label, "system");
  }).immediate();
}

function resolveStoredIdentity(
  db: Database,
  principal: Principal,
  label: string,
  kind: "ambient" | "system"
): Principal {
  if (
    principal.kind !== kind ||
    principal.authMethod !== "ambient" ||
    !isUsablePrincipal(principal, Date.now())
  ) {
    throw new Error(`Corrupt ${kind} principal ${principal.id}`);
  }
  if (principal.label !== label) {
    db.prepare("UPDATE principals SET label = ? WHERE id = ?").run(
      label,
      principal.id
    );
    principal = { ...principal, label };
  }
  if (kind === "ambient") {
    // The UPDATE's WHERE throttles the write, but issuing it at all starts an
    // implicit write transaction — on every request, in three of four auth
    // modes. Decide from the row already in hand; the SQL predicate stays as
    // the concurrency guard for the writes that do happen.
    const now = Date.now();
    if (isLastSeenStale(principal.lastSeenAt, now)) {
      touchLastSeen(db, principal.id, now);
      principal = { ...principal, lastSeenAt: now };
    }
  }
  return principal;
}

export function resolvePrincipal(db: Database, id: string): Principal | null {
  const row = db
    .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals WHERE id = ?`)
    .get(id) as PrincipalDbRow | null;
  return row ? rowToPrincipal(row) : null;
}

/** List currently usable cookie-bearing principals, newest first. */
export function listLivePrincipals(db: Database, now: number): Principal[] {
  return (
    db
      .prepare(
        `SELECT ${PRINCIPAL_COLUMNS} FROM principals
         WHERE kind IN ('owner', 'agent')
           AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, id ASC`
      )
      .all(now) as PrincipalDbRow[]
  ).map(rowToPrincipal);
}

export function isUsablePrincipal(row: Principal, now: number): boolean {
  assertPrincipalTimestamp(row, "created_at", row.createdAt, false);
  assertPrincipalTimestamp(row, "expires_at", row.expiresAt, false);
  assertPrincipalTimestamp(row, "last_seen_at", row.lastSeenAt, true);
  assertPrincipalTimestamp(row, "revoked_at", row.revokedAt, true);
  return row.revokedAt === null && now < row.expiresAt;
}

/** Whether this principal kind may be carried by an authenticated cookie. */
export function isCookieBearingPrincipal(
  principal: Principal
): principal is Principal & { kind: "owner" | "agent" } {
  return principal.kind === "owner" || principal.kind === "agent";
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

/** Whether a stored last_seen_at is old enough to be worth a write. */
export function isLastSeenStale(lastSeenAt: number | null, now: number): boolean {
  return lastSeenAt === null || lastSeenAt < now - LAST_SEEN_WRITE_INTERVAL_MS;
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
        `UPDATE principals SET revoked_at = ?
         WHERE id = ? AND kind IN ('owner', 'agent')
           AND revoked_at IS NULL RETURNING id`
      )
      .all(now, id) as Array<{ id: string }>
  );
}

export function revokeAllPrincipals(db: Database, now: number): string[] {
  return idsFromRows(
    db
      .prepare(
        `UPDATE principals SET revoked_at = ?
         WHERE kind IN ('owner', 'agent')
           AND revoked_at IS NULL RETURNING id`
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
     WHERE (kind = 'ambient' AND COALESCE(last_seen_at, created_at) < ?)
        OR (kind <> 'ambient' AND (
          (revoked_at IS NOT NULL AND revoked_at < ?)
          OR expires_at < ?
        ))`
  ).run(cutoff, cutoff, cutoff);
}

/**
 * Run principal retention at most once per database per process interval.
 * Authentication paths call this cheaply; only the due call reaches SQLite.
 */
export function prunePrincipalsIfDue(db: Database, now: number): boolean {
  const lastPrunedAt = lastPrincipalPruneByDb.get(db);
  if (
    lastPrunedAt !== undefined &&
    now >= lastPrunedAt &&
    now - lastPrunedAt < PRINCIPAL_PRUNE_INTERVAL_MS
  ) {
    return false;
  }
  prunePrincipals(db, now);
  lastPrincipalPruneByDb.set(db, now);
  return true;
}

export function countLivePrincipals(db: Database, now: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM principals
       WHERE kind IN ('owner', 'agent')
         AND revoked_at IS NULL AND expires_at > ?`
    )
    .get(now) as { count: number };
  return row.count;
}
