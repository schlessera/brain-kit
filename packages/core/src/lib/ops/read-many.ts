/**
 * The bounded multi-document read behind `brain_read_many` (MCP and pi) and
 * `brain read-many --json` (#3642). One operation, three thin adapters; the
 * contract is docs/decisions/bounded-multi-read.md and its integration-contract
 * section ("Bounded multi-read", docs/integration-contract/mcp.md).
 *
 * Every size here is counted in UTF-16 code units of serialized JSON
 * (`JSON.stringify(x).length`), field names, quoting and escaping included.
 * The whole result fits `max_total_chars` and every item `max_item_chars`.
 * Items keep request order; before each item the call reserves room for a
 * `budget_exhausted` stub for every later request, so no request is dropped.
 *
 * Each member is read with the authority of a single `brain_read`: the path
 * goes through the same resolver (`safeResolve` unless the caller injects its
 * own, which pi does with the same rule), so absolute paths, `..`, colon and
 * backslash segments and links out of the root are refused. Files are read
 * through the filesystem the caller runs in, so whatever a sandbox masks is
 * missing here as it is for `brain_read`. Error items carry a code and a
 * fixed message, never a host path.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

import { estimateTokens } from "../chunker.js";
import { documentScope, ScopeSectionNotFoundError, sectionMatchKey, type DocumentScope } from "../document-parts.js";
import { safeResolve } from "../safe-path.js";

/** Most requests one call accepts; more is rejected, never clamped. */
export const READ_MANY_MAX_REQUESTS = 20;
/** Default, floor and ceiling of the whole serialized result. */
export const READ_MANY_DEFAULT_TOTAL_CHARS = 24_000;
export const READ_MANY_MIN_TOTAL_CHARS = 2_000;
export const READ_MANY_MAX_TOTAL_CHARS = 40_000;
/** Default and floor of one item's serialized JSON. The default never exceeds `max_total_chars`. */
export const READ_MANY_DEFAULT_ITEM_CHARS = 8_000;
export const READ_MANY_MIN_ITEM_CHARS = 512;
/** Largest file one request reads; a larger one is a `too_large` item. */
export const READ_MANY_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Largest sum of distinct files one call reads; past it, `work_limit` items. */
export const READ_MANY_MAX_CALL_BYTES = 16 * 1024 * 1024;
export const READ_MANY_MAX_PATH_CHARS = 1024;
export const READ_MANY_MAX_SECTION_CHARS = 512;

/**
 * The tool description every surface sends. Descriptive and neutral: it
 * states what the tool does and does not steer an agent toward it, since no
 * real-model trial has measured its use (docs/decisions/bounded-multi-read.md,
 * "Rollout and verification gates"). It enters every provider request of a
 * session that has the tool, so grow it only with that cost in mind.
 */
export const READ_MANY_DESCRIPTION =
  `Read up to ${READ_MANY_MAX_REQUESTS} documents or sections by path in one bounded JSON result. The whole result stays ` +
  `within max_total_chars (default ${READ_MANY_DEFAULT_TOTAL_CHARS}, ${READ_MANY_MIN_TOTAL_CHARS}-${READ_MANY_MAX_TOTAL_CHARS}) and each item within ` +
  `max_item_chars (default ${READ_MANY_DEFAULT_ITEM_CHARS}), counted as JSON characters with metadata and escaping. Items keep ` +
  "request order; each is full (the text brain_read returns), outline (frontmatter if it fits, headings with estimated " +
  "tokens), partial (a page; continue with next.offset and next.column), duplicate (of an earlier item) or error (a code). " +
  "Pass an item's sha256 as expected_sha256 when continuing, so a changed file is reported instead of mixed.";

/** One request, as every surface accepts it. */
export const readManyRequestSchema = z
  .object({
    path: z.string().min(1).max(READ_MANY_MAX_PATH_CHARS).describe("Relative path to the document"),
    section: z.string().max(READ_MANY_MAX_SECTION_CHARS).optional().describe("Heading text of one section"),
    offset: z.number().int().min(1).optional().describe("Line to page from (next.offset)"),
    column: z.number().int().min(0).optional().describe("Column in the offset line (next.column)"),
    expected_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("sha256 of an earlier item of this file"),
  })
  .strict();

/** The input fields, as the MCP tool registers them. */
export const readManyInputShape = {
  requests: z.array(readManyRequestSchema).min(1).max(READ_MANY_MAX_REQUESTS).describe("In priority order"),
  max_total_chars: z
    .number()
    .int()
    .min(READ_MANY_MIN_TOTAL_CHARS)
    .max(READ_MANY_MAX_TOTAL_CHARS)
    .optional(),
  max_item_chars: z
    .number()
    .int()
    .min(READ_MANY_MIN_ITEM_CHARS)
    .max(READ_MANY_MAX_TOTAL_CHARS)
    .optional(),
};
export const readManyInputSchema = z.object(readManyInputShape).strict();

export type ReadManyRequest = z.infer<typeof readManyRequestSchema>;
export type ReadManyInput = z.infer<typeof readManyInputSchema>;

interface ItemBase {
  index: number;
  path: string;
  section?: string;
}
interface Measured extends ItemBase {
  sha256: string;
  /** UTF-8 bytes of the requested scope (the document, or the section). */
  bytes: number;
  /** UTF-16 code units of the requested scope. */
  chars: number;
  /** `ceil(chars / 4)`: an estimate, never a provider count. */
  est_tokens: number;
}
export interface ReadManyFullItem extends ItemBase {
  kind: "full";
  sha256: string;
  /** Byte for byte what `brain_read` returns for the same path and section. */
  content: string;
}
export interface ReadManyOutlineHeading {
  level: number;
  text: string;
  est_tokens: number;
}
export interface ReadManyOutlineItem extends Measured {
  kind: "outline";
  frontmatter?: string;
  frontmatter_chars?: number;
  headings: ReadManyOutlineHeading[];
  omitted_headings?: number;
  next: { offset: 1 };
}
export interface ReadManyPartialItem extends Measured {
  kind: "partial";
  offset: number;
  column?: number;
  /** Lines in the whole scope. */
  lines: number;
  /** Lines this page touches, a line it ends inside included. */
  returned_lines: number;
  text: string;
  next?: { offset: number; column?: number };
}
export type ReadManyErrorCode =
  | "refused"
  | "not_found"
  | "not_a_file"
  | "too_large"
  | "work_limit"
  | "read_failed"
  | "section_not_found"
  | "source_changed"
  | "bad_offset"
  | "budget_exhausted";
export interface ReadManyErrorItem extends ItemBase {
  kind: "error";
  code: ReadManyErrorCode;
  message: string;
  sha256?: string;
  headings?: string[];
}
export interface ReadManyDuplicateItem extends ItemBase {
  kind: "duplicate";
  /** Index of the earlier item that stands for this request. */
  of: number;
}
export type ReadManyItem = ReadManyFullItem | ReadManyOutlineItem | ReadManyPartialItem | ReadManyErrorItem | ReadManyDuplicateItem;

export interface ReadManyResult {
  items: ReadManyItem[];
  /** True when an item is an outline, an error, or a page with a `next`. */
  truncated: boolean;
  max_total_chars: number;
  max_item_chars: number;
  warnings: string[];
}

/** The whole call is refused before anything is read. Its message names the input, never a host path. */
export class ReadManyRequestError extends Error {}

/** What the call read, for tests and measurements; never part of a result. */
export interface ReadManyWork {
  filesRead: number;
  bytesRead: number;
}

/** The file access the operation uses; tests replace it to observe or perturb I/O. */
export interface ReadManyIo {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(path: string): Promise<Buffer>;
}

export interface ReadManyOptions {
  /** Checked before every request and before and after every file read; an aborted call rejects with its reason. */
  signal?: AbortSignal;
  /** The call's tool warnings, carried once in the envelope. */
  warnings?: string[];
  /** The resolver a single read uses on this surface; `safeResolve(root, path)` when omitted. */
  resolve?: (path: string) => string | null;
  work?: ReadManyWork;
  io?: ReadManyIo;
}

const MESSAGES = {
  refused: "The path is refused: it is absolute, has a '..', ':' or '\\' segment, or leaves the brain root through a link.",
  not_found: "No document at this path.",
  not_a_file: "The path is not a file.",
  too_large: `The file is larger than ${READ_MANY_MAX_FILE_BYTES} bytes.`,
  work_limit: `This call already read ${READ_MANY_MAX_CALL_BYTES} bytes; ask for this request in another call.`,
  read_failed: "The file could not be read.",
  source_changed: "The file is not the version expected_sha256 names; read it again.",
  budget_exhausted: "No result budget was left for this request; ask for it again.",
} as const;

const jsonLength = (value: unknown) => JSON.stringify(value).length;
const escapedLength = (text: string) => JSON.stringify(text).length - 2;
/** Wider than any count or line number a result can hold, so a reserved size is never short. */
const WIDEST = Number.MAX_SAFE_INTEGER;

const defaultIo: ReadManyIo = { stat, readFile };

/** Validate the input and resolve the caps. Invalid input is refused, never clamped. */
export function parseReadManyInput(input: unknown): { requests: ReadManyRequest[]; totalCap: number; itemCap: number } {
  const parsed = readManyInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "input";
    throw new ReadManyRequestError(`invalid ${where}: ${issue?.message ?? "malformed input"}`);
  }
  const { requests, max_total_chars, max_item_chars } = parsed.data;
  const totalCap = max_total_chars ?? READ_MANY_DEFAULT_TOTAL_CHARS;
  const itemCap = max_item_chars ?? Math.min(READ_MANY_DEFAULT_ITEM_CHARS, totalCap);
  if (itemCap > totalCap) throw new ReadManyRequestError("invalid max_item_chars: must not exceed max_total_chars");
  for (const [i, r] of requests.entries()) {
    if (r.column !== undefined && r.offset === undefined) throw new ReadManyRequestError(`invalid requests.${i}.column: needs offset`);
  }
  return { requests, totalCap, itemCap };
}

function base(index: number, r: ReadManyRequest): ItemBase {
  return { index, path: r.path, ...(r.section !== undefined ? { section: r.section } : {}) };
}

function errorItem(b: ItemBase, code: Exclude<ReadManyErrorCode, "section_not_found" | "bad_offset">, sha256?: string): ReadManyErrorItem {
  return { ...b, kind: "error", code, message: MESSAGES[code], ...(sha256 ? { sha256 } : {}) };
}

const stub = (b: ItemBase) => errorItem(b, "budget_exhausted");

interface Snapshot {
  text: string;
  sha256: string;
}

/** Lines with their terminators kept, so a page is an exact slice and pages join back to the scope. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function measured(snap: Snapshot, scope: string): Omit<Measured, keyof ItemBase> {
  return { sha256: snap.sha256, bytes: Buffer.byteLength(scope, "utf8"), chars: scope.length, est_tokens: estimateTokens(scope) };
}

/**
 * A page of `scope` from line `offset`, column `column`, within `budget`
 * chars of item JSON: whole lines while they fit, then the fitting prefix of
 * the next line, cut on a code point.
 */
function pageItem(b: ItemBase, snap: Snapshot, scope: string, offset: number, column: number, budget: number): ReadManyItem {
  const lines = splitLines(scope);
  const badOffset = (message: string): ReadManyErrorItem => ({ ...b, kind: "error", code: "bad_offset", message, sha256: snap.sha256 });
  if (offset > Math.max(1, lines.length)) return badOffset(`offset is past the last line (${lines.length}).`);
  const first = lines[offset - 1] ?? "";
  if (column > 0 && column >= first.length) return badOffset("column is past the end of the offset line.");
  if (column > 0 && isLow(first.charCodeAt(column)) && isHigh(first.charCodeAt(column - 1)))
    return badOffset("column splits a character; use a next.column this tool returned.");

  const m = measured(snap, scope);
  const shape = (text: string, returned: number, next?: { offset: number; column?: number }): ReadManyPartialItem => ({
    ...b,
    kind: "partial",
    ...m,
    offset,
    ...(column > 0 ? { column } : {}),
    lines: lines.length,
    returned_lines: returned,
    text,
    ...(next ? { next } : {}),
  });
  const room = budget - jsonLength(shape("", WIDEST, { offset: WIDEST, column: WIDEST }));
  if (room <= 0) return stub(b);

  const taken: string[] = [];
  let used = 0;
  let next: { offset: number; column?: number } | undefined;
  for (let i = offset - 1; i < lines.length; i++) {
    const start = i === offset - 1 ? column : 0;
    const line = lines[i]!.slice(start);
    const size = escapedLength(line);
    if (used + size <= room) {
      taken.push(line);
      used += size;
      continue;
    }
    let end = 0;
    for (const point of line) {
      const cost = escapedLength(point);
      if (used + cost > room) break;
      end += point.length;
      used += cost;
    }
    if (end > 0) taken.push(line.slice(0, end));
    next = start + end > 0 ? { offset: i + 1, column: start + end } : { offset: i + 1 };
    break;
  }
  const text = taken.join("");
  // Nothing fit, and there is more: an empty page would make no progress.
  if (text === "" && next) return stub(b);
  return shape(text, taken.length, next);
}

/** The outline of a scope too large to return whole, or null when it has no headings to choose between. */
function outlineItem(b: ItemBase, snap: Snapshot, scope: DocumentScope, section: string | undefined, budget: number): ReadManyOutlineItem | null {
  const all = scope.headings;
  // A section whose only heading is its own has nothing to choose between.
  if (all.length === 0 || (section !== undefined && all.length < 2)) return null;
  const m = measured(snap, scope.content);
  type Fm = Pick<ReadManyOutlineItem, "frontmatter" | "frontmatter_chars">;
  const shell = (fm: Fm, headings: ReadManyOutlineHeading[], omitted: number): ReadManyOutlineItem => ({
    ...b,
    kind: "outline",
    ...m,
    ...fm,
    headings,
    ...(omitted > 0 ? { omitted_headings: omitted } : {}),
    next: { offset: 1 },
  });
  let fm: Fm = section === undefined && scope.frontmatter ? { frontmatter: scope.frontmatter } : {};
  if (fm.frontmatter !== undefined && jsonLength(shell(fm, [], WIDEST)) > budget) fm = { frontmatter_chars: scope.frontmatter.length };
  let size = jsonLength(shell(fm, [], WIDEST));
  const kept: ReadManyOutlineHeading[] = [];
  for (const h of all) {
    const heading = { level: h.level, text: h.text, est_tokens: h.tokens };
    const cost = jsonLength(heading) + (kept.length > 0 ? 1 : 0);
    if (size + cost > budget) break;
    kept.push(heading);
    size += cost;
  }
  // An outline with no heading in it offers no choice; a page does better.
  if (kept.length === 0) return null;
  const item = shell(fm, kept, all.length - kept.length);
  return jsonLength(item) <= budget ? item : null;
}

/** One item within `budget` chars of JSON, from a file already read. */
function readItem(b: ItemBase, r: ReadManyRequest, snap: Snapshot, budget: number): ReadManyItem {
  if (r.expected_sha256 !== undefined && r.expected_sha256 !== snap.sha256) return errorItem(b, "source_changed", snap.sha256);
  let scope: DocumentScope;
  try {
    scope = documentScope(snap.text, r.section);
  } catch (e) {
    if (!(e instanceof ScopeSectionNotFoundError)) throw e;
    const all = e.available;
    const shape = (headings: string[]): ReadManyErrorItem => ({
      ...b,
      kind: "error",
      code: "section_not_found",
      message:
        all.length === 0
          ? "No section matches; the document has no headings."
          : headings.length < all.length
            ? `No section matches; headings lists ${headings.length} of the document's ${all.length} headings.`
            : "No section matches; headings lists the document's headings.",
      sha256: snap.sha256,
      ...(all.length > 0 ? { headings } : {}),
    });
    // Sized with the longest message and an empty list, so the kept headings always fit.
    let size = jsonLength({ ...shape([]), message: `No section matches; headings lists ${WIDEST} of the document's ${WIDEST} headings.`, headings: [] });
    const kept: string[] = [];
    for (const h of all) {
      const cost = jsonLength(h) + (kept.length > 0 ? 1 : 0);
      if (size + cost > budget) break;
      kept.push(h);
      size += cost;
    }
    return shape(kept);
  }
  if (r.offset !== undefined) return pageItem(b, snap, scope.content, r.offset, r.column ?? 0, budget);
  const full: ReadManyFullItem = { ...b, kind: "full", sha256: snap.sha256, content: scope.content };
  if (jsonLength(full) <= budget) return full;
  return outlineItem(b, snap, scope, r.section, budget) ?? pageItem(b, snap, scope.content, 1, 0, budget);
}

async function readSnapshot(b: ItemBase, full: string, work: ReadManyWork, io: ReadManyIo): Promise<Snapshot | ReadManyErrorItem> {
  let size: number;
  try {
    const st = await io.stat(full);
    if (!st.isFile()) return errorItem(b, "not_a_file");
    size = st.size;
  } catch (e) {
    return errorItem(b, (e as NodeJS.ErrnoException)?.code === "ENOENT" || (e as NodeJS.ErrnoException)?.code === "ENOTDIR" ? "not_found" : "read_failed");
  }
  if (size > READ_MANY_MAX_FILE_BYTES) return errorItem(b, "too_large");
  if (work.bytesRead + size > READ_MANY_MAX_CALL_BYTES) return errorItem(b, "work_limit");
  let data: Buffer;
  try {
    data = await io.readFile(full);
  } catch (e) {
    return errorItem(b, (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "not_found" : "read_failed");
  }
  work.filesRead++;
  work.bytesRead += data.byteLength;
  // The file may have grown between stat and read.
  if (data.byteLength > READ_MANY_MAX_FILE_BYTES) return errorItem(b, "too_large");
  if (work.bytesRead > READ_MANY_MAX_CALL_BYTES) return errorItem(b, "work_limit");
  return { text: data.toString("utf8"), sha256: createHash("sha256").update(data).digest("hex") };
}

/**
 * Read up to {@link READ_MANY_MAX_REQUESTS} documents or sections under one
 * serialized-size budget. Throws {@link ReadManyRequestError}, having read
 * nothing, when the input is invalid or the caps cannot hold a stub for every
 * request. Each distinct file is read once, so every item of one file names
 * the same version. A cancelled call rejects with the signal's reason and
 * returns nothing partial.
 */
export async function readMany(root: string, input: unknown, opts: ReadManyOptions = {}): Promise<ReadManyResult> {
  const { requests, totalCap, itemCap } = parseReadManyInput(input);
  const warnings = [...(opts.warnings ?? [])];
  const resolve = opts.resolve ?? ((path: string) => safeResolve(root, path));
  const work = opts.work ?? { filesRead: 0, bytesRead: 0 };
  const io = opts.io ?? defaultIo;
  const signal = opts.signal;

  const bases = requests.map((r, i) => base(i, r));
  const stubSizes = bases.map((b) => jsonLength(stub(b)));
  if (stubSizes.some((n) => n > itemCap)) throw new ReadManyRequestError("max_item_chars is too small for a request's path and section");
  const commas = (i: number) => (i > 0 ? 1 : 0);
  const envelope = jsonLength({ items: [], truncated: false, max_total_chars: totalCap, max_item_chars: itemCap, warnings });
  const reserveFrom = new Array<number>(requests.length + 1).fill(0);
  for (let i = requests.length - 1; i >= 0; i--) reserveFrom[i] = reserveFrom[i + 1]! + stubSizes[i]! + commas(i);
  if (envelope + reserveFrom[0]! > totalCap) throw new ReadManyRequestError("max_total_chars is too small to answer every request");

  signal?.throwIfAborted();
  const snapshots = new Map<string, Snapshot | ReadManyErrorItem>();
  const seen = new Map<string, number>();
  const items: ReadManyItem[] = [];
  let used = envelope;
  for (const [i, r] of requests.entries()) {
    signal?.throwIfAborted();
    const b = bases[i]!;
    const budget = Math.min(itemCap, totalCap - used - reserveFrom[i + 1]! - commas(i));
    let item: ReadManyItem;
    const full = resolve(r.path);
    if (!full) {
      item = errorItem(b, "refused");
    } else {
      const key = JSON.stringify([full, r.section === undefined ? null : sectionMatchKey(r.section), r.offset ?? null, r.column ?? 0, r.expected_sha256 ?? null]);
      const first = seen.get(key);
      if (first !== undefined) {
        item = { ...b, kind: "duplicate", of: first };
      } else {
        seen.set(key, i);
        let snap = snapshots.get(full);
        if (!snap) {
          signal?.throwIfAborted();
          snap = await readSnapshot(b, full, work, io);
          signal?.throwIfAborted();
          snapshots.set(full, snap);
        }
        // A file that failed fails the same way for every request of it, labelled with that request.
        item = "kind" in snap ? { ...b, kind: "error", code: snap.code, message: snap.message } : readItem(b, r, snap, budget);
      }
    }
    if (jsonLength(item) > budget) item = stub(b);
    items.push(item);
    used += jsonLength(item) + commas(i);
  }
  const truncated = items.some((it) => it.kind === "outline" || it.kind === "error" || (it.kind === "partial" && it.next !== undefined));
  return { items, truncated, max_total_chars: totalCap, max_item_chars: itemCap, warnings };
}
