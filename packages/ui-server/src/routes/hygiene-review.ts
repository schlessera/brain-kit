import { Hono } from "hono";
import { hygienePreviewRequestSchema, hygieneReviewCommandSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { AppEnv } from "../app-env.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import { HygieneAuthorityError, type HygieneReview } from "../inbox/hygiene-review.js";

export function createHygieneReviewRoutes(review: HygieneReview) {
  const app = new Hono<AppEnv>();
  app.get("/hygiene/review", c => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Unauthorized" }, 401);
    return c.json(review.readFor(principal.id));
  });
  // The owner's private read of the pending card's recorded facts (#2734): never cached or replicated.
  app.get("/hygiene/review/details/:itemId", async c => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Unauthorized" }, 401);
    c.header("Cache-Control", "no-store");
    try { return c.json(await review.details(principal.id, c.req.param("itemId"))); }
    catch (e) { return c.json({ error: e instanceof HygieneAuthorityError ? "Unauthorized" : "details_failed" }, e instanceof HygieneAuthorityError ? 403 : 500); }
  });
  app.post("/hygiene/review", requireJson(), async c => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Unauthorized" }, 401);
    let body: unknown;
    try { body = await readJsonBody(c); } catch { return c.json({ error: "invalid_request" }, 400); }
    if (body instanceof Response) return body;
    const parsed = hygieneReviewCommandSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try { return c.json(review.readFor(principal.id, await review.command(principal.id, parsed.data.operation))); }
    catch (e) { return c.json({ error: e instanceof HygieneAuthorityError ? "Unauthorized" : "review_failed" }, e instanceof HygieneAuthorityError ? 403 : 500); }
  });
  app.post("/hygiene/review/preview", requireJson(), async c => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Unauthorized" }, 401);
    let body: unknown;
    try { body = await readJsonBody(c); } catch { return c.json({ error: "invalid_request" }, 400); }
    if (body instanceof Response) return body;
    const parsed = hygienePreviewRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try { return c.json(await review.preview(principal.id, parsed.data)); }
    catch (e) { return c.json({ error: e instanceof HygieneAuthorityError ? "Unauthorized" : "preview_refused" }, e instanceof HygieneAuthorityError ? 403 : 409); }
  });
  return app;
}
