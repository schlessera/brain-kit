import { Hono } from "hono";
import { safetyReviewBodySchema } from "@schlessera/brain-ui-sdk/schemas";
import type { AppEnv } from "../app-env.js";
import { OwnerSafetyReviews, OwnerSafetyUnavailable } from "../governance/owner-safety-reviews.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import { requireOwner } from "../middleware/require-owner.js";

/** These browser mutations require a present exact Origin, even for clients
 * claiming same-origin fetch metadata. Unrelated routes keep their policy. */
export function createOwnerSafetyReviewRoutes(reviews: OwnerSafetyReviews, trustProxy: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const prefix = "/sessions/:id/safety/reviews";
  app.use(`${prefix}/*`, async (c,next)=>{
    c.header("Cache-Control","no-store");
    const principal = c.get("principal");
    if (!principal || !reviews.authorized(principal)) return c.json({code:"unauthorized",reason:"owner_required",retryable:false},403);
    const origin = c.req.header("origin");
    try {
      const expected = new URL(c.req.url);
      const proto = trustProxy ? c.req.header("x-forwarded-proto")?.split(",",1)[0]?.trim() : undefined;
      if (proto) expected.protocol = `${proto}:`;
      if (!origin || !["http:","https:"].includes(expected.protocol) || origin !== expected.origin)
        return c.json({code:"unauthorized",reason:"cross_origin_rejected",retryable:false},403);
    } catch { return c.json({code:"unauthorized",reason:"cross_origin_rejected",retryable:false},403); }
    return next();
  }, requireOwner(), requireJson());
  for (const action of ["prepare","commit"] as const) {
    app.post(action === "prepare" ? `${prefix}/prepare` : `${prefix}/:requestId/commit`, async c=>{
      try {
        const value = await readJsonBody(c,16384);
        if (value instanceof Response) return c.json({code:"capacity",reason:"request_too_large",retryable:false},413);
        const parsed = safetyReviewBodySchema.safeParse(value), requestId = action === "prepare" ? null : c.req.param("requestId");
        if (!parsed.success || parsed.data.session.sessionId !== c.req.param("id") || requestId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(requestId ?? "")
          || c.req.url.length > 8192 || new URL(c.req.url).search)
          return c.json({code:"unavailable",reason:"invalid_request",retryable:false},400);
        const principal = c.get("principal")!;
        const response = await reviews.review(principal,parsed.data,requestId!);
        // No await separates this live identity/aggregate read from delivery.
        response.currentProjection = reviews.delivery(principal,parsed.data);
        if (Buffer.byteLength(JSON.stringify(response)) > 262144) throw new OwnerSafetyUnavailable("capacity");
        const reason = response.receipt.reason;
        if (!reason) return c.json(response);
        const refusals = {
          unauthorized:["unauthorized",403], unavailable:["unavailable",404], retired:["unavailable",404],
          capacity:["capacity",503], recording_failed:["recording_failed",503], recording_pending:["resync_required",409],
          stale_revision:["stale_revision",409], not_finalized:["not_finalized",409], request_conflict:["request_conflict",409], request_expired:["request_expired",409],
        } as const;
        const [code,status] = refusals[reason as keyof typeof refusals] ?? ["unavailable",409];
        return c.json({...response,code,reason,retryable:false},status);
      } catch (error) {
        if (error instanceof SyntaxError) return c.json({code:"unavailable",reason:"invalid_request",retryable:false},400);
        const code = error instanceof OwnerSafetyUnavailable ? error.code : "unavailable";
        return c.json({code,reason:code,retryable:false},code === "unauthorized" ? 403 : code === "capacity" ? 503 : 404);
      }
    });
  }
  return app;
}
