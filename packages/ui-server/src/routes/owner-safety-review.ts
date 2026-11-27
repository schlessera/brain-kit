import { CombinedSafetyReviews, combinedPrepareSchema, combinedCommitSchema } from "../governance/combined-safety-reviews.js";
import { TrustSettingsError } from "../brain/trust-settings.js";
import { Hono } from "hono";
import { safetyReviewBodySchema, safetyFutureStatusSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { AppEnv } from "../app-env.js";
import { OwnerSafetyReviews, OwnerSafetyUnavailable } from "../governance/owner-safety-reviews.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireExactOrigin, requireJson } from "../middleware/origin.js";
import { requireOwner } from "../middleware/require-owner.js";

/** These browser mutations require a present exact Origin, even for clients
 * claiming same-origin fetch metadata. Unrelated routes keep their policy. */
export function createOwnerSafetyReviewRoutes(reviews: OwnerSafetyReviews, trustProxy: boolean, combined?: CombinedSafetyReviews): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const prefix = "/sessions/:id/safety/reviews";
  const exactOrigin = requireExactOrigin(trustProxy);
  app.use(`${prefix}/*`, async (c,next)=>{
    c.header("Cache-Control","no-store");
    const principal = c.get("principal");
    if (!principal || !reviews.authorized(principal)) return c.json({code:"unauthorized",reason:"owner_required",retryable:false},403);
    if (!exactOrigin(c)) return c.json({code:"unauthorized",reason:"cross_origin_rejected",retryable:false},403);
    return next();
  }, requireOwner(), requireJson());
  if (combined) app.post(`${prefix}/future/status`, async c => {
    try {
      const raw=await readJsonBody(c,16384);
      if(raw instanceof Response)return raw;
      const input=safetyFutureStatusSchema.parse(raw);
      if(input.session.sessionId!==c.req.param("id")||new URL(c.req.url).search)return c.json({code:"unavailable"},400);
      return c.json(await combined.status(c.get("principal")!,input));
    }catch{return c.json({code:"unavailable",retryable:false},404);}
  });
  if (combined) for (const action of ["prepare", "commit"] as const) app.post(`${prefix}/future/${action}`, async c => {
    try {
      const raw = await readJsonBody(c, 16384);
      if (raw instanceof Response) return c.json({code:"capacity",reason:"request_too_large",retryable:false},413);
      const input = (action === "prepare" ? combinedPrepareSchema : combinedCommitSchema).parse(raw);
      if (new URL(c.req.url).search || action === "prepare" && (input as import("@schlessera/brain-ui-sdk/protocol").SafetyReviewBody).session.sessionId !== c.req.param("id"))
        return c.json({code:"unavailable",reason:"invalid_request",retryable:false},400);
      const value = action === "prepare" ? await combined.prepare(c.get("principal")!,input,c.req.raw.signal) : await combined.commit(c.get("principal")!,input,c.req.raw.signal,c.req.param("id"));
      if (value.session.sessionId !== c.req.param("id")) return c.json({code:"unavailable",reason:"invalid_request",retryable:false},400);
      return c.json(value);
    } catch (error) {
      const status = error instanceof TrustSettingsError ? error.status : error instanceof OwnerSafetyUnavailable ? 403 : 400;
      return c.json({code:"unavailable",reason:error instanceof TrustSettingsError ? error.code : "invalid_request",retryable:false},status);
    }
  });
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
