import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../app-env.js";
import { isHumanOwner } from "../db/principals.js";

/** Require the authenticated request principal to be the owner. */
export function requireOwner(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("principal")?.kind !== "owner") {
      return c.json({ error: "Owner access required" }, 403);
    }
    await next();
  };
}

/**
 * Require the request principal to be the human owner (`isHumanOwner`):
 * every response is `private, no-store`, no principal is a 401 and any other
 * principal a 403 carrying the router's own message.
 */
export function requireHumanOwner(forbidden: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!isHumanOwner(principal)) return c.json({ error: forbidden }, 403);
    await next();
  };
}
