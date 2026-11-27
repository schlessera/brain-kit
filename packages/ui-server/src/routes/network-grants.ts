/**
 * Session network grant listing and revocation routes (#3595).
 * Authenticated owner reads/revokes active origin and session network grants;
 * a revoke records `network_grant_revoked` off the event loop and affects later
 * connections only.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import type { GovernanceWrites } from "../governance/event-writes.js";
import { listActiveNetworkGrants } from "../governance/network-grants.js";
import { sessionHistoryGeneration, unresolvedTaintClasses } from "../governance/safety-store.js";
import { principalAccount, sameAccount } from "../middleware/account-partition.js";
import { assertLive, ChatRetiredError } from "../ws/chat-lifecycle.js";

export function createNetworkGrantRoutes(deps: {
  db: Database;
  governanceWrites: GovernanceWrites;
  isPrincipalValid: (principal: Principal) => boolean;
  onGrantsChanged?: (sessionId: string) => void;
}): Hono<AppEnv> {
  const { db, governanceWrites, isPrincipalValid, onGrantsChanged } = deps;

  function authorizeSession(sessionId: string, principal: Principal): "ok" | "not_found" | "forbidden" | "retired" {
    try {
      assertLive(db, [["session", sessionId]]);
    } catch (error) {
      if (error instanceof ChatRetiredError) return "retired";
      return "not_found";
    }
    const exists = db.query("SELECT 1 FROM sessions WHERE id=?").get(sessionId);
    if (!exists) return "not_found";
    const safetyOwner = db.query<{ principal_id: string | null; principal_account: string | null }, [string]>(
      "SELECT principal_id, principal_account FROM safety_sessions WHERE session_id=?"
    ).get(sessionId);
    const catalogOwner = db.query<{ principal_id: string }, [string]>(
      "SELECT principal_id FROM chat_session_owners WHERE session_id=?"
    ).get(sessionId);
    const ownerId = safetyOwner?.principal_id ?? catalogOwner?.principal_id ?? null;
    if (ownerId) {
      const bound = safetyOwner?.principal_id
        ? { principalId: safetyOwner.principal_id, account: safetyOwner.principal_account }
        : { principalId: ownerId, account: principalAccount(db, ownerId) };
      if (!sameAccount(db, bound, principal.id)) return "forbidden";
    }
    return "ok";
  }

  return new Hono<AppEnv>()
    .get("/sessions/:id/network-grants", (c) => {
      c.header("Cache-Control", "no-store");
      const principal = c.get("principal");
      if (!principal || !isPrincipalValid(principal)) return c.json({ error: "Authentication required" }, 401);
      const sessionId = c.req.param("id");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return c.json({ error: "Invalid session id" }, 400);
      const auth = authorizeSession(sessionId, principal);
      if (auth === "forbidden") return c.json({ error: "Forbidden" }, 403);
      if (auth === "not_found" || auth === "retired") return c.json({ error: "Session not found" }, 404);
      const generation = sessionHistoryGeneration(db, null, sessionId);
      const classes = unresolvedTaintClasses(db, null, sessionId);
      const grants = listActiveNetworkGrants(db, sessionId, generation, classes);
      return c.json({ sessionId, grants });
    })
    .delete("/sessions/:id/network-grants/:grantId", async (c) => {
      c.header("Cache-Control", "no-store");
      const principal = c.get("principal");
      if (!principal || !isPrincipalValid(principal)) return c.json({ error: "Authentication required" }, 401);
      const sessionId = c.req.param("id");
      const grantId = c.req.param("grantId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) {
        return c.json({ error: "Invalid identifier" }, 400);
      }
      const auth = authorizeSession(sessionId, principal);
      if (auth === "forbidden") return c.json({ error: "Forbidden" }, 403);
      if (auth === "not_found" || auth === "retired") return c.json({ error: "Session not found" }, 404);
      const generation = sessionHistoryGeneration(db, null, sessionId);
      const classes = unresolvedTaintClasses(db, null, sessionId);
      const existing = listActiveNetworkGrants(db, sessionId, generation, classes).find((g) => g.grantId === grantId);
      if (!existing) return c.json({ error: "Grant not found" }, 404);
      if (!isPrincipalValid(principal)) return c.json({ error: "Authentication required" }, 401);
      await governanceWrites.record({
        kind: "network_grant_revoked",
        sessionId,
        turnId: null,
        actor: "user",
        model: null,
        profile: null,
        dedupeKey: `revoke:${grantId}`,
        payload: { grantId, principalId: principal.id },
      });
      onGrantsChanged?.(sessionId);
      return c.json({ revoked: true, grantId });
    });
}
