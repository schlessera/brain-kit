import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { WsHost } from "../ws/host.js";
/** Read-only same-request reconciliation. Approval is exclusively the existing WS authority route. */
export function createPolicyProposalRoutes(host: WsHost): Hono<AppEnv> {
  return new Hono<AppEnv>().get("/policy-proposals/:turnId/:requestId", c => {
    c.header("Cache-Control", "no-store");
    const principal = c.get("principal");
    if (!principal || !host.isPrincipalAuthorized(principal.id)) return c.json({ error: "Authentication required", authRequired: true }, 401);
    const { turnId, requestId } = c.req.param();
    if (turnId.length > 200 || requestId.length > 200) return c.json({ error: "Invalid request identity" }, 400);
    const review = host.policyProposals?.read(principal.id, turnId, requestId, c.req.query("session"));
    if (!review) return c.json({ error: "No policy proposal receipt is available for this request." }, 404);
    return c.json(review);
  });
}
