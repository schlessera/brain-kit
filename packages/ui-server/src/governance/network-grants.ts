/**
 * Host-owned standing network grants for tainted chat sessions (#3595).
 *
 * Grants are persisted as `network_grant` governance events keyed to the exact
 * session and its history generation, and revoked by `network_grant_revoked`.
 * Managed acquisitions (`managedReference: true`) never create or match grants.
 */
import type { NetworkGrantView } from "@schlessera/brain-ui-sdk/protocol";
import { canonicalEgressHost } from "@schlessera/brain-ui-sdk/internal";
import type { Database } from "bun:sqlite";
import { GOVERNANCE_EVENT_SCHEMAS } from "./events.js";
import { principalAccount } from "../middleware/account-partition.js";

/**
 * Resolve the canonical account owner for a session, checking `dialogue_owners`,
 * `safety_sessions` (plus its `history_owner_id`), and `chat_session_owners`
 * (including stored `principal_account`). Returns `null` when ownership cannot
 * be proven so callers fail closed (#3595).
 */
export function resolveSessionOwner(db: Database, sessionId: string): { principalId: string; account: string | null } | null {
  const dialogue = db.query<{ principal_id: string | null; principal_account: string | null }, [string]>(
    "SELECT principal_id, principal_account FROM dialogue_owners WHERE session_id=?"
  ).get(sessionId);
  if (dialogue?.principal_id) {
    return { principalId: dialogue.principal_id, account: dialogue.principal_account };
  }
  const safety = db.query<{ principal_id: string | null; principal_account: string | null; history_owner_id: string | null }, [string]>(
    "SELECT principal_id, principal_account, history_owner_id FROM safety_sessions WHERE session_id=?"
  ).get(sessionId);
  if (safety?.principal_id) {
    return { principalId: safety.principal_id, account: safety.principal_account };
  }
  if (safety?.history_owner_id) {
    const owner = db.query<{ principal_id: string | null; principal_account: string | null }, [string]>(
      "SELECT principal_id, principal_account FROM dialogue_owners WHERE id=?"
    ).get(safety.history_owner_id);
    if (owner?.principal_id) {
      return { principalId: owner.principal_id, account: owner.principal_account };
    }
  }
  const catalog = db.query<{ principal_id: string; principal_account: string | null }, [string]>(
    "SELECT principal_id, principal_account FROM chat_session_owners WHERE session_id=?"
  ).get(sessionId);
  if (catalog?.principal_id) {
    return {
      principalId: catalog.principal_id,
      account: catalog.principal_account ?? principalAccount(db, catalog.principal_id),
    };
  }
  return null;
}

interface CanonicalNetworkOrigin {
  /** Grouping key: `[managed:]scheme://host:port`. */
  key: string;
  transport: "http" | "connect";
  scheme: "http" | "https" | "connect";
  host: string;
  port: number;
  managedReference: boolean;
}

/**
 * Canonical origin identity (#4966, #3595): scheme + canonical host + effective
 * port + `managedReference`. Distinguishes cleartext HTTP from opaque CONNECT
 * tunnels, ports, subdomains, and managed GitHub acquisitions.
 */
export function canonicalNetworkOrigin(destination: {
  host: string;
  port: number;
  method: string;
  protocol?: string;
  managedReference?: boolean;
}): CanonicalNetworkOrigin {
  const host = canonicalEgressHost(destination.host);
  const transport: "http" | "connect" = destination.method === "CONNECT" ? "connect" : "http";
  const scheme: "http" | "https" | "connect" =
    transport === "connect" ? "connect" : destination.protocol === "https:" ? "https" : "http";
  const port = destination.port;
  const managedReference = destination.managedReference === true;
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  const key = `${managedReference ? "managed:" : ""}${scheme}://${formattedHost}:${port}`;
  return { key, transport, scheme, host, port, managedReference };
}

interface StoredGrant {
  grantId: string;
  scope: "origin" | "session";
  origin?: string;
  transport?: "http" | "connect";
  scheme?: "http" | "https" | "connect";
  host?: string;
  port?: number;
  grantedClasses: string[];
  historyGeneration: string;
  createdAt: number;
}

/**
 * Read the latest grant per `(scope, origin)` for one session + history
 * generation, excluding revoked grants. If a newer grant superseded an earlier
 * one for the same target, revoking the newer grant never resurrects the old.
 */
function readCurrentGrants(db: Database, sessionId: string, historyGeneration: string): StoredGrant[] {
  const rows = db.query<{ kind: string; schema_version: number; at: number; payload: string }, [string]>(
    `SELECT kind, schema_version, at, payload FROM governance_events
      WHERE session_id = ? AND kind IN ('network_grant', 'network_grant_revoked')
      ORDER BY id ASC`
  ).all(sessionId);

  const revoked = new Set<string>();
  const latestByTarget = new Map<string, StoredGrant>();
  const grantSpec = GOVERNANCE_EVENT_SCHEMAS.network_grant;
  const revokeSpec = GOVERNANCE_EVENT_SCHEMAS.network_grant_revoked;

  for (const row of rows) {
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(row.payload); } catch { continue; }
    if (row.kind === "network_grant_revoked") {
      if (row.schema_version !== revokeSpec.version) continue;
      const checked = revokeSpec.payload.safeParse(parsedJson);
      if (checked.success) revoked.add(checked.data.grantId);
      continue;
    }
    if (row.kind !== "network_grant" || row.schema_version !== grantSpec.version) continue;
    const checked = grantSpec.payload.safeParse(parsedJson);
    if (!checked.success) continue;
    const payload = checked.data;
    if (payload.historyGeneration !== historyGeneration) continue;
    if (payload.scope === "origin") {
      if (!payload.origin || payload.origin.startsWith("managed:") || !payload.transport || !payload.scheme || !payload.host || payload.port === undefined) {
        continue;
      }
    } else if (payload.origin !== undefined || payload.transport !== undefined || payload.scheme !== undefined || payload.host !== undefined || payload.port !== undefined) {
      continue;
    }
    const targetKey = payload.scope === "session" ? "session" : `origin:${payload.origin}`;
    latestByTarget.set(targetKey, {
      grantId: payload.grantId,
      scope: payload.scope,
      ...(payload.origin !== undefined ? { origin: payload.origin } : {}),
      ...(payload.transport !== undefined ? { transport: payload.transport } : {}),
      ...(payload.scheme !== undefined ? { scheme: payload.scheme } : {}),
      ...(payload.host !== undefined ? { host: payload.host } : {}),
      ...(payload.port !== undefined ? { port: payload.port } : {}),
      grantedClasses: [...payload.grantedClasses],
      historyGeneration,
      createdAt: row.at,
    });
  }

  return [...latestByTarget.values()].filter((g) => !revoked.has(g.grantId));
}

export function listActiveNetworkGrants(
  db: Database,
  sessionId: string,
  historyGeneration: string,
  currentClasses: readonly string[]
): NetworkGrantView[] {
  return readCurrentGrants(db, sessionId, historyGeneration).map((grant) => ({
    grantId: grant.grantId,
    scope: grant.scope,
    ...(grant.origin ? { origin: grant.origin } : {}),
    ...(grant.transport ? { transport: grant.transport } : {}),
    ...(grant.scheme ? { scheme: grant.scheme } : {}),
    ...(grant.host ? { host: grant.host } : {}),
    ...(grant.port !== undefined ? { port: grant.port } : {}),
    grantedClasses: [...grant.grantedClasses],
    suspended: currentClasses.some((cls) => !grant.grantedClasses.includes(cls)),
    createdAt: grant.createdAt,
  }));
}

type NetworkGrantMatch =
  | { kind: "standing"; scope: "origin" | "session"; grantId: string }
  | { kind: "suspended"; scope: "origin" | "session"; grantId: string; newClasses: readonly string[] }
  | null;

/**
 * Evaluate standing grants for one non-managed destination in an interactive
 * session. Prefer an exact active origin grant, else an active session grant.
 * If a matching grant exists but a new untrusted-input class arrived since it
 * was granted, return `suspended` so the host re-asks once more.
 */
export function matchNetworkGrant(
  db: Database,
  sessionId: string,
  historyGeneration: string,
  originKey: string,
  currentClasses: readonly string[]
): NetworkGrantMatch {
  const grants = readCurrentGrants(db, sessionId, historyGeneration);
  const originGrant = grants.find((g) => g.scope === "origin" && g.origin === originKey);
  const sessionGrant = grants.find((g) => g.scope === "session");

  const check = (grant: StoredGrant | undefined): NetworkGrantMatch => {
    if (!grant) return null;
    const missing = currentClasses.filter((cls) => !grant.grantedClasses.includes(cls));
    if (missing.length === 0) return { kind: "standing", scope: grant.scope, grantId: grant.grantId };
    return { kind: "suspended", scope: grant.scope, grantId: grant.grantId, newClasses: missing };
  };

  const originResult = check(originGrant);
  if (originResult?.kind === "standing") return originResult;
  const sessionResult = check(sessionGrant);
  if (sessionResult?.kind === "standing") return sessionResult;
  return originResult ?? sessionResult ?? null;
}
