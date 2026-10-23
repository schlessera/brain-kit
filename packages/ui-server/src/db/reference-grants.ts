/**
 * Owner-managed reference-source grants (#2429). The maintainer ruling on
 * that issue selects these records as the only authority for private
 * reference acquisition: an owner grants one principal of the served brain a
 * repository prefix and names an existing host credential (or none). A
 * configured credential never grants access by itself, and revoking the grant
 * or its principal blocks new private access immediately.
 * See docs/decisions/reference-source-grants.md.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

import { isCookieBearingPrincipal, isUsablePrincipal, resolvePrincipal } from "./principals.js";

export const MAX_LIVE_REFERENCE_GRANTS = 256;
export const REFERENCE_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_REPOSITORY_LENGTH = 2048;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const GITHUB = "https://github.com";

/**
 * Existing host credential selectors a grant may name, and the origin each may
 * be sent to. Loopback origins stay on this host. No other variable is ever
 * read as a repository credential.
 */
export const REFERENCE_HOST_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  BRAIN_UI_SYNC_GITHUB_TOKEN: GITHUB,
  BRAIN_UI_SKILLS_GITHUB_TOKEN: GITHUB,
  GITHUB_TOKEN: GITHUB,
});

export interface ReferenceRepository {
  /** Authority and sharing key: lowercase origin, path without a trailing slash or `.git`. */
  canonical: string;
  /** The requested location, normalized but otherwise as given; transports fetch this. */
  url: string;
  origin: string;
  scheme: "https" | "http" | "file";
  loopback: boolean;
}

export class ReferenceRepositoryError extends Error {
  constructor(message: string) { super(message); this.name = "ReferenceRepositoryError"; }
}

/**
 * Parse one repository location (or, with `prefix`, a grant prefix that may be
 * a bare origin). Accepts HTTPS without embedded credentials, loopback HTTP and
 * absolute `file://` paths; everything else, including SSH, is refused.
 */
export function referenceRepository(input: unknown, options: { prefix?: boolean } = {}): ReferenceRepository {
  if (typeof input !== "string" || !input || input.length > MAX_REPOSITORY_LENGTH || /[\s\u0000-\u001f\u007f-\u009f\\%]/u.test(input))
    throw new ReferenceRepositoryError("repository must be one absolute URL without whitespace, control characters, backslashes or percent-encoding");
  let url: URL;
  try { url = new URL(input); } catch { throw new ReferenceRepositoryError("repository must be one absolute URL"); }
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== "https" && scheme !== "http" && scheme !== "file") throw new ReferenceRepositoryError("repository must use https, loopback http or file");
  if (url.username || url.password || url.search || url.hash || input.includes("?") || input.includes("#"))
    throw new ReferenceRepositoryError("repository must not embed credentials, a query or a fragment");
  const loopback = scheme !== "file" && LOOPBACK.has(url.hostname);
  if (scheme === "http" && !loopback) throw new ReferenceRepositoryError("plain http is accepted only for loopback repositories");
  if (scheme === "file" && (url.host || !input.startsWith("file:///"))) throw new ReferenceRepositoryError("file repositories must be absolute local paths");
  // The URL parser resolves dot segments; refuse them in the input instead.
  const raw = input.slice(input.indexOf("//") + 2), path = scheme === "file" ? raw : raw.slice(raw.indexOf("/") < 0 ? raw.length : raw.indexOf("/"));
  const segments = path.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (segments.some(segment => !segment || segment === "." || segment === ".."))
    throw new ReferenceRepositoryError("repository path must not contain empty, '.' or '..' segments");
  if (!segments.length && (scheme === "file" || !options.prefix)) throw new ReferenceRepositoryError("repository must name a path");
  const origin = scheme === "file" ? "file://" : url.origin;
  const location = `${origin}${segments.length ? "/" + segments.join("/") : ""}`;
  // A hosted `.git` suffix names the same repository; a local path keeps it.
  const canonical = scheme !== "file" && location.endsWith(".git") && segments.length ? location.slice(0, -4) : location;
  return { canonical, url: location, origin, scheme, loopback };
}

/** Exact match or a path-segment boundary: `…/odysseus` never covers `…/odysseus-crew`. */
export const coversRepository = (prefix: string, repository: string) => repository === prefix || repository.startsWith(`${prefix}/`);

/** Refuse a credential name outside the fixed list, or one whose recipient is not this prefix's origin. */
export function assertGrantCredential(credential: string | null, prefix: ReferenceRepository): void {
  if (credential === null) return;
  const recipient = Object.hasOwn(REFERENCE_HOST_CREDENTIALS, credential) ? REFERENCE_HOST_CREDENTIALS[credential] : undefined;
  if (!recipient) throw new ReferenceRepositoryError(`credential must be null or one of ${Object.keys(REFERENCE_HOST_CREDENTIALS).join(", ")}`);
  if (prefix.scheme === "file") throw new ReferenceRepositoryError("a file repository is read without any credential");
  if (prefix.origin !== recipient && !prefix.loopback) throw new ReferenceRepositoryError(`credential ${credential} may only be sent to ${recipient}`);
}

export interface ReferenceGrant {
  id: string;
  brain: string;
  principalId: string;
  repositoryPrefix: string;
  credential: string | null;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
}

interface GrantRow { id: string; brain: string; principal_id: string; repository_prefix: string; credential: string | null; created_by: string; created_at: number; revoked_at: number | null }
const COLUMNS = "g.id, g.brain, g.principal_id, g.repository_prefix, g.credential, g.created_by, g.created_at, g.revoked_at";
const fromRow = (row: GrantRow): ReferenceGrant => ({ id: row.id, brain: row.brain, principalId: row.principal_id, repositoryPrefix: row.repository_prefix,
  credential: row.credential, createdBy: row.created_by, createdAt: row.created_at, revokedAt: row.revoked_at });
/** A live grant has no revocation and a usable cookie-bearing principal. */
const LIVE = `g.revoked_at IS NULL AND p.revoked_at IS NULL AND p.expires_at > ? AND p.kind IN ('owner', 'agent')`;

export class ReferenceGrantPrincipalError extends Error {
  constructor() { super("reference grants require a live owner or agent principal"); this.name = "ReferenceGrantPrincipalError"; }
}
export class ReferenceGrantLimitError extends Error {
  constructor() { super(`live reference grant limit of ${MAX_LIVE_REFERENCE_GRANTS} reached`); this.name = "ReferenceGrantLimitError"; }
}
export class ReferenceGrantDuplicateError extends Error {
  constructor() { super("an identical live reference grant exists"); this.name = "ReferenceGrantDuplicateError"; }
}

export function createReferenceGrant(db: Database, input: {
  brain: string; principalId: string; repositoryPrefix: unknown; credential: unknown; createdBy: string; now: number;
}): ReferenceGrant {
  const prefix = referenceRepository(input.repositoryPrefix, { prefix: true });
  if (input.credential !== null && typeof input.credential !== "string") throw new ReferenceRepositoryError("credential must be a string or null");
  assertGrantCredential(input.credential, prefix);
  const grant: ReferenceGrant = { id: randomBytes(16).toString("base64url"), brain: input.brain, principalId: input.principalId,
    repositoryPrefix: prefix.canonical, credential: input.credential, createdBy: input.createdBy, createdAt: input.now, revokedAt: null };
  db.transaction(() => {
    const target = resolvePrincipal(db, input.principalId), creator = resolvePrincipal(db, input.createdBy);
    if (!target || !isCookieBearingPrincipal(target) || !isUsablePrincipal(target, input.now)) throw new ReferenceGrantPrincipalError();
    if (!creator || creator.kind !== "owner" || !isUsablePrincipal(creator, input.now)) throw new ReferenceGrantPrincipalError();
    db.prepare("DELETE FROM reference_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(input.now - REFERENCE_GRANT_RETENTION_MS);
    const live = db.prepare(`SELECT COUNT(*) AS count FROM reference_grants g JOIN principals p ON p.id = g.principal_id WHERE ${LIVE}`).get(input.now) as { count: number };
    if (live.count >= MAX_LIVE_REFERENCE_GRANTS) throw new ReferenceGrantLimitError();
    if (db.prepare(`SELECT 1 FROM reference_grants g WHERE g.revoked_at IS NULL AND g.brain = ? AND g.principal_id = ? AND g.repository_prefix = ? AND g.credential IS ?`)
      .get(grant.brain, grant.principalId, grant.repositoryPrefix, grant.credential)) throw new ReferenceGrantDuplicateError();
    db.prepare(`INSERT INTO reference_grants (id, brain, principal_id, repository_prefix, credential, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(grant.id, grant.brain, grant.principalId, grant.repositoryPrefix, grant.credential, grant.createdBy, grant.createdAt);
  }).immediate();
  return grant;
}

/** Live grants of one principal for the served brain, oldest first. */
export function listReferenceGrants(db: Database, brain: string, principalId: string, now: number): ReferenceGrant[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM reference_grants g JOIN principals p ON p.id = g.principal_id
    WHERE ${LIVE} AND g.brain = ? AND g.principal_id = ? ORDER BY g.created_at ASC, g.id ASC`).all(now, brain, principalId) as GrantRow[]).map(fromRow);
}

/** Revoke one live grant of this principal; returns it, or null when none matched. */
export function revokeReferenceGrant(db: Database, input: { brain: string; principalId: string; id: string; now: number }): ReferenceGrant | null {
  const row = db.prepare(`UPDATE reference_grants SET revoked_at = ? WHERE id = ? AND brain = ? AND principal_id = ? AND revoked_at IS NULL
    RETURNING id, brain, principal_id, repository_prefix, credential, created_by, created_at, revoked_at`).get(input.now, input.id, input.brain, input.principalId) as GrantRow | null;
  return row ? fromRow(row) : null;
}

/**
 * The live grant authorizing private access to `repository` for this brain and
 * principal, read at the moment of use: the longest covering prefix, newest
 * first. Null means no private authority, whatever credentials the host holds.
 */
export function coveringReferenceGrant(db: Database, input: { brain: string; principalId: string; repository: ReferenceRepository; now: number }): ReferenceGrant | null {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM reference_grants g JOIN principals p ON p.id = g.principal_id
    WHERE ${LIVE} AND g.brain = ? AND g.principal_id = ? ORDER BY length(g.repository_prefix) DESC, g.created_at DESC, g.id ASC`)
    .all(input.now, input.brain, input.principalId) as GrantRow[];
  const row = rows.find(candidate => coversRepository(candidate.repository_prefix, input.repository.canonical));
  return row ? fromRow(row) : null;
}

/** Whether one recorded grant is still live; in-flight private work rechecks this before publishing. */
export function isLiveReferenceGrant(db: Database, id: string, now: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM reference_grants g JOIN principals p ON p.id = g.principal_id WHERE g.id = ? AND ${LIVE}`).get(id, now));
}
