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
  const rows = db.query<{ kind: string; at: number; payload: string }, [string]>(
    `SELECT kind, at, payload FROM governance_events
      WHERE session_id = ? AND kind IN ('network_grant', 'network_grant_revoked')
      ORDER BY id ASC`
  ).all(sessionId);

  const revoked = new Set<string>();
  const latestByTarget = new Map<string, StoredGrant>();

  for (const row of rows) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
    if (row.kind === "network_grant_revoked") {
      if (typeof payload.grantId === "string") revoked.add(payload.grantId);
      continue;
    }
    if (payload.historyGeneration !== historyGeneration) continue;
    const scope = payload.scope === "origin" || payload.scope === "session" ? payload.scope : null;
    if (!scope || typeof payload.grantId !== "string") continue;
    if (scope === "origin" && typeof payload.origin !== "string") continue;
    const targetKey = scope === "session" ? "session" : `origin:${payload.origin}`;
    latestByTarget.set(targetKey, {
      grantId: payload.grantId,
      scope,
      ...(typeof payload.origin === "string" ? { origin: payload.origin } : {}),
      ...(payload.transport === "http" || payload.transport === "connect" ? { transport: payload.transport } : {}),
      ...(payload.scheme === "http" || payload.scheme === "https" || payload.scheme === "connect" ? { scheme: payload.scheme } : {}),
      ...(typeof payload.host === "string" ? { host: payload.host } : {}),
      ...(typeof payload.port === "number" ? { port: payload.port } : {}),
      grantedClasses: Array.isArray(payload.grantedClasses)
        ? payload.grantedClasses.filter((c): c is string => typeof c === "string")
        : [],
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
