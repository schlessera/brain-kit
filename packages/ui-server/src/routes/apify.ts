/**
 * Apify provider state for the Settings UI (#3159). Internal transport: human
 * owners read the truthful state and confirm a changed account; delegated
 * agent principals get neither. No route accepts, stores or returns a token —
 * the host reads `APIFY_TOKEN` from its own environment — and none enables the
 * provider: that stays the governance policy's `apify.enabled`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import { ApifyAuthorityError, type ApifyAuthority } from "@schlessera/brain-common/internal/apify";

export interface ApifyRoutesDeps {
  authority: ApifyAuthority;
  /** The live human-owner check every owner route applies to the resolved principal. */
  authorized(principalId: string): boolean;
}

export function createApifyRoutes(deps: ApifyRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("/apify*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind) || !deps.authorized(principal.id))
      return c.json({ error: "Apify settings require human-owner access." }, 403);
    await next();
  });
  routes.onError((error, c) => error instanceof ApifyAuthorityError
    ? c.json({ error: error.message, code: error.code, reason: error.reason }, 409)
    : c.json({ error: "Apify state is temporarily unavailable." }, 503));

  routes.get("/apify", async c => c.json(await deps.authority.status({ signal: c.req.raw.signal })));
  routes.post("/apify/account", requireJson(), async c => {
    const result = await readJsonBody(c).catch(() => null);
    if (result instanceof Response) return result;
    const body = result as { account_id?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "account_id")
      || typeof body.account_id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(body.account_id))
      return c.json({ error: "Expected { account_id } naming the account to confirm." }, 400);
    return c.json(await deps.authority.confirmAccount(body.account_id, { signal: c.req.raw.signal }));
  });
  return routes;
}
