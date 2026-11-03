import type { Logger } from "@opentelemetry/api-logs";
import { realpath, stat } from "node:fs/promises";
import { Hono, type Context } from "hono";
import type { Database } from "bun:sqlite";
import { FILE_SIZE_CAP_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import { getUntrustedMark, listUntrustedMarks, markKey, type UntrustedMark } from "../files/untrusted-marks.js";
import { createUntrustedMarkWrites } from "../files/untrusted-mark-writes.js";
import type { SqliteWriter } from "../db/write-worker.js";
import {
  safeResolve,
  listDirectory,
  readFileContent,
  resolveAncestors,
  resolveForRaw,
  classifyKind,
  buildWikilinkMap,
  NotFoundError,
  PathEscapeError,
  TooLargeError,
} from "../files/walker.js";

const WIKILINK_TTL_MS = 30_000;

/** Where the interactive HTML preview is served (#1084). */
export const HTML_PREVIEW_PATH = "/api/files/html";

/**
 * The interactive HTML preview's policy (#1084). The `sandbox` directive gives
 * the document an opaque origin, whether it is framed or opened as a tab, so
 * its script can read neither the app's DOM nor its cookies or storage.
 * `connect-src 'none'` stops every fetch, XHR, WebSocket and EventSource,
 * whatever the auth mode. `form-action 'none'` and the missing `allow-forms`
 * stop form submission. The missing `allow-popups`, `allow-downloads` and
 * `allow-top-navigation` stop window.open, downloads and navigation of the
 * app's own window.
 *
 * The maintainer ruling accepts two residual risks: no directive restricts a
 * document navigating *itself*, so the page can carry what it can read (its own
 * file and anything typed into it) to any URL; and a tab shows that content
 * under the app's host. `tests/html-preview-runtime.test.ts` in ui-react
 * asserts both, so a change to either is a reviewed diff.
 */
export const HTML_PREVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

const HTML_REQUEST = /\.html?$/i;

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

/**
 * The answer to a `Range` request, or null to serve the whole file.
 *
 * The body is read into memory (at most FILE_SIZE_CAP_BYTES) rather than
 * handed over as a sliced Bun.file. A header set after `next()` makes Hono
 * rebuild the response around its `body`. On Bun 1.3.14 the body of a sliced
 * Bun.file then runs past the slice to the end of the file, and a stream body
 * loses its Content-Length. Bytes keep both.
 *
 * A read that comes back short means the file changed after it was measured.
 * It is measured again and the range answered once more at its new size. A
 * file still changing after that gets the bytes that were read, with its
 * total marked unknown (RFC 9110 §14.4).
 */
async function rangeResponse(
  rel: string,
  abs: string,
  snapshot: Uint8Array<ArrayBuffer> | undefined,
  header: string | undefined,
  size: number,
  headers: Record<string, string>
): Promise<Response | null> {
  let known = size;
  for (let attempt = 0; attempt < 2; attempt++) {
    const range = byteRange(header, known);
    if (range === null) return null;
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${known}` } });
    }
    const bytes = snapshot ? snapshot.slice(range.start, range.end + 1) : await Bun.file(abs).slice(range.start, range.end + 1).bytes();
    const whole = bytes.length === range.end - range.start + 1;
    if (whole || (attempt === 1 && bytes.length > 0)) {
      return new Response(bytes, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${range.start}-${range.start + bytes.length - 1}/${whole ? known : "*"}`,
          "Content-Length": String(bytes.length),
        },
      });
    }
    try {
      known = (await stat(abs)).size;
    } catch {
      throw new NotFoundError(rel);
    }
    if (known > FILE_SIZE_CAP_BYTES) throw new TooLargeError(known);
  }
  return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${known}` } });
}

/**
 * Who may clear an untrusted mark and see retained missing records and marker
 * labels (#2673, authority ruling B): the human owner, by the same predicate
 * the storage and history routes use. Every other authenticated principal is
 * a reader.
 */
function isHumanOwner(principal: Principal | undefined): boolean {
  return principal !== undefined && (principal.kind === "owner" || principal.kind === "ambient");
}

/**
 * Whether `path` names a file this request may read: the `GET /files/content`
 * rule, without reading it. A path that no longer resolves inside the brain
 * (a parent became a link out of it) is as unreadable as a missing one.
 */
async function readableFile(path: string, brainRoot: string): Promise<boolean> {
  try { return (await stat(await safeResolve(path, brainRoot))).isFile(); }
  catch (err) { if (err instanceof PathEscapeError || (err as NodeJS.ErrnoException).code) return false; throw err; }
}

/**
 * A mark as one principal may see it. Only the owner gets the marker's
 * label, and `you` when the owner's own principal marked it; a reader's
 * response carries no marker field at all (disclosure ruling A).
 */
function markView(mark: UntrustedMark, principal: Principal | undefined, missing: boolean) {
  return {
    path: mark.path, marked: true as const, markedAt: mark.markedAt, missing,
    ...(isHumanOwner(principal) ? { markedBy: { label: mark.markedByLabel, you: mark.markedBy !== null && mark.markedBy === principal!.id } } : {}),
  };
}

interface FilesRouteDeps {
  brainRoot: string;
  log?: Logger;
  /** The untrusted-mark records (#2673) and the hosted write worker they commit on. Absent: the mark routes are not mounted. */
  marks?: { db: Database; writer?: SqliteWriter };
}

export function createFilesRoutes(deps: FilesRouteDeps): Hono<AppEnv> {
  const { brainRoot, log } = deps;
  let wikilinkBuild: Promise<void> | null = null;
  let wikilinkCache: { generatedAt: number; map: Record<string, string> } | null = null;
  const app = new Hono<AppEnv>()
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
        const { abs, mime, size, bytes: snapshot } = await resolveForRaw(path, brainRoot);
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
        if (c.req.method === "GET" && c.req.header("If-Range") === undefined) {
          const partial = await rangeResponse(path, abs, snapshot, c.req.header("Range"), size, headers);
          if (partial) return partial;
        }
        // A file in an agent-writable area arrives as a snapshot, never reopened by path (#1626).
        const file = snapshot ? new Blob([snapshot]) : Bun.file(abs);
        // Bun.serve can apply the original Range again to a native file body,
        // even after this route chose 200 for an unmatched If-Range or HEAD.
        // Materialize only ignored-range GET responses; the size cap still
        // bounds the read. HEAD reads no body, and ordinary full-file GET
        // keeps its native body. A shortened file names the bytes actually read.
        const body = c.req.method === "HEAD" ? null
          : c.req.header("Range") === undefined ? file
          : await file.slice(0, size).bytes();
        return new Response(body, {
          status: 200,
          headers: {
            ...headers,
            "Content-Length": String(body instanceof Uint8Array ? body.byteLength : size),
          },
        });
      }
      const result = await readFileContent(path, brainRoot);
      return c.json({ path, ...result });
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  })

  // The interactive preview (#1084): the same path, auth and size rules as
  // `?raw=1`, restricted to HTML, served under HTML_PREVIEW_CSP. The app's
  // frame middleware gives this response alone X-Frame-Options: SAMEORIGIN.
  .get("/files/html", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "missing_path" }, 400);
    if (!HTML_REQUEST.test(path)) return c.json({ error: "not_html" }, 400);
    try {
      const { abs, size, kind, bytes: snapshot } = await resolveForRaw(path, brainRoot);
      // A symlink named .html may resolve to a file that is not. A snapshot
      // (#1626) was classified by its resolved path already.
      if ((snapshot ? kind : classifyKind(await realpath(abs))) !== "html") return c.json({ error: "not_html" }, 400);
      return new Response(snapshot ?? Bun.file(abs), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(size),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": HTML_PREVIEW_CSP,
          // A self-navigation the ruling accepts must not also carry the path.
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, max-age=0, must-revalidate",
        },
      });
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
  if (deps.marks) mountUntrustedMarks(app, brainRoot, deps.marks, log);
  return app;
}

/**
 * The untrusted-mark routes (#2673). Marking needs the read access
 * `GET /files/content` already grants and a file at the path; it grants
 * nothing further. Clearing is the owner's alone, for present and missing
 * records. A reader never learns of a record whose file is gone, nor who
 * marked a file: those are filtered here, not in the UI.
 */
function mountUntrustedMarks(app: Hono<AppEnv>, brainRoot: string, store: NonNullable<FilesRouteDeps["marks"]>, log?: Logger) {
  const marks = { db: store.db, writes: createUntrustedMarkWrites(store.db, store.writer) };
  const failed = (c: Context<AppEnv>, err: unknown) => { const { body, status } = errorResponse(err, log); return c.json(body, status); };
  /** The request's record key, after the same path validation as a read. */
  const keyFor = async (path: string | undefined) => {
    if (!path) return { error: "missing_path" as const };
    const key = markKey(path);
    if (key === null) throw new PathEscapeError(path);
    return { key, readable: await readableFile(key, brainRoot) };
  };
  const detail = (key: string, readable: boolean, principal: Principal | undefined) => {
    const mark = getUntrustedMark(marks.db, key);
    const owner = isHumanOwner(principal);
    if (!readable && !(owner && mark)) return null;
    return mark ? { ...markView(mark, principal, !readable), canClear: owner } : { path: key, marked: false as const, canClear: owner };
  };

  app.get("/files/untrusted", async (c) => {
    try {
      const target = await keyFor(c.req.query("path"));
      if ("error" in target) return c.json(target, 400);
      const view = detail(target.key, target.readable, c.get("principal"));
      return view ? c.json(view) : c.json({ error: "not_found" }, 404);
    } catch (err) { return failed(c, err); }
  });

  app.get("/files/untrusted/list", async (c) => {
    const principal = c.get("principal");
    const owner = isHumanOwner(principal);
    try {
      const rows: ReturnType<typeof markView>[] = [];
      for (const mark of listUntrustedMarks(marks.db)) {
        const readable = await readableFile(mark.path, brainRoot);
        if (readable || owner) rows.push(markView(mark, principal, !readable));
      }
      // Missing records first, because they need the owner's action; then newest first.
      rows.sort((a, b) => Number(b.missing) - Number(a.missing) || b.markedAt - a.markedAt || a.path.localeCompare(b.path));
      return c.json({ marks: rows, canClear: owner });
    } catch (err) { return failed(c, err); }
  });

  app.put("/files/untrusted", async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_body" }, 400);
    if (body.path !== undefined && typeof body.path !== "string") return c.json({ error: "invalid_path" }, 400);
    try {
      const target = await keyFor(body.path as string | undefined);
      if ("error" in target) return c.json(target, 400);
      if (!target.readable) return c.json({ error: "not_found" }, 404);
      const principal = c.get("principal");
      const status = await marks.writes.mark(target.key, principal?.id ?? null, Date.now());
      return c.json({ status, mark: detail(target.key, true, principal) });
    } catch (err) { return failed(c, err); }
  });

  app.delete("/files/untrusted", async (c) => {
    const principal = c.get("principal");
    if (!isHumanOwner(principal)) return c.json({ error: "owner_required" }, 403);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "missing_path" }, 400);
    // A retained record is cleared by its key alone: its file may be gone.
    const key = markKey(path);
    if (key === null) return c.json({ error: "invalid_path" }, 400);
    try { return c.json({ status: await marks.writes.clear(key) }); }
    catch (err) { return failed(c, err); }
  });
}
