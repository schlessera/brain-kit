/**
 * The declared reference inventory for media findings (#2781, epic #1777,
 * design rev 4 §3): which notes point at a media file, found by one bounded
 * scan of the brain's Markdown. It is what a Move rewrites, what a Delete
 * lists, and its digest is the `refs` field of every media fingerprint, so a
 * disposition is bound to the references somebody could have seen.
 *
 * Only declared forms count, never an arbitrary string match:
 * - **Rewritable:** Markdown inline links and images (including `<…>`
 *   destinations), reference definitions, and wiki links and embeds.
 * - **Detected, never rewritten:** frontmatter scalars and arrays, and HTML
 *   `src`, `href` and `poster` attributes. A Move refuses on them; a Delete
 *   lists them.
 * Code blocks and inline code are never references. Links from outside the
 * brain (sites, other apps, chat history) cannot be seen at all.
 *
 * The scan is bounded by the Q1 limits (ruling Q1 A), each checked before
 * the work it limits. Past any limit the whole scan is refused
 * (`inventory-too-large`); a note that cannot be read as UTF-8 refuses it as
 * `inventory-unscannable`. A refused scan never reports "no references".
 * Everything here reads; nothing writes.
 */

import { createHash } from "crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { posix } from "path";
import { Glob } from "bun";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { frontmatterLength } from "./document-parts.js";

/** The Q1 limits one reference scan enforces (rev 4 §3.2). */
export interface MediaReferenceLimits {
  /** `*.md` files opened; checked before each open. */
  notes: number;
  /** Raw bytes read from notes; checked before each 64 KiB read. */
  noteBytes: number;
  /** One note's size (`fstat` on the open descriptor, and while reading). */
  perNote: number;
  /** Milliseconds from scan start, on a monotonic clock; checked between notes and chunks. */
  scanTime: number;
  /** Reference entries kept for one finding. */
  refsPerFinding: number;
}

/** Q1 A defaults: 50,000 notes, 256 MiB, 4 MiB per note, 20 s, 500 references per finding. */
export const DEFAULT_MEDIA_REFERENCE_LIMITS: Readonly<MediaReferenceLimits> = Object.freeze({
  notes: 50_000,
  noteBytes: 256 * 1024 * 1024,
  perNote: 4 * 1024 * 1024,
  scanTime: 20_000,
  refsPerFinding: 500,
});

const LIMIT_KEYS = Object.keys(DEFAULT_MEDIA_REFERENCE_LIMITS) as Array<keyof MediaReferenceLimits>;

/**
 * The limits a trusted host set (`BRAIN_MEDIA_REFERENCE_LIMITS`, for example
 * `notes=1000,scanTime=5000`), over the defaults. Each named limit must be a
 * positive integer, and `perNote` may not exceed `noteBytes`. Anything else
 * is refused rather than guessed. The result is a snapshot: a scan keeps the
 * limits it started with.
 */
export function mediaReferenceLimits(value: string | undefined): MediaReferenceLimits {
  const limits: MediaReferenceLimits = { ...DEFAULT_MEDIA_REFERENCE_LIMITS };
  if (value === undefined || value.trim() === "") return limits;
  const seen = new Set<string>();
  for (const pair of value.split(",")) {
    const m = /^\s*([A-Za-z]+)=([1-9][0-9]{0,11})\s*$/.exec(pair);
    if (!m || !LIMIT_KEYS.includes(m[1] as keyof MediaReferenceLimits) || seen.has(m[1]!)) {
      throw new Error(`BRAIN_MEDIA_REFERENCE_LIMITS must be <limit>=<positive integer> pairs of ${LIMIT_KEYS.join(", ")}, each at most once, not "${pair.trim()}"`);
    }
    seen.add(m[1]!);
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n)) throw new Error(`BRAIN_MEDIA_REFERENCE_LIMITS: ${m[1]} is too large`);
    limits[m[1] as keyof MediaReferenceLimits] = n;
  }
  if (limits.perNote > limits.noteBytes) {
    throw new Error(`BRAIN_MEDIA_REFERENCE_LIMITS: perNote (${limits.perNote}) may not exceed noteBytes (${limits.noteBytes})`);
  }
  return Object.freeze(limits);
}

/** The declared reference forms. The first five a Move rewrites; the last two it refuses on. */
export type MediaReferenceKind = "link" | "image" | "definition" | "wiki" | "embed" | "frontmatter" | "html";

const REWRITABLE: ReadonlySet<MediaReferenceKind> = new Set(["link", "image", "definition", "wiki", "embed"]);

/** One place a note points at a media file. */
export interface MediaReference {
  /** The media file it names (repo-relative). */
  path: string;
  /** The note's repo-relative path. */
  note: string;
  /** 1-based line of the destination in the note. */
  line: number;
  kind: MediaReferenceKind;
  /** The destination exactly as written (for wiki forms, the part before `|` or `#`). */
  target: string;
  /** `[start, end)` string offsets of `target` in the note's text, for a rewrite; null for detected-only forms. */
  span: [number, number] | null;
  /** Whether a Move may rewrite it: a declared rewritable form whose destination was located exactly. */
  rewritable: boolean;
}

export type MediaReferenceRefusal =
  | { code: "inventory-too-large"; limit: keyof MediaReferenceLimits; effective: number; observed: number }
  | { code: "inventory-unscannable"; path: string; reason: "not-utf8" | "unreadable" | "aborted" };

export type MediaReferenceScan =
  | {
      status: "complete";
      /** Each scanned target path's references, in note then offset order. Every target has an entry. */
      references: Map<string, MediaReference[]>;
      /** Notes opened and bytes read. */
      notes: number;
      bytes: number;
      limits: MediaReferenceLimits;
    }
  | { status: "refused"; refusal: MediaReferenceRefusal; limits: MediaReferenceLimits };

export interface MediaReferenceScanOptions {
  limits?: MediaReferenceLimits;
  /** Monotonic milliseconds; tests inject a clock. */
  now?: () => number;
  /** Checked where `scanTime` is: a superseded preview stops its scan. */
  signal?: AbortSignal;
}

/** Notes are `*.md` outside hidden directories (`.brain/`, `.git/`), dependencies and the hygiene log itself. */
const PROTECTED = ["node_modules/", "context/hygiene/"];
const CHUNK = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Refused extends Error {
  constructor(readonly refusal: MediaReferenceRefusal) {
    super(refusal.code);
  }
}

/** Every note the scan reads, in path order. Hidden directories and symlinked directories are not walked. */
export function referenceNotes(root: string): string[] {
  const notes: string[] = [];
  for (const path of new Glob("**/*.md").scanSync({ cwd: root, dot: false, followSymlinks: false, onlyFiles: true })) {
    const rel = path.split("\\").join("/");
    if (PROTECTED.some((p) => rel.startsWith(p) || rel.includes(`/${p}`))) continue;
    notes.push(rel);
  }
  return notes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/*
 * The slice of mdast this reads, typed structurally (see document-parts.ts
 * for why not through `@types/mdast`).
 */
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

const markdown = unified().use(remarkParse).use(remarkGfm);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/**
 * The repo-relative path a Markdown or HTML destination in `note` names, or
 * null for a URL, a fragment-only link or anything outside the brain. A
 * leading `/` is the brain root; anything else is relative to the note.
 */
export function resolveDestination(note: string, destination: string): string | null {
  let d = destination.trim();
  if (d.startsWith("<") && d.endsWith(">")) d = d.slice(1, -1);
  if (d === "" || SCHEME.test(d) || d.startsWith("//")) return null;
  d = d.split("#")[0]!.split("?")[0]!;
  if (d === "") return null;
  d = decode(d);
  const joined = d.startsWith("/") ? posix.normalize(d.slice(1)) : posix.normalize(posix.join(posix.dirname(note), d));
  if (joined === "." || joined.startsWith("../") || joined === ".." || posix.isAbsolute(joined)) return null;
  return joined;
}

/** A wiki link's name: what comes before `|` and `#`, trimmed. */
function wikiName(inner: string): string {
  return inner.split("|")[0]!.split("#")[0]!.trim();
}

/** Whether a wiki name points at `target`: its root-relative path, or its basename when the name has no folder. */
function wikiMatches(name: string, target: string): boolean {
  if (name === "") return false;
  if (name.includes("/")) return posix.normalize(name.replace(/^\//, "")) === target;
  return name === posix.basename(target);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Offsets that are code, so their text is never a reference. */
function codeMask(node: MdNode, ranges: Array<[number, number]>): void {
  if (node.type === "code" || node.type === "inlineCode") {
    const s = node.position?.start.offset, e = node.position?.end.offset;
    if (s !== undefined && e !== undefined) ranges.push([s, e]);
    return;
  }
  for (const child of node.children ?? []) codeMask(child, ranges);
}

const inside = (ranges: Array<[number, number]>, offset: number) => ranges.some(([s, e]) => offset >= s && offset < e);

/**
 * Where an inline link's, image's or definition's destination is written in
 * its node's source, or null when it cannot be located exactly. The located
 * text must resolve to the same URL the parser read, so a rewrite never
 * touches anything else.
 */
function destinationSpan(text: string, node: MdNode, base: number): [number, number] | null {
  const s = node.position?.start.offset, e = node.position?.end.offset;
  if (s === undefined || e === undefined || node.url === undefined) return null;
  const source = text.slice(base + s, base + e);
  const pattern = node.type === "definition" ? /\]:[ \t]*(?:\r?\n[ \t]*)?(<[^<>\n]*>|[^\s<>]+)/g : /\]\([ \t]*(?:\r?\n[ \t]*)?(<[^<>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)/g;
  let found: [number, number] | null = null;
  for (const m of source.matchAll(pattern)) {
    const raw = m[1]!;
    const value = raw.startsWith("<") ? raw.slice(1, -1) : raw;
    if (value.replace(/\\(.)/g, "$1") !== node.url && decode(value) !== decode(node.url)) continue;
    const start = base + s + m.index! + m[0].length - raw.length + (raw.startsWith("<") ? 1 : 0);
    found = [start, start + value.length];
  }
  return found;
}

const HTML_ATTR = /\b(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * Every declared reference in one note's `text` to any of `targets`.
 * Exported for the effect that re-reads a note before it rewrites it.
 */
export function noteReferences(note: string, text: string, targets: ReadonlySet<string>): MediaReference[] {
  const found: MediaReference[] = [];
  const add = (path: string | null, row: Omit<MediaReference, "rewritable" | "path">) => {
    if (path === null || !targets.has(path)) return;
    found.push({ path, ...row, rewritable: REWRITABLE.has(row.kind) && row.span !== null });
  };
  const base = frontmatterLength(text);

  // Frontmatter: any string value naming a target, by path or by basename.
  if (base > 0) {
    let data: unknown = {};
    try {
      data = parseFrontmatter(text, { dataOnly: true }).data;
    } catch {
      data = {};
    }
    const basenames = new Map<string, string[]>();
    for (const t of targets) basenames.set(posix.basename(t), [...(basenames.get(posix.basename(t)) ?? []), t]);
    const visit = (value: unknown) => {
      if (typeof value === "string") {
        const resolved = resolveDestination(note, value);
        const hits = new Set<string>([...(resolved !== null && targets.has(resolved) ? [resolved] : []), ...(basenames.get(value.trim()) ?? [])]);
        for (const hit of hits) add(hit, { note, line: lineAt(text, Math.max(0, text.indexOf(value))), kind: "frontmatter", target: value, span: null });
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(data);
  }

  const body = text.slice(base);
  const tree = markdown.parse(body) as MdNode;
  const code: Array<[number, number]> = [];
  codeMask(tree, code);
  const walk = (node: MdNode) => {
    if (node.type === "code" || node.type === "inlineCode") return;
    const offset = node.position?.start.offset;
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && node.url !== undefined && offset !== undefined) {
      const span = destinationSpan(text, node, base);
      add(resolveDestination(note, node.url), {
        note,
        line: lineAt(text, span?.[0] ?? base + offset),
        kind: node.type,
        target: span ? text.slice(span[0], span[1]) : node.url,
        span,
      });
    }
    if (node.type === "html" && node.value !== undefined && offset !== undefined) {
      for (const m of node.value.matchAll(HTML_ATTR)) {
        const value = m[2] ?? m[3] ?? m[4] ?? "";
        add(resolveDestination(note, value.replace(/&amp;/g, "&")), { note, line: lineAt(text, base + offset + m.index!), kind: "html", target: value, span: null });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);

  // Wiki links and embeds are not CommonMark: find them in the body outside code.
  for (const m of body.matchAll(/(!?)\[\[([^\[\]\n]+)\]\]/g)) {
    if (inside(code, m.index!)) continue;
    const name = wikiName(m[2]!);
    const lead = m[2]!.length - m[2]!.trimStart().length;
    const start = base + m.index! + m[1]!.length + 2 + lead;
    for (const t of targets) {
      if (!wikiMatches(name, t)) continue;
      add(t, { note, line: lineAt(text, start), kind: m[1] ? "embed" : "wiki", target: name, span: [start, start + name.length] });
    }
  }
  return found.sort((a, b) => a.line - b.line || (a.span?.[0] ?? 0) - (b.span?.[0] ?? 0) || a.kind.localeCompare(b.kind));
}

/** The literal strings a note must contain before it is parsed for `targets`. */
function needles(targets: ReadonlySet<string>): string[] {
  const set = new Set<string>();
  for (const t of targets) {
    const name = posix.basename(t);
    set.add(name);
    set.add(encodeURI(name));
  }
  return [...set];
}

/** One note's bytes under the per-note, total-byte, time and abort checks. */
function readNote(root: string, note: string, limits: MediaReferenceLimits, state: { bytes: number }, check: () => void): Buffer {
  let fd: number;
  try {
    fd = openSync(posix.join(root, note), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Refused({ code: "inventory-unscannable", path: note, reason: "unreadable" });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Refused({ code: "inventory-unscannable", path: note, reason: "unreadable" });
    if (stat.size > limits.perNote) throw new Refused({ code: "inventory-too-large", limit: "perNote", effective: limits.perNote, observed: stat.size });
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      check();
      // Read what fstat promised in 64 KiB chunks, each charged before it is
      // read; then one probe byte, so a note that grew is seen and charged.
      const remaining = stat.size - total;
      const want = remaining > 0 ? Math.min(CHUNK, remaining) : 1;
      if (remaining > 0 && state.bytes + want > limits.noteBytes) {
        throw new Refused({ code: "inventory-too-large", limit: "noteBytes", effective: limits.noteBytes, observed: state.bytes + want });
      }
      const buffer = Buffer.alloc(want);
      let read: number;
      try {
        read = readSync(fd, buffer, 0, want, null);
      } catch {
        throw new Refused({ code: "inventory-unscannable", path: note, reason: "unreadable" });
      }
      if (read === 0) break;
      state.bytes += read;
      total += read;
      if (state.bytes > limits.noteBytes) throw new Refused({ code: "inventory-too-large", limit: "noteBytes", effective: limits.noteBytes, observed: state.bytes });
      // A note that grows past the bound while it is read is refused too.
      if (total > limits.perNote) throw new Refused({ code: "inventory-too-large", limit: "perNote", effective: limits.perNote, observed: total });
      chunks.push(buffer.subarray(0, read));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan the brain's notes for declared references to `targets` (repo-relative
 * media paths). Complete, with every target's references, or refused with
 * the one limit or path that stopped it; nothing is ever partly reported.
 */
export function scanMediaReferences(root: string, targets: readonly string[], options: MediaReferenceScanOptions = {}): MediaReferenceScan {
  const limits = options.limits ?? DEFAULT_MEDIA_REFERENCE_LIMITS;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const wanted = new Set(targets);
  const references = new Map<string, MediaReference[]>([...wanted].map((t) => [t, []]));
  const state = { bytes: 0 };
  let opened = 0;
  const check = () => {
    if (options.signal?.aborted) throw new Refused({ code: "inventory-unscannable", path: "", reason: "aborted" });
    const elapsed = now() - started;
    if (elapsed > limits.scanTime) throw new Refused({ code: "inventory-too-large", limit: "scanTime", effective: limits.scanTime, observed: Math.ceil(elapsed) });
  };
  try {
    if (wanted.size === 0) return { status: "complete", references, notes: 0, bytes: 0, limits };
    const look = needles(wanted);
    for (const note of referenceNotes(root)) {
      check();
      if (opened + 1 > limits.notes) throw new Refused({ code: "inventory-too-large", limit: "notes", effective: limits.notes, observed: opened + 1 });
      opened++;
      const bytes = readNote(root, note, limits, state, check);
      let text: string;
      try {
        text = UTF8.decode(bytes);
      } catch {
        throw new Refused({ code: "inventory-unscannable", path: note, reason: "not-utf8" });
      }
      if (!look.some((n) => text.includes(n))) continue;
      for (const ref of noteReferences(note, text, wanted)) {
        const rows = references.get(ref.path)!;
        if (rows.length + 1 > limits.refsPerFinding) {
          throw new Refused({ code: "inventory-too-large", limit: "refsPerFinding", effective: limits.refsPerFinding, observed: rows.length + 1 });
        }
        rows.push(ref);
      }
    }
    check();
    return { status: "complete", references, notes: opened, bytes: state.bytes, limits };
  } catch (e) {
    if (e instanceof Refused) return { status: "refused", refusal: e.refusal, limits };
    throw e;
  }
}

/**
 * The `refs` fingerprint field for one target: `none` with no references,
 * otherwise a digest of each reference's note, form and written destination.
 * Line numbers are left out, so an edit elsewhere in a note does not reopen a
 * decision. A refused scan records its reason instead (`too-large`,
 * `unscannable`), never a digest that would claim the set was checked.
 */
export function referenceDigest(scan: MediaReferenceScan, target: string): string {
  if (scan.status === "refused") return scan.refusal.code === "inventory-too-large" ? "too-large" : "unscannable";
  const rows = scan.references.get(target) ?? [];
  if (rows.length === 0) return "none";
  const lines = rows.map((r) => `${r.note}\t${r.kind}\t${r.target}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}
