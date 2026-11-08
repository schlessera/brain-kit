/**
 * PRIVATE prototype of a bounded multi-document read for the #3641 spike.
 *
 * Not exported by any package, not registered with the MCP server or a
 * backend, and not a supported contract. It exists so the experiment harness
 * can measure the candidate contract written up in
 * docs/decisions/bounded-multi-read.md against individual `brain_read`
 * calls. It reuses the shipped primitives: path containment (`safeResolve`),
 * section selection and the outline (`readDocumentPart`), and line/column
 * paging (`brainReadBaseResult`).
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { frontmatterLength, readDocumentPart, SectionNotFoundError } from "../../packages/core/src/lib/document-parts.ts";
import { safeResolve } from "../../packages/core/src/lib/safe-path.ts";
import { brainReadBaseResult } from "../../packages/ui-sdk/src/server/brain-read-base.ts";

/** Most requests one call accepts; more is rejected, never clamped. */
export const MAX_ITEMS = 20;
/** Ceiling, and default, of the whole serialized result, in UTF-16 code units of its JSON. */
export const MAX_TOTAL_CHARS = 40_000;
export const DEFAULT_TOTAL_CHARS = 24_000;
export const MIN_TOTAL_CHARS = 2_000;
/** Default and floor of one item's serialized JSON, in UTF-16 code units. */
export const DEFAULT_ITEM_CHARS = 8_000;
export const MIN_ITEM_CHARS = 512;
/** Largest file one item reads; bigger is an item error, not a partial read. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Largest sum of distinct files one call reads. */
export const MAX_RAW_BYTES = 16 * 1024 * 1024;
export const MAX_PATH_CHARS = 1024;
export const MAX_SECTION_CHARS = 512;

export interface ReadManyRequest {
  path: string;
  section?: string;
  /** 1-based line of the requested scope (document or section) to page from. */
  offset?: number;
  /** Code-unit column inside the offset line, from a previous `next.column`. */
  column?: number;
  /** Whole-file SHA-256 from an earlier item; a different file is `source_changed`. */
  expected_sha256?: string;
}

export interface ReadManyInput {
  requests: ReadManyRequest[];
  max_total_chars?: number;
  max_item_chars?: number;
}

interface ItemBase { index: number; path: string; section?: string }
interface Measured extends ItemBase { sha256: string; bytes: number; chars: number; est_tokens: number }
export interface FullItem extends Measured { kind: "full"; content: string }
export interface OutlineHeading { level: number; text: string; est_tokens: number }
export interface OutlineItem extends Measured {
  kind: "outline";
  frontmatter?: string;
  frontmatter_chars?: number;
  headings: OutlineHeading[];
  omitted_headings?: number;
  next: { offset: 1 };
}
export interface PartialItem extends Measured {
  kind: "partial";
  offset: number;
  column?: number;
  lines: number;
  returned_lines: number;
  text: string;
  next?: { offset: number; column?: number };
}
export type ErrorCode =
  | "refused" | "not_found" | "not_a_file" | "too_large" | "work_limit" | "read_failed"
  | "section_not_found" | "source_changed" | "bad_offset" | "budget_exhausted";
export interface ErrorItem extends ItemBase { kind: "error"; code: ErrorCode; message: string; sha256?: string; headings?: string[] }
export interface DuplicateItem extends ItemBase { kind: "duplicate"; of: number }
export type ReadManyItem = FullItem | OutlineItem | PartialItem | ErrorItem | DuplicateItem;

export interface ReadManyResult {
  items: ReadManyItem[];
  /** True when any item is not the whole of what it asked for. */
  truncated: boolean;
  max_total_chars: number;
  max_item_chars: number;
  warnings: string[];
}

/** A request the whole call refuses before reading anything. */
export class ReadManyRequestError extends Error {}

/** Work the prototype did, for the harness; never part of a result. */
export interface ReadManyWork { filesRead: number; rawBytes: number }

const json = (value: unknown) => JSON.stringify(value).length;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const estTokens = (chars: number) => Math.ceil(chars / 4);

/** Fold a section query the way a duplicate check needs: case and whitespace insensitive. */
const sectionKey = (section: string | undefined) =>
  section === undefined ? "" : section.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

function validate(input: ReadManyInput): { totalCap: number; itemCap: number } {
  const { requests } = input;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_ITEMS)
    throw new ReadManyRequestError(`requests must hold 1 to ${MAX_ITEMS} items`);
  const totalCap = input.max_total_chars ?? DEFAULT_TOTAL_CHARS;
  if (!Number.isInteger(totalCap) || totalCap < MIN_TOTAL_CHARS || totalCap > MAX_TOTAL_CHARS)
    throw new ReadManyRequestError(`max_total_chars must be a whole number from ${MIN_TOTAL_CHARS} to ${MAX_TOTAL_CHARS}`);
  const itemCap = input.max_item_chars ?? Math.min(DEFAULT_ITEM_CHARS, totalCap);
  if (!Number.isInteger(itemCap) || itemCap < MIN_ITEM_CHARS || itemCap > totalCap)
    throw new ReadManyRequestError(`max_item_chars must be a whole number from ${MIN_ITEM_CHARS} to max_total_chars`);
  for (const r of requests) {
    if (typeof r.path !== "string" || r.path.length < 1 || r.path.length > MAX_PATH_CHARS)
      throw new ReadManyRequestError(`every path must be 1 to ${MAX_PATH_CHARS} characters`);
    if (r.section !== undefined && (typeof r.section !== "string" || r.section.length > MAX_SECTION_CHARS))
      throw new ReadManyRequestError(`a section must be at most ${MAX_SECTION_CHARS} characters`);
    if (r.offset !== undefined && (!Number.isInteger(r.offset) || r.offset < 1)) throw new ReadManyRequestError("offset must be a whole number from 1");
    if (r.column !== undefined && (!Number.isInteger(r.column) || r.column < 0)) throw new ReadManyRequestError("column must be a whole number from 0");
    if (r.column !== undefined && r.offset === undefined) throw new ReadManyRequestError("column needs an offset");
  }
  return { totalCap, itemCap };
}

function base(index: number, r: ReadManyRequest): ItemBase {
  return { index, path: r.path, ...(r.section !== undefined ? { section: r.section } : {}) };
}

function stub(index: number, r: ReadManyRequest): ErrorItem {
  return { ...base(index, r), kind: "error", code: "budget_exhausted", message: "No result budget remained for this request; ask for it again." };
}

interface Snapshot { text: string; sha256: string; bytes: number }

/** The outline lines `readDocumentPart` writes, parsed back into headings. */
function outlineHeadings(text: string, section: string | undefined): OutlineHeading[] {
  const outline = readDocumentPart(text, { section, maxTokens: 1, sectionHint: 'section: "<heading>"' });
  const headings: OutlineHeading[] = [];
  for (const line of outline.split("\n")) {
    const m = /^\s*- (#+) (.*) \(~(\d+) tokens\)$/.exec(line);
    if (m) headings.push({ level: m[1]!.length, text: m[2]!, est_tokens: Number(m[3]) });
  }
  return headings;
}

/** The longest prefix of `all` whose `size` stays within `budget`. Quadratic; production sizes incrementally. */
function fitArray<T>(all: T[], budget: number, size: (kept: T[]) => number): T[] {
  const kept: T[] = [];
  for (const h of all) {
    kept.push(h);
    if (size(kept) > budget) { kept.pop(); break; }
  }
  return kept;
}

function page(b: ItemBase, snap: Snapshot, scope: string, offset: number, column: number, budget: number): PartialItem | ErrorItem {
  const measured = { ...b, sha256: snap.sha256, bytes: snap.bytes, chars: scope.length, est_tokens: estTokens(scope.length) };
  // Size of the item with empty text and the widest continuation it can carry.
  const skeleton = json({ ...measured, kind: "partial", offset, ...(column ? { column } : {}), lines: Number.MAX_SAFE_INTEGER,
    returned_lines: Number.MAX_SAFE_INTEGER, text: "", next: { offset: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER } });
  const room = Math.max(0, budget - skeleton);
  const at = (o: number, c: number, n: number) => {
    const p = brainReadBaseResult({ content: scope, expectedBaseHash: snap.sha256 }, { offset: o, column: c }, n);
    if (!("text" in p)) throw new Error("unreachable: a ranged read always pages");
    return p;
  };
  let p = at(offset, column, room);
  if (offset > Math.max(1, p.lines)) return { ...b, kind: "error", code: "bad_offset", message: `offset is past the last line (${p.lines})`, sha256: snap.sha256 };
  let { text, returnedLines } = p;
  // brain_read_base stops before a whole line that does not fit; a bounded
  // read fills the rest of its budget with that line's prefix instead.
  if (p.nextOffset !== undefined && p.nextColumn === undefined && p.returnedLines > 0) {
    const used = text.length === 0 ? 0 : JSON.stringify(text).length - 2;
    const rest = at(p.nextOffset, 0, room - used);
    if (rest.text) { text += rest.text; returnedLines += rest.returnedLines; p = rest; }
  }
  if (text === "" && p.nextOffset !== undefined) return stub(b.index, b as ReadManyRequest);
  return { ...measured, kind: "partial", offset, ...(column ? { column } : {}), lines: p.lines, returned_lines: returnedLines, text,
    ...(p.nextOffset !== undefined ? { next: { offset: p.nextOffset, ...(p.nextColumn !== undefined ? { column: p.nextColumn } : {}) } } : {}) };
}

function outline(b: ItemBase, snap: Snapshot, scope: string, section: string | undefined, budget: number): OutlineItem | null {
  const all = outlineHeadings(snap.text, section);
  // A section whose only heading is its own has nothing to choose between.
  if (all.length === 0 || (section !== undefined && all.length < 2)) return null;
  const measured = { ...b, sha256: snap.sha256, bytes: snap.bytes, chars: scope.length, est_tokens: estTokens(scope.length) };
  const frontmatter = section === undefined ? snap.text.slice(0, frontmatterLength(snap.text)) : "";
  const shell = (fm: Partial<OutlineItem>, headings: OutlineHeading[], omitted: number): OutlineItem =>
    ({ ...measured, kind: "outline", ...fm, headings, ...(omitted ? { omitted_headings: omitted } : {}), next: { offset: 1 } });
  const widest = Number.MAX_SAFE_INTEGER;
  let fm: Partial<OutlineItem> = frontmatter ? { frontmatter } : {};
  if (frontmatter && json(shell(fm, [], widest)) > budget) fm = { frontmatter_chars: frontmatter.length };
  const kept = fitArray(all, budget, k => json(shell(fm, k, widest)));
  const item = shell(fm, kept, all.length - kept.length);
  return json(item) <= budget ? item : null;
}

/** One item within `budget` chars of JSON, or the reason it has none. */
function readItem(index: number, r: ReadManyRequest, snap: Snapshot, budget: number): ReadManyItem {
  const b = base(index, r);
  if (r.expected_sha256 !== undefined && r.expected_sha256 !== snap.sha256)
    return { ...b, kind: "error", code: "source_changed", message: "The file changed since the expected version; reread it.", sha256: snap.sha256 };
  let scope: string;
  try {
    scope = r.section === undefined ? snap.text : readDocumentPart(snap.text, { section: r.section, sectionHint: 'section: "<heading>"' });
  } catch (e) {
    if (!(e instanceof SectionNotFoundError)) throw e;
    const headings = outlineHeadings(snap.text, undefined).map(h => h.text);
    const err = (hs: string[]): ErrorItem => ({ ...b, kind: "error", code: "section_not_found", sha256: snap.sha256,
      message: hs.length < headings.length ? `No such section; ${hs.length} of ${headings.length} headings listed.` : "No such section.", headings: hs });
    return err(fitArray(headings, budget, k => json(err(k))));
  }
  if (r.offset !== undefined) return page(b, snap, scope, r.offset, r.column ?? 0, budget);
  const full: FullItem = { ...b, kind: "full", sha256: snap.sha256, bytes: snap.bytes, chars: scope.length, est_tokens: estTokens(scope.length), content: scope };
  if (json(full) <= budget) return full;
  return outline(b, snap, scope, r.section, budget) ?? page(b, snap, scope, 1, 0, budget);
}

/**
 * Read up to {@link MAX_ITEMS} documents or sections, in request order, with
 * the whole JSON result within `max_total_chars` UTF-16 code units. Every
 * distinct file is read once, so items of one file agree on its version.
 * Cancellation is checked before each file read and after it; a cancelled
 * call rejects with the signal's reason and returns nothing partial.
 */
export async function readManyPrototype(root: string, input: ReadManyInput, opts: { signal?: AbortSignal; warnings?: string[]; work?: ReadManyWork } = {}): Promise<ReadManyResult> {
  const { totalCap, itemCap } = validate(input);
  const warnings = opts.warnings ?? [];
  const work = opts.work ?? { filesRead: 0, rawBytes: 0 };
  const stubs = input.requests.map((r, i) => json(stub(i, r)) + (i > 0 ? 1 : 0));
  const envelope = json({ items: [], truncated: false, max_total_chars: totalCap, max_item_chars: itemCap, warnings });
  if (envelope + stubs.reduce((a, n) => a + n, 0) > totalCap)
    throw new ReadManyRequestError("max_total_chars is too small to answer every request");

  const snapshots = new Map<string, Snapshot | ErrorItem>();
  const seen = new Map<string, number>();
  const items: ReadManyItem[] = [];
  let used = envelope;
  for (const [i, r] of input.requests.entries()) {
    const reserve = stubs.slice(i + 1).reduce((a, n) => a + n, 0);
    const comma = i > 0 ? 1 : 0;
    const budget = Math.min(itemCap, totalCap - used - reserve - comma);
    const b = base(i, r);
    let item: ReadManyItem;
    const full = safeResolve(root, r.path);
    if (!full) {
      item = { ...b, kind: "error", code: "refused", message: "The path is refused: it is absolute, leaves the brain root or crosses a link out of it." };
    } else {
      const key = JSON.stringify([full, sectionKey(r.section), r.offset ?? 0, r.column ?? 0, r.expected_sha256 ?? ""]);
      const first = seen.get(key);
      if (first !== undefined) {
        item = { ...b, kind: "duplicate", of: first };
      } else {
        seen.set(key, i);
        let snap = snapshots.get(full);
        if (!snap) {
          opts.signal?.throwIfAborted();
          snap = await snapshot(b, full, work);
          opts.signal?.throwIfAborted();
          snapshots.set(full, snap);
        }
        item = "kind" in snap ? { ...snap, ...b } : readItem(i, r, snap, budget);
      }
    }
    if (json(item) > budget) item = stub(i, r);
    items.push(item);
    used += json(item) + comma;
  }
  const truncated = items.some(it => it.kind !== "full" && it.kind !== "duplicate");
  return { items, truncated, max_total_chars: totalCap, max_item_chars: itemCap, warnings };
}

async function snapshot(b: ItemBase, full: string, work: ReadManyWork): Promise<Snapshot | ErrorItem> {
  let size: number;
  try {
    const st = await stat(full);
    if (!st.isFile()) return { ...b, kind: "error", code: "not_a_file", message: "The path is not a file." };
    size = st.size;
  } catch {
    return { ...b, kind: "error", code: "not_found", message: "No document at this path." };
  }
  if (size > MAX_FILE_BYTES) return { ...b, kind: "error", code: "too_large", message: `The file is over ${MAX_FILE_BYTES} bytes.` };
  if (work.rawBytes + size > MAX_RAW_BYTES) return { ...b, kind: "error", code: "work_limit", message: "This call already read its limit; ask for the rest separately." };
  try {
    const data = await readFile(full);
    // The file may have grown between stat and read.
    if (data.byteLength > MAX_FILE_BYTES) return { ...b, kind: "error", code: "too_large", message: `The file is over ${MAX_FILE_BYTES} bytes.` };
    work.filesRead++;
    work.rawBytes += data.byteLength;
    return { text: data.toString("utf-8"), sha256: sha(data), bytes: data.byteLength };
  } catch {
    return { ...b, kind: "error", code: "read_failed", message: "The file could not be read." };
  }
}

/**
 * The tool definition the decision proposes, so the harness can measure what
 * it would add to every request's tool roster. Not registered anywhere.
 */
export const PROPOSED_TOOL = {
  name: "brain_read_many",
  description:
    `Read up to ${MAX_ITEMS} documents or sections by path in one bounded result. Each request names a path, optionally a ` +
    "section heading, and optionally offset/column to continue a page. The whole JSON result stays within max_total_chars " +
    `(default ${DEFAULT_TOTAL_CHARS}, at most ${MAX_TOTAL_CHARS}) and each item within max_item_chars (default ${DEFAULT_ITEM_CHARS}), ` +
    "counted as JSON characters with escaping and metadata. Each item's kind is full (verbatim), outline (frontmatter when it " +
    "fits, then headings with estimated tokens), partial (a page with the next offset/column), duplicate (of an earlier item) " +
    "or error (a code and message). Items carry the file's sha256: pass it as expected_sha256 when continuing, so a changed " +
    "file is reported instead of mixed. brain_read still returns one whole document of any size.",
  inputSchema: {
    type: "object",
    properties: {
      requests: {
        type: "array", minItems: 1, maxItems: MAX_ITEMS,
        items: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: MAX_PATH_CHARS, description: "Relative path to the document" },
            section: { type: "string", maxLength: MAX_SECTION_CHARS, description: "Heading text of one section" },
            offset: { type: "integer", minimum: 1, description: "Line of the document or section to continue from" },
            column: { type: "integer", minimum: 0, description: "Column inside the offset line, from next.column" },
            expected_sha256: { type: "string", description: "sha256 of an earlier item of this file" },
          },
          required: ["path"], additionalProperties: false,
        },
      },
      max_total_chars: { type: "integer", minimum: MIN_TOTAL_CHARS, maximum: MAX_TOTAL_CHARS, default: DEFAULT_TOTAL_CHARS },
      max_item_chars: { type: "integer", minimum: MIN_ITEM_CHARS, maximum: MAX_TOTAL_CHARS, default: DEFAULT_ITEM_CHARS },
    },
    required: ["requests"], additionalProperties: false,
  },
} as const;
