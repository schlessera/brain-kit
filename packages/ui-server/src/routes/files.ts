import type { Logger } from "@opentelemetry/api-logs";
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

function errorResponse(err: unknown, log?: Logger): { body: { error: string; size?: number }; status: 400 | 404 | 413 | 500 } {
  if (err instanceof PathEscapeError) {
    return { body: { error: "invalid_path" }, status: 400 };
  }
  if (err instanceof NotFoundError) {
    return { body: { error: "not_found" }, status: 404 };
  }
  if (err instanceof TooLargeError) {
    return { body: { error: "file_too_large", size: err.size }, status: 413 };
  }
  log?.emit({ severityText: "ERROR", body: "file request failed", attributes: { error: err instanceof Error ? err.message : String(err) } });
  return { body: { error: "internal_error" }, status: 500 };
}

/**
 * The single byte range a `Range` header asks for, "unsatisfiable" when it
 * starts past the end, or null to serve the whole file. The whole file is
 * served when the header is missing, malformed, or asks for several ranges,
 * which RFC 9110 §14.2 lets a server ignore. Media elements rely on this:
 * iOS Safari opens a video or audio file with `bytes=0-1` and will not play
 * it unless the reply is a 206.
 */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // A suffix range: the last N bytes. Of an empty file that is all of it.
    const length = Number(match[2]);
    if (length === 0) return "unsatisfiable";
    if (size === 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return end < start ? null : { start, end };
}

export function createFilesRoutes(deps: { brainRoot: string; log?: Logger }): Hono {
  const { brainRoot, log } = deps;
  let wikilinkBuild: Promise<void> | null = null;
  let wikilinkCache: { generatedAt: number; map: Record<string, string> } | null = null;
  return new Hono()
  .get("/files/tree", async (c) => {
    const path = c.req.query("path") ?? "";
    try {
      const entries = await listDirectory(path, brainRoot);
      return c.json({ path, entries });
    } catch (err) {
      const { body, status } = errorResponse(err, log);
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
        const headers = {
          "Content-Type": mime,
          "Content-Disposition": "inline",
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
          "Cache-Control": "private, max-age=0, must-revalidate",
        };
        // Range applies to GET alone (RFC 9110 §14.2). An If-Range can never
        // match here, because this route sends no validator, and a Range
        // behind a failed If-Range is ignored (§13.1.5).
        const range =
          c.req.method === "GET" && c.req.header("If-Range") === undefined
            ? byteRange(c.req.header("Range"), size)
            : null;
        if (range === "unsatisfiable") {
          return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
        }
        if (range) {
          // Read into memory (at most FILE_SIZE_CAP_BYTES) rather than hand
          // over the sliced Bun.file. A header set after `next()` makes Hono
          // rebuild the response around its `body`. On Bun 1.3.14 the body of
          // a sliced Bun.file then runs past the slice to the end of the
          // file, and a stream body loses its Content-Length. Bytes keep both.
          const bytes = await Bun.file(abs).slice(range.start, range.end + 1).bytes();
          if (bytes.length === 0) {
            return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
          }
          // A file cut short since it was measured: describe the bytes that
          // were read, and say the total is no longer known (RFC 9110 §14.4).
          const whole = bytes.length === range.end - range.start + 1;
          return new Response(bytes, {
            status: 206,
            headers: {
              ...headers,
              "Content-Range": `bytes ${range.start}-${range.start + bytes.length - 1}/${whole ? size : "*"}`,
              "Content-Length": String(bytes.length),
            },
          });
        }
        return new Response(Bun.file(abs), {
          status: 200,
          headers: { ...headers, "Content-Length": String(size) },
        });
      }
      const result = await readFileContent(path, brainRoot);
      return c.json({ path, ...result });
    } catch (err) {
      const { body, status } = errorResponse(err, log);
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
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  })

  .get("/files/wikilinks", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    const now = Date.now();
    try {
      if (refresh || !wikilinkCache || now - wikilinkCache.generatedAt > WIKILINK_TTL_MS) {
        if (!wikilinkBuild) {
          wikilinkBuild = buildWikilinkMap(brainRoot).then((map) => {
            wikilinkCache = { generatedAt: Date.now(), map };
          }).finally(() => { wikilinkBuild = null; });
        }
        await wikilinkBuild;
      }
      return c.json({
        generatedAt: wikilinkCache!.generatedAt,
        count: Object.keys(wikilinkCache!.map).length,
        slugs: wikilinkCache!.map,
      });
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  });
}
