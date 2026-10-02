import { Hono } from "hono";
import type { BrainClient } from "../brain/client.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";

/** Mount behind the same principal/origin guards as the other Settings writers. */
export function createModuleRoutes(brain: BrainClient): Hono {
  const app = new Hono();
  const valid = (name: string) => /^[a-z][a-z0-9-]{0,30}$/.test(name);
  app.get("/modules", async (c) => {
    if (!brain.modules) return c.json({ error: "Module settings are unavailable with this brain CLI" }, 501);
    try { return c.json(await brain.modules()); }
    catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.get("/modules/:name/settings", async (c) => {
    const name = c.req.param("name");
    if (!valid(name)) return c.json({ error: "Invalid module name" }, 400);
    if (!brain.moduleSettings) return c.json({ error: "Module settings are unavailable" }, 501);
    try {
      const result = await brain.moduleSettings(name, "get") as Record<string, unknown>;
      if (typeof result.status === "number") return c.json(result, result.status as 404 | 409 | 422 | 500);
      c.header("Cache-Control", "no-store");
      if (typeof result.revision === "string") c.header("ETag", result.revision);
      return c.json(result);
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.put("/modules/:name/settings", requireJson(), async (c) => {
    const name = c.req.param("name");
    if (!valid(name)) return c.json({ error: "Invalid module name" }, 400);
    if (!brain.moduleSettings) return c.json({ error: "Module settings are unavailable" }, 501);
    const revision = c.req.header("If-Match");
    if (!revision) return c.json({ error: "Reload settings before saving (If-Match is required)" }, 428);
    let body: unknown;
    try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid request body" }, 400); }
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "values") || Object.keys(body).some((k) => k !== "values")) return c.json({ error: "Expected { values: overrides }" }, 400);
    const values = (body as { values: unknown }).values;
    if (!values || typeof values !== "object" || Array.isArray(values)) return c.json({ error: "Settings values must be an object" }, 400);
    try {
      const result = await brain.moduleSettings(name, "save", { values: values as Record<string, unknown>, revision }) as Record<string, unknown>;
      return c.json(result, typeof result.status === "number" ? result.status as 404 | 409 | 422 | 500 : 200);
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.post("/modules/:name/settings/preview", requireJson(), async (c) => {
    const name = c.req.param("name");
    if (!valid(name)) return c.json({ error: "Invalid module name" }, 400);
    if (!brain.moduleSettings) return c.json({ error: "Module settings are unavailable" }, 501);
    let body: unknown;
    try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid request body" }, 400); }
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "values") || Object.keys(body).some((k) => k !== "values")) return c.json({ error: "Expected { values: overrides }" }, 400);
    const values = (body as { values: unknown }).values;
    if (!values || typeof values !== "object" || Array.isArray(values)) return c.json({ error: "Settings values must be an object" }, 400);
    try {
      const result = await brain.moduleSettings(name, "validate", { values: values as Record<string, unknown> }) as Record<string, unknown>;
      return c.json(result, typeof result.status === "number" ? result.status as 404 | 409 | 422 | 500 : 200);
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.post("/modules/:name/migration/preview", requireJson(), async (c) => {
    const name = c.req.param("name");
    if (!valid(name) || !brain.moduleSettings) return c.json({ error: "Module is unavailable" }, 404);
    try {
      const result = await brain.moduleSettings(name, "preview") as Record<string, unknown>;
      return c.json(result, typeof result.status === "number" ? result.status as 404 | 409 | 422 | 500 : 200);
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.post("/modules/:name/migration", requireJson(), async (c) => {
    const name = c.req.param("name");
    if (!valid(name) || !brain.moduleSettings) return c.json({ error: "Module is unavailable" }, 404);
    const revision = c.req.header("If-Match");
    if (!revision) return c.json({ error: "Preview the migration before applying it" }, 428);
    try {
      const result = await brain.moduleSettings(name, "migrate", { revision }) as Record<string, unknown>;
      return c.json(result, typeof result.status === "number" ? result.status as 404 | 409 | 422 | 500 : 200);
    } catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.post("/modules/:name/state", requireJson(), async (c) => {
    const name = c.req.param("name");
    if (!valid(name) || !brain.moduleSettings) return c.json({ error: "Module is unavailable" }, 404);
    let body: unknown;
    try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid request body" }, 400); }
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("state" in body) || !["active", "dormant"].includes(String(body.state))) return c.json({ error: "Choose active or dormant" }, 400);
    try { return c.json(await brain.moduleSettings(name, body.state === "active" ? "enable" : "disable")); }
    catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  app.post("/modules/:name/actions/:id", requireJson(), async (c) => {
    const name = c.req.param("name");
    if (!valid(name) || !brain.moduleSettings) return c.json({ error: "Module is unavailable" }, 404);
    try { return c.json(await brain.moduleSettings(name, "action", { action: c.req.param("id") })); }
    catch (error) { return c.json({ error: (error as Error).message }, 500); }
  });
  return app;
}
