import { Hono } from "hono";
import { queueAddRequestSchema, queueAddResultSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { AppEnv } from "../app-env.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import { EmptyShareError, ShareTooLargeError } from "../share/staging.js";
import { IntakeAuthorizationError, IntakeKeyConflictError, type InboxIntake } from "../inbox/intake.js";

export function createQueueRoutes(intake: InboxIntake) {
  return new Hono<AppEnv>().post("/queue", requireJson(), async c => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Unauthorized" }, 401);
    let body: unknown;
    try { body = await readJsonBody(c); }
    catch { return c.json({ error: "invalid_request" }, 400); }
    if (body instanceof Response) return body;
    const parsed = queueAddRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      const { key, ...content } = parsed.data;
      const outcome = await intake.cli({ ...content, files: [] }, key, principal);
      return c.json(queueAddResultSchema.parse({ queued: true, created: outcome.created,
        threadId: outcome.threadId, itemId: outcome.itemId, stagingId: outcome.result.id }), 201);
    } catch (error) {
      if (error instanceof IntakeAuthorizationError) return c.json({ error: "Unauthorized" }, 401);
      if (error instanceof IntakeKeyConflictError) return c.json({ error: "key_conflict" }, 409);
      if (error instanceof EmptyShareError) return c.json({ error: "empty_share" }, 400);
      if (error instanceof ShareTooLargeError) return c.json({ error: error.reason, limit: error.limit }, 413);
      return c.json({ error: "queue_failed" }, 500);
    }
  });
}
