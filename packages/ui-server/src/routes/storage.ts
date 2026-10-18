import type { StorageGuidance } from "../storage/guidance.js";
import { Hono } from "hono";
import { requireJson } from "../middleware/origin.js";
import type { AppEnv } from "../app-env.js";
import type { StorageFilter, StorageTreeFilter } from "@schlessera/brain-ui-sdk/protocol";
import { StorageUnavailable, type StorageCoordinator } from "../storage/coordinator.js";
/** Ordinary content authorization does not grant access to deployment inventory. */
export function createStorageRoutes(storage: StorageCoordinator, guidance?: StorageGuidance): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.onError((error, c) => c.json({ error: error instanceof StorageUnavailable ? error.message : "Storage temporarily unavailable." }, error instanceof StorageUnavailable ? error.status : 503));
  routes.use("/storage*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind)) return c.json({ error: "Storage requires human-owner access." }, 403);
    try { storage.status(principal.id); await next(); }
    catch (error) { return c.json({ error: error instanceof StorageUnavailable ? error.message : "Storage temporarily unavailable." }, error instanceof StorageUnavailable ? error.status : 503); }
  });
  if (guidance) {
    routes.get("/storage/history", c => c.json(guidance.history(c.get("principal")!.id)));
    routes.get("/storage/guidance", c => c.json(guidance.guidance(c.get("principal")!.id)));
  }
  routes.get("/storage", c => c.json(storage.status(c.get("principal")!.id)));
  routes.post("/storage/scans", requireJson(), async c => {
    let body: unknown; try { body = await c.req.json(); } catch { return c.json({ error: "Expected an empty JSON object." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return c.json({ error: "Storage roots and options are host configured." }, 400);
    return c.json(storage.start(c.get("principal")!.id), 202);
  });
  routes.delete("/storage/scans/:id", c => c.json(storage.cancel(c.get("principal")!.id, c.req.param("id")), 202));
  routes.get("/storage/scans/:id/entries", c => {
    const raw = c.req.query(), keys = ["rootId", "parentId", "owner", "type", "largerThan", "cursor", "search", "sort", "metric", "direction"];
    if (Object.keys(raw).some(key => !keys.includes(key)) || !validPresentation(raw) || raw.owner !== undefined && !["all", "brain", "app", "operator"].includes(raw.owner)
      || raw.type !== undefined && raw.type !== "pdf" || [raw.rootId, raw.parentId].some(id => id !== undefined && id !== "" && !/^[a-f0-9]{32}$/.test(id))
      || raw.largerThan !== undefined && (!/^\d+$/.test(raw.largerThan) || !Number.isSafeInteger(Number(raw.largerThan)))) return c.json({ error: "Invalid Storage filters." }, 400);
    const filter: StorageFilter = { ...(raw.rootId !== undefined ? { rootId: raw.rootId } : {}), ...(raw.parentId !== undefined ? { parentId: raw.parentId } : {}),
      ...(raw.owner ? { owner: raw.owner as StorageFilter["owner"] } : {}), ...(raw.type ? { type: "pdf" } : {}), ...(raw.largerThan !== undefined ? { largerThan: Number(raw.largerThan) } : {}), ...(raw.cursor ? { cursor: raw.cursor } : {}), ...presentation(raw) };
    return c.json(storage.page(c.get("principal")!.id, c.req.param("id"), filter));
  });
  routes.get("/storage/scans/:id/tree", c => {
    const raw = c.req.query(), keys = ["parentId", "owner", "search", "sort", "metric", "direction", "cursor"];
    if (Object.keys(raw).some(key => !keys.includes(key)) || !validPresentation(raw) || raw.owner !== undefined && !["all", "brain", "app", "operator"].includes(raw.owner)
      || raw.parentId !== undefined && raw.parentId !== "" && !/^[a-f0-9]{32}$/.test(raw.parentId)) return c.json({ error: "Invalid Storage filters." }, 400);
    const filter: StorageTreeFilter = { ...(raw.parentId ? { parentId: raw.parentId } : {}), ...(raw.owner ? { owner: raw.owner as StorageTreeFilter["owner"] } : {}), ...(raw.cursor ? { cursor: raw.cursor } : {}), ...presentation(raw) };
    return c.json(storage.tree(c.get("principal")!.id, c.req.param("id"), filter));
  });
  routes.get("/storage/scans/:id/entries/:entryId/references", async c => c.json(await storage.references(c.get("principal")!.id, c.req.param("id"), c.req.param("entryId"))));
  return routes;
}

function validPresentation(raw: Record<string,string>) {
  return (raw.search === undefined || Buffer.byteLength(raw.search) <= 128 && !/[\u0000-\u001f\u007f]/u.test(raw.search))
    && (raw.sort === undefined || ["name", "size"].includes(raw.sort))
    && (raw.metric === undefined || ["logical", "allocated"].includes(raw.metric))
    && (raw.direction === undefined || ["asc", "desc"].includes(raw.direction));
}
function presentation(raw: Record<string,string>): Pick<StorageFilter,"search"|"sort"|"metric"|"direction"> {
  return { ...(raw.search !== undefined ? {search:raw.search} : {}), ...(raw.sort ? {sort:raw.sort as "name"|"size"} : {}), ...(raw.metric ? {metric:raw.metric as "logical"|"allocated"} : {}), ...(raw.direction ? {direction:raw.direction as "asc"|"desc"} : {}) };
}
