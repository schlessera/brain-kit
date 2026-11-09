/**
 * Paged document discovery (#3643): the one implementation behind
 * `brain list --overview/--path-prefix/--cursor`, `brain_list`'s matching
 * MCP inputs and the `pageIndexDocuments` content-index query that pi's
 * `brain_list` uses. Each caller supplies its own connection; the selection,
 * the cursor, the source check and the output bound are shared, so the three
 * surfaces return the same page for the same index.
 *
 * Order: `updated` descending, then `path` ascending (byte order), a total
 * order, so a keyset cursor resumes exactly after the last row a page
 * returned. The legacy listings keep their own order and are not routed here.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { statSync } from "fs";

import { safeResolve } from "./safe-path.js";

/** The hard bound on one page: UTF-8 bytes of the compact JSON envelope. */
export const DOCUMENT_PAGE_MAX_BYTES = 30_000;

/** Warnings may use at most this share of the page budget before the rest are counted, not listed. */
const WARNING_SHARE = 4;

/** How many paths a source warning names before it only counts. */
const NAMED_PATHS = 3;

/** The filters and scope of one paged listing. */
export interface DocumentPageInput {
  type?: string;
  tag?: string;
  status?: string;
  relevance?: string;
  /** Archived documents too; without it they are listed only when `status` is `archived`. */
  includeArchived?: boolean;
  /** A root-relative folder or file key; matched on whole path segments. */
  pathPrefix?: string;
  /** A `next_cursor` from an earlier page of the same listing. */
  cursor?: string;
  /** Adds summary, updated, deadline, indexed_at and indexed_body_bytes to every row. */
  overview?: boolean;
  /** Rows per page, 1 to 100; the caller validates it. */
  limit: number;
}

/** One listed document. The overview fields appear only when `overview` was requested. */
export interface PagedDocument {
  path: string;
  title: string;
  type: string;
  relevance: string | null;
  status: string | null;
  tags: string | null;
  /** Frontmatter `summary` as indexed, or null. */
  summary?: string | null;
  /** Frontmatter `updated` as indexed; the indexer stores its run date when the frontmatter has none. Not the file's mtime. */
  updated?: string;
  /** Frontmatter `deadline` as indexed, or null. */
  deadline?: string | null;
  /** When the index last wrote this row (ISO 8601). */
  indexed_at?: string;
  /** UTF-8 bytes of the body the index stored (frontmatter excluded) as of `indexed_at`; null for a non-markdown asset. */
  indexed_body_bytes?: number | null;
  /** Text fields shortened to keep a single oversized row within the page bound. */
  clipped?: string[];
}

/** One page: the rows, the cursor for the next page, the scope's size and the warnings. */
export interface DocumentPage {
  documents: PagedDocument[];
  /** Pass to the next call of the same listing; null when this page reached the end. */
  next_cursor: string | null;
  /** Documents matching the filters and prefix in this index snapshot, across all pages. */
  total: number;
  /** Present when the byte bound ended the page before `limit` rows; the rest follow under `next_cursor`. */
  truncated?: true;
  warnings: string[];
}

/** A refused input, with a message naming what to change. */
export class DocumentPageError extends Error {
  constructor(readonly code: "invalid_prefix" | "invalid_cursor" | "cursor_scope", message: string) {
    super(message);
    this.name = "DocumentPageError";
  }
}

/**
 * A root-relative key as stored in the index: slash separated, no empty, `.`
 * or `..` segment, not absolute, no backslash or control character. One
 * trailing slash is allowed (`projects/active/`) and dropped.
 */
export function normalizePathPrefix(value: unknown): string {
  const refuse = () => {
    throw new DocumentPageError(
      "invalid_prefix",
      "path_prefix must be a root-relative folder or file such as projects/active, without .., a leading slash or a backslash"
    );
  };
  if (typeof value !== "string" || value.trim() === "" || /[\x00-\x1f\x7f]/.test(value)) refuse();
  const raw = value as string;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\\")) refuse();
  const parts = (raw.endsWith("/") ? raw.slice(0, -1) : raw).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) refuse();
  return parts.join("/");
}

interface CursorState {
  v: 1;
  /** Hash of the filters and prefix the cursor was issued for. */
  s: string;
  /** `updated` and `path` of the last row the page returned. */
  u: string;
  p: string;
  /** Hash of the scope's row count and newest `indexed_at` when it was issued. */
  f: string;
}

const hash16 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

function scopeHash(input: DocumentPageInput, prefix: string | undefined): string {
  return hash16(JSON.stringify([input.type ?? null, input.tag ?? null, input.status ?? null, input.relevance ?? null, input.includeArchived === true, prefix ?? null]));
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): CursorState {
  const invalid = () => {
    throw new DocumentPageError("invalid_cursor", "cursor is not a cursor this listing issued; restart without cursor");
  };
  if (typeof cursor !== "string" || cursor === "" || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(cursor as string, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  const s = state as Partial<CursorState> | null;
  const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
  if (!s || typeof s !== "object" || s.v !== 1 || !hex(s.s) || !hex(s.f) || typeof s.u !== "string" || typeof s.p !== "string" || s.p === "") {
    invalid();
  }
  return s as CursorState;
}

/** What a page's selection read from one index snapshot, before it is bounded. */
export interface DocumentPageSelection {
  /** Up to `limit` rows in page order. */
  rows: Array<PagedDocument & { updated: string; asset_type: string | null }>;
  /** Whether rows beyond `limit` exist. */
  more: boolean;
  total: number;
  scope: string;
  fingerprint: string;
  overview: boolean;
  /** Set when the cursor was issued against a different state of this scope. */
  staleCursor: boolean;
}

/**
 * Read one page's candidate rows, the scope's total and its fingerprint from
 * `db` in one transaction, so a concurrent index commit cannot mix them.
 * Throws {@link DocumentPageError} for a bad prefix or cursor.
 */
export function selectDocumentPage(db: Database, input: DocumentPageInput): DocumentPageSelection {
  const prefix = input.pathPrefix === undefined ? undefined : normalizePathPrefix(input.pathPrefix);
  const scope = scopeHash(input, prefix);
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (cursor && cursor.s !== scope) {
    throw new DocumentPageError(
      "cursor_scope",
      "cursor belongs to a listing with other filters or path_prefix; repeat that listing's filters or restart without cursor"
    );
  }

  const where: string[] = [];
  const params: (string | number)[] = [];
  // The listing rule: archived documents only when status asks for them.
  if (input.status !== "archived" && input.includeArchived !== true) {
    where.push("d.status != ?");
    params.push("archived");
  }
  for (const field of ["type", "status", "relevance"] as const) {
    if (input[field] !== undefined) {
      where.push(`d.${field} = ?`);
      params.push(input[field]!);
    }
  }
  if (input.tag !== undefined) {
    where.push("d.id IN (SELECT dt.document_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.name = ?)");
    params.push(input.tag);
  }
  if (prefix !== undefined) {
    // Whole segments: the key itself, or anything below it. substr, not LIKE,
    // so `%` and `_` in a folder name stay literal.
    where.push("(d.path = ? OR substr(d.path, 1, ?) = ?)");
    params.push(prefix, prefix.length + 1, `${prefix}/`);
  }
  const scoped = where.join(" AND ") || "1=1";

  const overview = input.overview === true;
  const columns = overview
    ? `, d.summary, d.deadline, d.indexed_at, d.asset_type,
       CASE WHEN COALESCE(d.asset_type, 'markdown') = 'markdown' THEN length(CAST(d.content AS BLOB)) END AS indexed_body_bytes`
    : "";

  return db.transaction(() => {
    const scopeRow = db
      .query<{ total: number; newest: string | null }, (string | number)[]>(
        `SELECT COUNT(*) AS total, MAX(d.indexed_at) AS newest FROM documents d WHERE ${scoped}`
      )
      .get(...params)!;
    const fingerprint = hash16(`${scopeRow.total}|${scopeRow.newest ?? ""}`);
    const keyset = cursor ? " AND (d.updated < ? OR (d.updated = ? AND d.path > ?))" : "";
    const keyParams = cursor ? [cursor.u, cursor.u, cursor.p] : [];
    const rows = db
      .query<DocumentPageSelection["rows"][number], (string | number)[]>(
        `SELECT d.path, d.title, d.type, d.relevance, d.status,
          (SELECT GROUP_CONCAT(t.name, ', ') FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id) AS tags,
          d.updated${columns}
        FROM documents d WHERE ${scoped}${keyset}
        ORDER BY d.updated DESC, d.path ASC LIMIT ?`
      )
      .all(...params, ...keyParams, input.limit + 1);
    const more = rows.length > input.limit;
    return {
      rows: rows.slice(0, input.limit),
      more,
      total: scopeRow.total,
      scope,
      fingerprint,
      overview,
      staleCursor: cursor !== undefined && cursor.f !== fingerprint,
    };
  })();
}

/** The row as returned: legacy fields, then the overview fields when requested. */
function project(row: DocumentPageSelection["rows"][number], overview: boolean): PagedDocument {
  const base: PagedDocument = {
    path: row.path,
    title: row.title,
    type: row.type,
    relevance: row.relevance ?? null,
    status: row.status ?? null,
    tags: row.tags ?? null,
  };
  if (!overview) return base;
  return {
    ...base,
    summary: row.summary ?? null,
    updated: row.updated,
    deadline: row.deadline ?? null,
    indexed_at: row.indexed_at!,
    indexed_body_bytes: row.indexed_body_bytes ?? null,
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function summarize(label: string, paths: string[], advice: string): string {
  const named = paths.slice(0, NAMED_PATHS).join(", ");
  const more = paths.length > NAMED_PATHS ? ` and ${paths.length - NAMED_PATHS} more` : "";
  return `${label} for ${paths.length} listed document(s) (${named}${more}); ${advice}`;
}

/**
 * Stat (never read) the source of every markdown row: one warning for files
 * changed after their row was indexed, one for files missing or unreadable.
 */
function sourceWarnings(root: string, rows: DocumentPageSelection["rows"], cache: Map<string, "ok" | "changed" | "missing">): string[] {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    if ((row.asset_type ?? "markdown") !== "markdown") continue;
    let state = cache.get(row.path);
    if (!state) {
      const abs = safeResolve(root, row.path);
      try {
        state = abs && statSync(abs).isFile() ? (statSync(abs).mtimeMs > Date.parse(row.indexed_at!) ? "changed" : "ok") : "missing";
      } catch {
        state = "missing";
      }
      cache.set(row.path, state);
    }
    if (state === "changed") changed.push(row.path);
    if (state === "missing") missing.push(row.path);
  }
  return [
    ...(changed.length
      ? [summarize("source changed after indexing", changed, "their overview fields describe the indexed copy; run `brain index` or read the file")]
      : []),
    ...(missing.length
      ? [summarize("source missing or unreadable", missing, "they are listed from the index only")]
      : []),
  ];
}

/** Warnings in order while they fit their share of the budget, then a count of the rest. */
function boundWarnings(warnings: string[], maxBytes: number): string[] {
  const share = Math.floor(maxBytes / WARNING_SHARE);
  const kept: string[] = [];
  for (const [i, warning] of warnings.entries()) {
    const next = [...kept, warning];
    const rest = warnings.length - i - 1;
    if (bytes([...next, ...(rest ? [`${rest} more warning(s) omitted`] : [])]) > share) {
      return [...kept, `${warnings.length - kept.length} more warning(s) omitted`];
    }
    kept.push(warning);
  }
  return kept;
}

/** Shorten one string field by at least `over` bytes, by whole code points. */
function shorten(text: string, over: number): string {
  const points = Array.from(text.endsWith("…") ? text.slice(0, -1) : text);
  // The ellipsis costs 3 bytes; drop whole code points from the end until
  // at least `over` plus that has gone.
  let dropped = 0;
  let keep = points.length;
  while (keep > 0 && dropped < over + 3) dropped += Buffer.byteLength(points[--keep]!, "utf8");
  return `${points.slice(0, keep).join("")}…`;
}

/**
 * Bound a selection to `maxBytes` of compact JSON: whole rows in order while
 * the envelope (rows, cursor, total, truncated and warnings) fits. A first
 * row too large on its own keeps its path and has its summary, then title,
 * then tags shortened and named in `clipped`, so every page that has rows
 * left returns at least one and advances.
 */
export function finishDocumentPage(
  root: string,
  selection: DocumentPageSelection,
  options: { warnings?: string[]; maxBytes?: number } = {}
): DocumentPage {
  const maxBytes = options.maxBytes ?? DOCUMENT_PAGE_MAX_BYTES;
  const extra = [
    ...(options.warnings ?? []),
    ...(selection.staleCursor
      ? ["the index changed since this cursor was issued; documents changed in between may be skipped or repeated, so restart without cursor for a complete enumeration"]
      : []),
  ];
  const rows = selection.rows;
  const cursorAfter = (row: { updated: string; path: string }) =>
    encodeCursor({ v: 1, s: selection.scope, u: row.updated, p: row.path, f: selection.fingerprint });
  const cache = new Map<string, "ok" | "changed" | "missing">();

  const envelope = (documents: PagedDocument[], count: number, warnings: string[]): DocumentPage => {
    const cut = count < rows.length;
    return {
      documents,
      next_cursor: count > 0 && (cut || selection.more) ? cursorAfter(rows[count - 1]!) : null,
      total: selection.total,
      ...(cut ? { truncated: true as const } : {}),
      warnings,
    };
  };

  const fit = (candidates: number): DocumentPage => {
    const kept = rows.slice(0, candidates);
    const warnings = boundWarnings([...extra, ...(selection.overview ? sourceWarnings(root, kept, cache) : [])], maxBytes);
    const projected = kept.map((r) => project(r, selection.overview));
    let best: DocumentPage | null = null;
    for (let n = 0; n <= projected.length; n++) {
      const page = envelope(projected.slice(0, n), n, warnings);
      if (bytes(page) > maxBytes) break;
      best = page;
    }
    if (best && (best.documents.length > 0 || rows.length === 0)) return best;
    // Not even the first row fits whole: shorten its prose, never its path.
    const first = { ...projected[0]! };
    const clipped: string[] = [];
    for (const field of ["summary", "title", "tags"] as const) {
      for (;;) {
        const page = envelope([{ ...first, ...(clipped.length ? { clipped: [...clipped] } : {}) }], 1, warnings);
        const over = bytes(page) - maxBytes;
        if (over <= 0) return page;
        const value = first[field];
        if (typeof value !== "string" || value === "" || value === "…") break;
        first[field] = shorten(value, over) as never;
        if (!clipped.includes(field)) clipped.push(field);
      }
    }
    const last = envelope([{ ...first, clipped }], 1, warnings);
    if (bytes(last) > maxBytes) throw new Error("one document's path and metadata exceed the page's output bound");
    return last;
  };

  // The source warnings depend on the rows kept; refit until the kept rows
  // and the warnings describing them agree. Each pass keeps no more rows.
  let page = fit(rows.length);
  for (;;) {
    const again = fit(page.documents.length);
    if (again.documents.length === page.documents.length) return again;
    page = again;
  }
}
