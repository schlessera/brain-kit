import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { TurnRevertRequest, JournalObservationReference } from "@schlessera/brain-ui-sdk/protocol";
import { RevertUnavailable, type TurnReverts } from "../brain/turn-revert.js";
/** Only a current authenticated human principal can start or reconcile a history effect. */
export function createTurnRevertRoutes(reverts: TurnReverts): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("/sessions/:sessionId/turns/:turnId/revert*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind)) return c.json({ error: "User history action unavailable." }, 403);
    await next();
  });
  routes.get("/sessions/:sessionId/turns/:turnId/revert/plan", c => {
    const action = c.req.query("action") ?? "revert";
    if (!["revert", "restore"].includes(action)) return c.json({error:"Invalid history action."},400);
    try { return c.json(reverts.plan(c.req.param("sessionId"),c.req.param("turnId"),action as "revert" | "restore")); }
    catch { return c.json({error:"No retained eligible history is available."},409); }
  });
  routes.get("/sessions/:sessionId/turns/:turnId/revert", c => c.json({ receipt: reverts.latest(c.get("principal")!.id,c.req.param("sessionId"),c.req.param("turnId")) }));
  routes.get("/sessions/:sessionId/turns/:turnId/revert/:operationId", c => {
    const receipt = reverts.receipt(c.req.param("operationId"),c.get("principal")!.id,c.req.param("sessionId"),c.req.param("turnId"));
    return receipt ? c.json(receipt) : c.json({error:"Original operation receipt unavailable; no effect was retried."},404);
  });
  routes.post("/sessions/:sessionId/turns/:turnId/revert", async c => {
    let input: unknown; try { input = await c.req.json(); } catch { return c.json({error:"Invalid history action."},400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({error:"Invalid history action."},400);
    const request = input as TurnRevertRequest;
    const reference=(value:unknown):value is JournalObservationReference => {
      if(!value||typeof value!=="object"||Array.isArray(value))return false;
      const ref=value as JournalObservationReference;
      return Object.keys(ref).every(key=>["turnId","sequence","side"].includes(key))&&typeof ref.turnId==="string"&&ref.turnId.length>0&&ref.turnId.length<=200&&Number.isSafeInteger(ref.sequence)&&ref.sequence>0&&ref.side==="after";
    };
    const resolving=request.action==="keep_version"||request.action==="keep_both";
    if(Object.keys(request).some(key=>!["id","path","action","version","otherVersion","expected"].includes(key))||typeof request.id!=="string"||request.path!==undefined&&typeof request.path!=="string"||request.action!==undefined&&!["revert","restore","keep_version","keep_both"].includes(request.action)
      ||resolving&&(!request.path||!reference(request.version)||!reference(request.expected)||request.action==="keep_both"&&!reference(request.otherVersion))
      ||request.otherVersion!==undefined&&!reference(request.otherVersion))return c.json({error:"Invalid history action."},400);
    try { return c.json(reverts.start(c.get("principal")!.id,c.req.param("sessionId"),c.req.param("turnId"),request),202); }
    catch (error) { return c.json({error:error instanceof RevertUnavailable ? error.message : "History storage is temporarily unavailable; reconcile the original operation identity before considering another effect."},error instanceof RevertUnavailable ? 409 : 503); }
  });
  return routes;
}
