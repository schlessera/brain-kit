/** Internal owner-only management; no HTTP route grants Google authority. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { GoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import type { createGoogleAllowances } from "../google/allowances.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";

interface Deps {
  brainId: string; hostEpoch: string;
  ledger(): GoogleLedger;
  allowances: ReturnType<typeof createGoogleAllowances>;
  authorized(principalId: string): boolean;
  owns(principalId: string, sessionId: string): boolean;
  tainted(sessionId: string): boolean;
  policyHash(): string;
}
const revoke = z.strictObject({ id: z.string().min(1).max(200) });
export function createGoogleApprovalRoutes(deps: Deps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  for (const path of ["/google/approvals*", "/sessions/:id/google/allowances*"]) routes.use(path, async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind) || !deps.authorized(principal.id)) return c.json({ error: "Google approvals require owner access." }, 403);
    await next();
  });
  routes.onError((_error, c) => c.json({ error: "Google approval storage is temporarily unavailable." }, 503));
  routes.get("/google/approvals", c => c.json({ approvals: deps.ledger().list(deps.brainId, c.get("principal")!.id) }));
  routes.post("/google/approvals/revoke", requireJson(), async c => {
    const raw = await readJsonBody(c).catch(() => null); if (raw instanceof Response) return raw;
    const body = revoke.safeParse(raw); if (!body.success) return c.json({ error: "Expected { id }." }, 400);
    const principal = c.get("principal")!;
    if (!deps.authorized(principal.id)) return c.json({ error: "Google approvals require owner access." }, 403);
    return c.json({ revoked: deps.ledger().revoke(deps.brainId, body.data.id, principal.id) });
  });
  routes.use("/sessions/:id/google/allowances*", async (c, next) => {
    if (!deps.owns(c.get("principal")!.id, c.req.param("id")!)) return c.json({ error: "Session unavailable." }, 404);
    await next();
  });
  routes.get("/sessions/:id/google/allowances", async c => {
    const principalId = c.get("principal")!.id, sessionId = c.req.param("id");
    const context = { sessionId, principalId, brainId: deps.brainId, accountIdentity: "unresolved", hostEpoch: deps.hostEpoch,
      policyHash: deps.policyHash(), now: Date.now(), authorized: deps.authorized(principalId), tainted: deps.tainted(sessionId) };
    await deps.allowances.reconcile(context);
    if (!deps.authorized(principalId) || !deps.owns(principalId, sessionId)) return c.json({ error: "Session unavailable." }, 404);
    return c.json({ allowances: deps.tainted(sessionId) ? deps.allowances.list(sessionId, principalId, deps.brainId, deps.hostEpoch, deps.policyHash(), Date.now()) : [] });
  });
  routes.post("/sessions/:id/google/allowances/revoke", requireJson(), async c => {
    const raw = await readJsonBody(c).catch(() => null); if (raw instanceof Response) return raw;
    const body = revoke.safeParse(raw); if (!body.success) return c.json({ error: "Expected { id }." }, 400);
    const principalId = c.get("principal")!.id, sessionId = c.req.param("id");
    if (!deps.authorized(principalId) || !deps.owns(principalId, sessionId)) return c.json({ error: "Session unavailable." }, 404);
    return c.json({ revoked: await deps.allowances.revoke(sessionId, principalId, deps.brainId, body.data.id) });
  });
  return routes;
}
