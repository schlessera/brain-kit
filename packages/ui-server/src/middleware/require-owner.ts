import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../app-env.js";

/** Require the authenticated request principal to be the owner. */
export function requireOwner(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("principal")?.kind !== "owner") {
      return c.json({ error: "Owner access required" }, 403);
    }
    await next();
  };
}
