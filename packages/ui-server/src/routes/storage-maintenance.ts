import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { requireJson } from "../middleware/origin.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { StorageUnavailable } from "../storage/coordinator.js";
import type { StorageMaintenance } from "../storage/maintenance.js";
const request = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{16,96}$/), operation: z.enum(["pack-git", "prune-scratch", "cleanup-staging"]) }).strict();
export function createStorageMaintenanceRoutes(maintenance: StorageMaintenance): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.onError((error, c) => c.json({ error: error instanceof StorageUnavailable ? error.message : "Maintenance unavailable; read the original receipt before considering another operation." }, error instanceof StorageUnavailable ? error.status : 503));
  routes.use("/storage/maintenance*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind)) return c.json({ error: "Maintenance requires human-owner access." }, 403);
    await next();
  });
  routes.get("/storage/maintenance", c => c.json(maintenance.list(c.get("principal")!.id)));
  routes.get("/storage/maintenance/:id", c => c.json(maintenance.receipt(c.get("principal")!.id, c.req.param("id"))));
  routes.post("/storage/maintenance", requireJson(), async c => {
    let body: unknown;
    try { body = await readJsonBody(c, 4096); } catch { return c.json({ error: "Invalid maintenance JSON." }, 400); }
    if (body instanceof Response) return body;
    const parsed = request.safeParse(body);
    if (!parsed.success) return c.json({ error: "Choose one approved operation and a new request identity; roots and commands are host-owned." }, 400);
    return c.json(maintenance.start(c.get("principal")!.id, parsed.data), 202);
  });
  routes.delete("/storage/maintenance/:id", c => c.json(maintenance.cancel(c.get("principal")!.id, c.req.param("id")), 202));
  return routes;
}
