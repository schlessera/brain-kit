import type { MiddlewareHandler } from "hono";
import { IndexFlushError, type IndexBatch } from "../brain/index-batch.js";

/** The host's HTTP routes that read the index (#2835). */
export const INDEX_READ_ROUTES = ["/api/brain/search", "/api/brain/list", "/api/brain/stats", "/api/brain/stats/history", "/api/brain/briefing", "/api/graph/*"] as const;

/**
 * Host readers of the index wait for application updates queued before them,
 * as turn readers do. A failed update answers 503 with `index_stale`, never a
 * stale result; the next request retries it.
 */
export function indexReadBarrier(batch: IndexBatch): MiddlewareHandler {
  return async (c, next) => {
    try { await batch.barrier(c.req.raw.signal); }
    catch (error) {
      if (error instanceof IndexFlushError) return c.json({ error: error.message, code: "index_stale" }, 503);
      throw error;
    }
    return next();
  };
}
