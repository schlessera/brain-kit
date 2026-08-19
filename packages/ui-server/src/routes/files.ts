import { Hono } from "hono";
import {
  listDirectory,
  readFileContent,
  resolveAncestors,
  resolveForRaw,
  buildWikilinkMap,
  NotFoundError,
  PathEscapeError,
  TooLargeError,
} from "../files/walker.js";

const WIKILINK_TTL_MS = 30_000;

function errorResponse(err: unknown): { body: { error: string; size?: number }; status: 400 | 404 | 413 | 500 } {
  if (err instanceof PathEscapeError) {
    return { body: { error: "invalid_path" }, status: 400 };
  }
  if (err instanceof NotFoundError) {
    return { body: { error: "not_found" }, status: 404 };
  }
  if (err instanceof TooLargeError) {
    return { body: { error: "file_too_large", size: err.size }, status: 413 };
  }
  console.error("[files]", err);
  return { body: { error: err instanceof Error ? err.message : "internal_error" }, status: 500 };
}

export function createFilesRoutes(deps: { brainRoot: string }): Hono {
  const { brainRoot } = deps;
  let wikilinkCache: { generatedAt: number; map: Record<string, string> } | null = null;
  return new Hono()
  .get("/files/tree", async (c) => {
    const path = c.req.query("path") ?? "";
    try {
      const entries = await listDirectory(path, brainRoot);
      return c.json({ path, entries });
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  })

  .get("/files/content", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "missing_path" }, 400);
    const raw = c.req.query("raw") === "1";
    try {
      if (raw) {
        const { abs, mime, size } = await resolveForRaw(path, brainRoot);
        const file = Bun.file(abs);
        return new Response(file, {
          status: 200,
          headers: {
            "Content-Type": mime,
            "Content-Length": String(size),
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
            "Cache-Control": "private, max-age=0, must-revalidate",
          },
        });
      }
      const result = await readFileContent(path, brainRoot);
      return c.json({ path, ...result });
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  })

  .get("/files/resolve", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "missing_path" }, 400);
    try {
      const result = await resolveAncestors(path, brainRoot);
      return c.json({ path, ...result });
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  })

  .get("/files/wikilinks", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    const now = Date.now();
    try {
      if (refresh || !wikilinkCache || now - wikilinkCache.generatedAt > WIKILINK_TTL_MS) {
        const map = await buildWikilinkMap(brainRoot);
        wikilinkCache = { generatedAt: now, map };
      }
      return c.json({
        generatedAt: wikilinkCache.generatedAt,
        count: Object.keys(wikilinkCache.map).length,
        slugs: wikilinkCache.map,
      });
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });
}
