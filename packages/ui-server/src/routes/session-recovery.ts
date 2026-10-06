import { Hono } from "hono";
import { SESSION_NOT_FOUND, SESSION_RECOVERY_FAILED } from "@schlessera/brain-ui-sdk/protocol";

import type { AppEnv } from "../app-env.js";
import type { WsHost } from "../ws/host.js";
import { readSessionRecovery } from "../ws/recovery.js";

/**
 * `GET /api/sessions/:id/recovery` (#964, D52 §6). Mounted behind the auth
 * guard, and only on a host that advertises `sessionRecovery`. Read-only:
 * it never selects a session, starts work, replies or grants. Responses are
 * not cached; they describe live work.
 */
export function createSessionRecoveryRoutes(host: WsHost): Hono<AppEnv> {
  return new Hono<AppEnv>().get("/sessions/:id/recovery", async (c) => {
    c.header("Cache-Control", "no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required", authRequired: true }, 401);
    const sessionId = c.req.param("id");
    try {
      const read = await readSessionRecovery(host, sessionId, principal);
      switch (read.kind) {
        case "ok":
          return c.json(read.recovery);
        case "unauthorized":
          // The established auth envelope, and nothing about the session.
          return c.json({ error: "Authentication required", authRequired: true }, 401);
        case "not_found":
          return c.json({ error: SESSION_NOT_FOUND, message: "This host has no such session." }, 404);
      }
    } catch (err) {
      host.log.emit({
        severityText: "ERROR",
        body: "session recovery read failed",
        attributes: { "session.id": sessionId, error: err instanceof Error ? err.message : String(err) },
      });
      // Never a successful `unknown`: unknown means the read worked.
      return c.json({ error: SESSION_RECOVERY_FAILED, message: "The host could not read this session's recovery state." }, 500);
    }
  });
}
