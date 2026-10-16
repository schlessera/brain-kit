import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { requireJson } from "../middleware/origin.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { StorageUnavailable } from "../storage/coordinator.js";
import type { StorageRemoval } from "../storage/removal.js";
const id = z.string().regex(/^[a-zA-Z0-9_-]{16,96}$/), paths = z.array(z.string().min(1).max(4096)).min(1).max(32);
const review = z.object({ id, paths }).strict(), undo = z.object({ id, sourceId: id, paths }).strict(), start = z.object({ id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function createStorageRemovalRoutes(removal: StorageRemoval): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.onError((error, c) => c.json({ error: error instanceof StorageUnavailable ? error.message : "Attachment operation unavailable; read its original receipt before starting another operation." }, error instanceof StorageUnavailable ? error.status : 503));
  routes.use("/storage/removals*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind)) return c.json({ error: "Attachment removal requires human-owner access." }, 403);
    await next();
  });
  routes.get("/storage/removals", c => c.json(removal.capability(c.get("principal")!.id)));
  routes.get("/storage/removals/:id", c => c.json(removal.receipt(c.get("principal")!.id, c.req.param("id"))));
  routes.post("/storage/removals/reviews", requireJson(), async c => {
    let body: unknown; try { body = await readJsonBody(c, 140_000); } catch { return c.json({ error: "Invalid attachment JSON." }, 400); }
    if (body instanceof Response) return body; const parsed = review.safeParse(body);
    if (!parsed.success) return c.json({ error: "Select bounded attachment paths and a new review identity." }, 400);
    return c.json(await removal.review(c.get("principal")!.id, parsed.data.id, parsed.data.paths));
  });
  routes.post("/storage/removals/undo-reviews", requireJson(), async c => {
    let body: unknown; try { body = await readJsonBody(c, 140_000); } catch { return c.json({ error: "Invalid attachment JSON." }, 400); }
    if (body instanceof Response) return body; const parsed = undo.safeParse(body);
    if (!parsed.success) return c.json({ error: "Select retained originals from one removal and a new Undo identity." }, 400);
    return c.json(await removal.review(c.get("principal")!.id, parsed.data.id, parsed.data.paths, parsed.data.sourceId));
  });
  routes.post("/storage/removals", requireJson(), async c => {
    let body: unknown; try { body = await readJsonBody(c, 4096); } catch { return c.json({ error: "Invalid attachment JSON." }, 400); }
    if (body instanceof Response) return body; const parsed = start.safeParse(body);
    if (!parsed.success) return c.json({ error: "Confirm the exact current review identity." }, 400);
    return c.json(removal.start(c.get("principal")!.id, parsed.data.id, parsed.data.fingerprint), 202);
  });
  routes.delete("/storage/removals/:id", c => c.json(removal.cancel(c.get("principal")!.id, c.req.param("id")), 202));
  return routes;
}
