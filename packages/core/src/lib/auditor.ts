import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFileSync, existsSync } from "fs";
import matter from "gray-matter";
import { join, posix } from "path";

import { estimateTokens } from "./context-assembler.js";
import { hasDocumentsColumn } from "./db.js";
import { topLevelBlocks } from "./document-parts.js";
import { planRegistry } from "./index-registry.js";
import { codeRanges, inRanges } from "./markdown-code.js";
import type { LoadedModule } from "./module-types.js";
import type { AuditIssue } from "./types.js";
import type { Severity, Taxonomy } from "./taxonomy.js";

/** Milliseconds per day. */
const MS_PER_DAY = 86_400_000;

export interface AuditOptions {
  /** Wall clock to measure ages against — injected for deterministic tests. */
  now?: Date;
  /**
   * The brain root. With it, a `past-date` issue names the line in the file;
   * without it, the line in the document body (after the frontmatter).
   */
  root?: string;
  /**
   * Documents to leave out of every check, as if they were not indexed: their
   * links count for no orphan check, and a module finding on one is dropped.
   * `brain hygiene reconcile` leaves out its own log, so writing the log
   * cannot change what the next run detects.
   */
  exclude?: (path: string) => boolean;
  /**
   * Called when a check could not run, so a caller can tell a check that found
   * nothing from one that did not look: with a module's name when one of its
   * hygiene checks throws (`auditWithModules`), and with a core check's
   * category when it could not read its input (`fact-drift`, `tag-noise`,
   * and `index-stale` when a given root is missing).
   */
  onCheckFailed?: (check: string) => void;
}

/** One indexed markdown document, as the audit checks see it. */
export interface AuditDoc {
  id: number;
  path: string;
  title: string;
  type: string;
  status: string;
  relevance: string;
  updated: string;
  /** `next_review` from the frontmatter as `YYYY-MM-DD`, or null. */
  next_review: string | null;
  content: string;
  /** `generated_from` frontmatter: the source the document is produced from, or null. */
  generated_from: string | null;
}

/**
 * Load all markdown documents. Binary assets (pdf/jpg/png) can't carry
 * wiki-links or frontmatter, so auditing them only produces noise
 * (orphan and type-mismatch findings for every asset).
 */
export function loadAuditDocs(db: Database): AuditDoc[] {
  return db
    .prepare(
      // A read-only connection on a schema-9 index has no generated_from yet.
      `SELECT id, path, title, type, status, relevance, updated, next_review, content,
         ${hasDocumentsColumn(db, "generated_from") ? "generated_from" : "NULL AS generated_from"}
       FROM documents
       WHERE asset_type = 'markdown'
       ORDER BY path`
    )
    .all() as AuditDoc[];
}

export interface StaleDoc {
  doc: AuditDoc;
  ageDays: number;
  threshold: number;
  severity: Severity;
}

/**
 * The documents past their staleness threshold at `now` (epoch ms). Archived
 * documents never go stale. This is THE definition of "stale" — `brain audit`
 * reports it and `brain stats` counts it, so the two cannot drift.
 */
export function findStale(docs: AuditDoc[], taxonomy: Taxonomy, now: number): StaleDoc[] {
  const stale: StaleDoc[] = [];
  for (const doc of docs) {
    if (doc.status === "archived") continue;

    const updatedMs = new Date(doc.updated).getTime();
    const ageDays = Math.floor((now - updatedMs) / MS_PER_DAY);

    // Threshold + severity come from the taxonomy (longest matching prefix
    // rule, else the configured default).
    const { days: threshold, severity } = taxonomy.stalenessFor(doc.path);

    if (ageDays > threshold) stale.push({ doc, ageDays, threshold, severity });
  }
  return stale;
}

/**
 * The documents with no wiki-link in either direction and no plain-markdown
 * link pointing at them, minus orphan-exempt types and `_index.md` anchors.
 * Shared by `brain audit` and `brain stats` for the same reason as findStale.
 */
export function findOrphans(
  db: Database,
  docs: AuditDoc[],
  taxonomy: Taxonomy,
  opts: { linksAmongDocs?: boolean } = {}
): AuditDoc[] {
  // Exclude orphan-exempt types (index/context and any config-declared
  // exemptions) and _index.md files.
  const candidateDocs = docs.filter(
    (d) => !taxonomy.isOrphanExempt(d.type) && !d.path.endsWith("_index.md")
  );

  // Pre-compute plain-markdown incoming links so detail files referenced
  // via `[text](slug/)` from _index.md files are not flagged as orphans.
  const allPaths = new Set(docs.map((d) => d.path));
  const plainIncoming = new Set<string>();
  const linkRegex = /\]\(([^)]+)\)/g;

  for (const src of docs) {
    const srcDir = src.path.includes("/")
      ? src.path.slice(0, src.path.lastIndexOf("/"))
      : "";
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(src.content)) !== null) {
      let target = match[1].split("#")[0].split("?")[0].trim();
      if (
        !target ||
        target.startsWith("http") ||
        target.startsWith("mailto:") ||
        target.startsWith("[")
      )
        continue;

      const candidates: string[] = [];
      const join = (a: string, b: string) =>
        (a ? `${a}/${b}` : b).replace(/\/\.\//g, "/").replace(/^\.\//, "");

      if (target.endsWith("/")) {
        // A directory link resolves to one of the directory's anchor files —
        // taxonomy.dirAnchors names them (e.g. _index.md, status.md).
        const stripped = target.replace(/\/$/, "");
        for (const anchor of taxonomy.dirAnchors) {
          candidates.push(join(srcDir, `${stripped}/${anchor}`));
        }
      } else if (target.endsWith(".md")) {
        candidates.push(join(srcDir, target));
        candidates.push(target);
      }

      for (const c of candidates) {
        if (allPaths.has(c)) plainIncoming.add(c);
      }
    }
  }

  // Which documents have a wiki-link at all, in one pass each rather than two
  // COUNT(*) per candidate: `links` has no index on target_id, so the
  // per-document form scanned the whole table N times (9s at 10k docs / 50k
  // links). A document is linked iff its id appears, which is the same
  // question `COUNT(*) = 0` asked — a NULL target_id never matched `= ?`
  // either, so dropping the broken links here changes nothing.
  const ids = (sql: string) =>
    new Set((db.prepare(sql).all() as { id: number }[]).map((r) => r.id));
  let hasOutgoing: Set<number>;
  let hasIncoming: Set<number>;
  if (opts.linksAmongDocs) {
    // Only links between the given documents count: a link from a document
    // left out of `docs` makes nothing un-orphaned, and one to it is broken.
    const among = new Set(docs.map((d) => d.id));
    const rows = db.prepare("SELECT source_id, target_id FROM links").all() as { source_id: number; target_id: number | null }[];
    hasOutgoing = new Set();
    hasIncoming = new Set();
    for (const { source_id, target_id } of rows) {
      if (!among.has(source_id)) continue;
      hasOutgoing.add(source_id);
      if (target_id !== null && among.has(target_id)) hasIncoming.add(target_id);
    }
  } else {
    hasOutgoing = ids("SELECT DISTINCT source_id AS id FROM links");
    hasIncoming = ids("SELECT DISTINCT target_id AS id FROM links WHERE target_id IS NOT NULL");
  }

  const orphans: AuditDoc[] = [];
  for (const doc of candidateDocs) {
    if (!hasOutgoing.has(doc.id) && !hasIncoming.has(doc.id) && !plainIncoming.has(doc.path)) {
      orphans.push(doc);
    }
  }
  return orphans;
}

/** The calendar day at `now` (epoch ms), as the `YYYY-MM-DD` frontmatter dates use. */
export function isoDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The canonical document for `key`, when it is set, indexed and not archived. */
function canonicalDoc(docs: AuditDoc[], taxonomy: Taxonomy, key: string): AuditDoc | null {
  const path = taxonomy.canonicalPath(key);
  const doc = path ? docs.find((d) => d.path === path) : undefined;
  return doc && doc.status !== "archived" ? doc : null;
}

export interface BudgetOverrun {
  doc: AuditDoc;
  key: string;
  tokens: number;
  maxTokens: number;
}

/**
 * Canonical documents over their `canonicalPolicy` token budget, estimated
 * over the body the way `brain context` estimates what it loads.
 */
export function findBudgetOverruns(docs: AuditDoc[], taxonomy: Taxonomy): BudgetOverrun[] {
  const over: BudgetOverrun[] = [];
  for (const [key, { maxTokens }] of Object.entries(taxonomy.canonicalPolicy)) {
    if (maxTokens === undefined) continue;
    const doc = canonicalDoc(docs, taxonomy, key);
    if (!doc) continue;
    const tokens = estimateTokens(doc.content);
    if (tokens > maxTokens) over.push({ doc, key, tokens, maxTokens });
  }
  return over;
}

export interface OverdueReview {
  doc: AuditDoc;
  /** The day the review was due. */
  due: string;
  /** `next_review` from the frontmatter, or the canonical policy's `reviewDays`. */
  source: "next_review" | "reviewDays";
}

/**
 * Documents due for review before `now`: any non-archived document whose
 * `next_review` has passed, and any canonical document with a `reviewDays`
 * cadence whose `updated` is older than that and that sets no future
 * `next_review`. One entry per document.
 */
export function findOverdueReviews(docs: AuditDoc[], taxonomy: Taxonomy, now: number): OverdueReview[] {
  const today = isoDay(now);
  const overdue = new Map<string, OverdueReview>();
  for (const doc of docs) {
    if (doc.status === "archived" || !doc.next_review) continue;
    if (doc.next_review < today) overdue.set(doc.path, { doc, due: doc.next_review, source: "next_review" });
  }
  for (const [key, { reviewDays }] of Object.entries(taxonomy.canonicalPolicy)) {
    if (reviewDays === undefined) continue;
    const doc = canonicalDoc(docs, taxonomy, key);
    if (!doc || overdue.has(doc.path) || (doc.next_review && doc.next_review >= today)) continue;
    const updated = new Date(doc.updated).getTime();
    if (Number.isNaN(updated)) continue;
    // Compare whole days as numbers; only a due day that is past, and so
    // within the calendar, is ever formatted.
    const dueDay = Math.floor(updated / MS_PER_DAY) + reviewDays;
    if (dueDay < Math.floor(now / MS_PER_DAY)) {
      overdue.set(doc.path, { doc, due: isoDay(dueDay * MS_PER_DAY), source: "reviewDays" });
    }
  }
  return [...overdue.values()];
}

export interface PastDate {
  /** 1-based line number in `text`. */
  line: number;
  /** The earliest ISO date on the line. */
  date: string;
  text: string;
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/**
 * Lines of `text` naming a calendar date (`YYYY-MM-DD`) before `today`,
 * outside code: fenced and indented blocks and inline spans, wherever GFM
 * puts them (a fence in a blockquote or a list item is code too). Whether
 * the date is wrong is a judgement this does not make: a past date in a focus
 * document is usually a finished item or a missed deadline, and either way
 * worth a look.
 */
export function findPastDates(text: string, today: string): PastDate[] {
  const code = codeRanges(text);
  const inCode = (offset: number) => inRanges(code, offset);
  const found: PastDate[] = [];
  let lineStart = 0;
  text.split("\n").forEach((line, i) => {
    const dates = [...line.matchAll(ISO_DATE)]
      .filter((m) => !inCode(lineStart + m.index!))
      .filter(([, y, m, d]) => {
        const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(`${y}-${m}-${d}`);
      })
      .map((m) => m[0])
      .sort();
    if (dates.length > 0 && dates[0] < today) found.push({ line: i + 1, date: dates[0], text: line.trim() });
    lineStart += line.length + 1;
  });
  return found;
}

/** Lines in the file before the body starts, when the file on disk still ends with the indexed body. */
function bodyLineOffset(root: string | undefined, doc: AuditDoc): number | null {
  if (!root) return null;
  try {
    const file = readFileSync(join(root, doc.path), "utf8");
    if (!file.endsWith(doc.content)) return null;
    return file.slice(0, file.length - doc.content.length).split("\n").length - 1;
  } catch {
    return null;
  }
}

export interface FactDrift {
  doc: AuditDoc;
  key: string;
  found: string;
  canonical: string;
  source: string;
}

/** A frontmatter scalar as text: a YAML date back to `YYYY-MM-DD`, anything else trimmed. */
function factText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return null;
}

/** Equal after trimming; as numbers when both parse as numbers. */
function sameFact(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x !== "" && y !== "" && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) return Number(x) === Number(y);
  return x === y;
}

/**
 * A document's frontmatter, read from disk; {} when it cannot be read. A
 * missing file states nothing; any other failure (unreadable, invalid YAML)
 * also calls `onReadFailed`, since the check could not see its input. The
 * options object keeps gray-matter from caching a failed parse as a success
 * (#142).
 */
function frontmatterOf(root: string, path: string, onReadFailed: () => void): Record<string, unknown> {
  try {
    return matter(readFileSync(join(root, path), "utf8"), {}).data as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") onReadFailed();
    return {};
  }
}

/** A repo-relative path in the form the index stores: no `./`, no doubled or trailing separators. */
function normalizePath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * Restatements of a keyed fact that disagree with its canonical value.
 *
 * `taxonomy.facts` names, per key, the canonical document and the patterns
 * that find the value restated in prose. The value is the source's `facts:`
 * frontmatter entry. Every other non-archived markdown document is scanned,
 * and one that states another value is reported once per fact, with the first
 * value found. A capture that touches code (a fence or an inline span) is not
 * a restatement. A document lists the facts it states on purpose as they were
 * (a historical piece) under `facts_ignore:`.
 *
 * Frontmatter is not in the index, so it is read from the files: without
 * `root` there is nothing to compare against, and nothing is reported. The
 * work is lazy: code ranges are computed, and a document's frontmatter read,
 * only for a document with a disagreeing capture.
 */
export function findFactDrift(
  docs: AuditDoc[],
  taxonomy: Taxonomy,
  root: string | undefined,
  onReadFailed: () => void = () => {}
): FactDrift[] {
  const drift: FactDrift[] = [];
  const keys = Object.keys(taxonomy.facts);
  if (!root || keys.length === 0) return drift;

  const frontmatter = new Map<string, Record<string, unknown>>();
  const frontmatterFor = (path: string) => {
    let data = frontmatter.get(path);
    if (!data) frontmatter.set(path, (data = frontmatterOf(root, path, onReadFailed)));
    return data;
  };
  const ignoresOf = (doc: AuditDoc): Set<string> => {
    const raw = frontmatterFor(doc.path).facts_ignore;
    return new Set(Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : []);
  };
  const code = new Map<string, [number, number][]>();
  const codeOf = (doc: AuditDoc) => {
    let ranges = code.get(doc.path);
    if (!ranges) code.set(doc.path, (ranges = codeRanges(doc.content)));
    return ranges;
  };
  const touchesCode = (ranges: [number, number][], start: number, end: number) =>
    ranges.some(([s, e]) => start < e && end > s);

  for (const key of keys) {
    const rule = taxonomy.facts[key];
    const source = normalizePath(rule.source);
    const facts = frontmatterFor(source).facts;
    const canonical =
      facts && typeof facts === "object" && !Array.isArray(facts) ? factText((facts as Record<string, unknown>)[key]) : null;
    if (canonical === null) continue;
    // `d` gives each capture's offsets, so a capture reaching into code is seen.
    const patterns = rule.patterns.map((p) => new RegExp(p, "gid"));

    for (const doc of docs) {
      if (doc.path === source || doc.status === "archived") continue;
      let found: string | null = null;
      for (const pattern of patterns) {
        for (const match of doc.content.matchAll(pattern)) {
          const value = match[1];
          // An optional group that did not take part is no statement at all.
          if (value === undefined || sameFact(value, canonical)) continue;
          const [start, end] = match.indices![1]!;
          if (touchesCode(codeOf(doc), Math.min(start, match.index ?? start), end)) continue;
          found = value.trim();
          break;
        }
        if (found !== null) break;
      }
      if (found !== null && !ignoresOf(doc).has(key)) drift.push({ doc, key, found, canonical, source });
    }
  }
  return drift;
}

/** A paragraph shorter than this, after whitespace normalisation, is never counted as repeated. */
export const REPEATED_TEXT_MIN_CHARS = 200;
/** A paragraph found in at least this many documents is reported as repeated. */
export const REPEATED_TEXT_MIN_DOCS = 5;

export interface RepeatedText {
  /** The paragraph, whitespace collapsed. */
  text: string;
  /** The documents that carry it, in path order. */
  paths: string[];
}

/** Collapse whitespace, as the comparison does. */
const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A document body's candidate paragraphs, whitespace collapsed: runs of
 * non-blank lines, with an ATX heading line always a block of its own (and
 * never a candidate).
 */
function candidateParagraphs(content: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) blocks.push(normalizeText(lines.join(" ")));
    lines = [];
  };
  for (const line of content.split("\n")) {
    if (!line.trim() || /^ {0,3}#{1,6}(?:\s|$)/.test(line)) flush();
    else lines.push(line);
  }
  flush();
  return blocks;
}

/**
 * Paragraphs of at least REPEATED_TEXT_MIN_CHARS that at least
 * REPEATED_TEXT_MIN_DOCS documents carry, compared after whitespace
 * normalisation. Each copy is chunked, contextualised and embedded on its own,
 * and near-identical vectors crowd the candidate window of any query they
 * match.
 *
 * Candidates are found by blank lines, which is cheap and over-counts: a list,
 * a quote, a setext heading or indented code reads as a paragraph there. So a
 * document carrying a candidate that enough documents share is then parsed,
 * and counts only when one of its top-level paragraph blocks is the candidate.
 */
export function findRepeatedText(docs: AuditDoc[]): RepeatedText[] {
  const seen = new Map<string, Set<AuditDoc>>();
  for (const doc of docs) {
    for (const text of candidateParagraphs(doc.content)) {
      if (text.length < REPEATED_TEXT_MIN_CHARS) continue;
      let where = seen.get(text);
      if (!where) seen.set(text, (where = new Set()));
      where.add(doc);
    }
  }

  const paragraphs = new Map<AuditDoc, Set<string>>();
  const paragraphsIn = (doc: AuditDoc) => {
    let texts = paragraphs.get(doc);
    if (!texts) {
      texts = new Set(
        topLevelBlocks(doc.content)
          .filter((block) => block.type === "paragraph")
          .map((block) => normalizeText(doc.content.slice(block.start, block.end)))
      );
      paragraphs.set(doc, texts);
    }
    return texts;
  };

  const repeated: RepeatedText[] = [];
  for (const [text, where] of seen) {
    if (where.size < REPEATED_TEXT_MIN_DOCS) continue;
    const paths = [...where].filter((doc) => paragraphsIn(doc).has(text)).map((doc) => doc.path);
    if (paths.length >= REPEATED_TEXT_MIN_DOCS) repeated.push({ text, paths: paths.sort() });
  }
  return repeated.sort((a, b) => b.paths.length - a.paths.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

/**
 * Run all audit checks against the indexed database.
 *
 * Taxonomy supplies every path-shaped policy: staleness thresholds
 * (stalenessFor), the source→derivative propagation rules (propagation),
 * orphan exemptions (isOrphanExempt), the expected directory prefixes per type
 * (expectedPrefixesFor), and the directory-anchor names (dirAnchors). Nothing
 * about the document taxonomy is hardcoded here.
 */
export function audit(
  db: Database,
  taxonomy: Taxonomy,
  opts: AuditOptions = {}
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const now = (opts.now ?? new Date()).getTime();

  const exclude = opts.exclude;
  const docs = exclude ? loadAuditDocs(db).filter((d) => !exclude(d.path)) : loadAuditDocs(db);

  // ---------------------------------------------------------------
  // 1. Staleness checks
  // ---------------------------------------------------------------
  for (const { doc, ageDays, threshold, severity } of findStale(docs, taxonomy, now)) {
    issues.push({
      path: doc.path,
      severity,
      category: "staleness",
      message: `Last updated ${ageDays} days ago (threshold: ${threshold} days)`,
      suggestion: `Review and update ${doc.path}`,
    });
  }

  // ---------------------------------------------------------------
  // 2. Propagation checks — a derivative must not lag behind its source
  // ---------------------------------------------------------------
  // Each taxonomy propagation rule names a canonical source document and a glob
  // for the derivatives generated from it (e.g. bios generated from a canonical
  // FACTS.md must not lag behind it).
  const reported = new Set<string>();
  for (const rule of taxonomy.propagation) {
    const source = docs.find((d) => d.path === rule.source);
    if (!source) continue;
    const sourceUpdated = new Date(source.updated).getTime();
    const severity = rule.severity ?? "warning";
    const glob = new Glob(rule.derivatives);

    for (const doc of docs) {
      if (doc.path === rule.source || !glob.match(doc.path)) continue;
      const docUpdated = new Date(doc.updated).getTime();
      if (sourceUpdated > docUpdated) {
        reported.add(`${doc.path}\n${rule.source}`);
        issues.push({
          path: doc.path,
          severity,
          category: "propagation",
          message: `${rule.source} was updated more recently than this derivative (source: ${source.updated}, this: ${doc.updated})`,
          suggestion: `Regenerate ${doc.path} from ${rule.source}`,
        });
      }
    }
  }

  // A document's own `generated_from` (#430) is the same rule for one file:
  // when it names a markdown document in the corpus that was updated after
  // it, the derivative lags. A path that resolves to nothing, or a tool name,
  // has no `updated` to compare, so it is never reported.
  const byPath = new Map(docs.map((d) => [d.path, d]));
  for (const doc of docs) {
    if (!doc.generated_from) continue;
    // A repo-relative path, normalized (`notes/./a.md`, `notes/../notes/a.md`).
    // One that leaves the repo normalizes to `../…`, which no document has.
    const source = byPath.get(posix.normalize(doc.generated_from));
    if (!source || source.path === doc.path || reported.has(`${doc.path}\n${source.path}`)) continue;
    if (new Date(source.updated).getTime() > new Date(doc.updated).getTime()) {
      issues.push({
        path: doc.path,
        severity: "warning",
        category: "propagation",
        message: `${source.path} was updated more recently than this derivative (source: ${source.updated}, this: ${doc.updated})`,
        suggestion: `Regenerate ${doc.path} from ${source.path}`,
      });
    }
  }

  // ---------------------------------------------------------------
  // 2b. Index lag check — _index.md files older than their detail files
  // ---------------------------------------------------------------
  // Mechanical enforcement of the Index Sync Principle: an _index.md is a
  // summary layer over its directory subtree and must not lag behind it. An
  // index with a generated registry table is judged by that table instead
  // (2b'): its `updated` moves only when the table does, so lag says nothing.
  // Without a root there is nothing to plan (an audit of the index alone). A
  // root that is given but missing is a check that could not run.
  const rootMissing = !!opts.root && !existsSync(opts.root);
  if (rootMissing) opts.onCheckFailed?.("index-stale");
  const registry = opts.root && !rootMissing ? planRegistry(opts.root, taxonomy, isoDay(now)) : null;
  const generated = new Set([
    ...(registry?.indexes.map((i) => i.path) ?? []),
    ...(registry?.problems.map((p) => p.path) ?? []),
  ]);
  const indexDocs = docs.filter((d) => d.path.endsWith("_index.md") && !generated.has(d.path));
  for (const indexDoc of indexDocs) {
    const dirPrefix = indexDoc.path.slice(0, -"_index.md".length);
    const indexUpdated = new Date(indexDoc.updated).getTime();

    let newestDetail: { path: string; updated: string } | null = null;
    for (const doc of docs) {
      if (doc.path === indexDoc.path || !doc.path.startsWith(dirPrefix)) continue;
      // Nested _index.md files own their subtree — don't blame the parent
      if (doc.path.endsWith("_index.md")) continue;
      if (doc.status === "archived") continue;
      if (!newestDetail || doc.updated > newestDetail.updated) {
        newestDetail = { path: doc.path, updated: doc.updated };
      }
    }

    if (newestDetail) {
      const detailUpdated = new Date(newestDetail.updated).getTime();
      const lagDays = Math.floor((detailUpdated - indexUpdated) / MS_PER_DAY);
      if (lagDays > 7) {
        issues.push({
          path: indexDoc.path,
          severity: "warning",
          category: "index-lag",
          message: `Index lags ${lagDays} days behind ${newestDetail.path} (index: ${indexDoc.updated}, detail: ${newestDetail.updated})`,
          suggestion: `Review ${indexDoc.path} and sync it with its detail files`,
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // 2b'. Stale registry tables — a generated table that no longer matches
  // ---------------------------------------------------------------
  for (const index of registry?.indexes ?? []) {
    if (index.next === null) continue;
    issues.push({
      path: index.path,
      severity: "warning",
      category: "index-stale",
      message: "The registry table no longer matches its children's frontmatter",
      suggestion: "Run `brain registry` to regenerate it",
    });
  }
  for (const { path, error } of registry?.problems ?? []) {
    issues.push({
      path,
      severity: "warning",
      category: "index-stale",
      message: `The registry: block is invalid, so the table cannot be generated (${error})`,
      suggestion: `Fix the registry: frontmatter of ${path}`,
    });
  }

  // ---------------------------------------------------------------
  // 2c. Stale drafts — draft status is a working state, not a parking lot
  // ---------------------------------------------------------------
  const DRAFT_MAX_AGE_DAYS = 90;
  for (const doc of docs) {
    if (doc.status !== "draft") continue;
    const ageDays = Math.floor((now - new Date(doc.updated).getTime()) / MS_PER_DAY);
    if (ageDays > DRAFT_MAX_AGE_DAYS) {
      issues.push({
        path: doc.path,
        severity: "info",
        category: "stale-draft",
        message: `Draft for ${ageDays} days (threshold: ${DRAFT_MAX_AGE_DAYS})`,
        suggestion: "Finish it, set status: active, or archive it",
      });
    }
  }

  // ---------------------------------------------------------------
  // 2d. Tag vocabulary noise — one aggregate issue, not one per tag
  // ---------------------------------------------------------------
  try {
    // Without `exclude`, every tagged document counts, as it always has.
    const counted = exclude ? new Set(docs.map((d) => d.id)) : null;
    const tagUses = db
      .prepare(
        `SELECT t.id, t.name, dt.document_id AS doc
         FROM tags t JOIN document_tags dt ON dt.tag_id = t.id`
      )
      .all() as { id: number; name: string; doc: number }[];
    const byTag = new Map<number, { name: string; n: number }>();
    for (const use of tagUses) {
      if (counted && !counted.has(use.doc)) continue;
      const row = byTag.get(use.id) ?? { name: use.name, n: 0 };
      row.n++;
      byTag.set(use.id, row);
    }
    const tagRows = [...byTag.values()];
    const singletons = tagRows.filter((r) => r.n === 1);
    if (tagRows.length > 0 && singletons.length / tagRows.length > 0.4) {
      const sample = singletons.slice(0, 8).map((r) => r.name).join(", ");
      issues.push({
        path: "(corpus)",
        severity: "info",
        category: "tag-noise",
        message: `${singletons.length} of ${tagRows.length} tags are used by exactly one document (e.g. ${sample})`,
        suggestion: "Singleton tags filter nothing — merge into broader tags or drop during routine edits",
      });
    }
  } catch {
    // The tag tables could not be read.
    opts.onCheckFailed?.("tag-noise");
  }

  // ---------------------------------------------------------------
  // 2e. Repeated text — one paragraph copied into many documents
  // ---------------------------------------------------------------
  for (const { text, paths } of findRepeatedText(docs)) {
    const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ", …" : "");
    issues.push({
      path: "(corpus)",
      severity: "info",
      category: "repeated-text",
      message: `A paragraph appears in ${paths.length} documents (${shown}): "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`,
      suggestion: "Keep the text in one document and link to it from the others; each copy is embedded on its own",
    });
  }

  // ---------------------------------------------------------------
  // 3. TODO / VERIFY marker detection
  // ---------------------------------------------------------------
  const todoRegex = /\[TODO:[^\]]*\]/g;
  const verifyRegex = /\[VERIFY:[^\]]*\]/g;

  for (const doc of docs) {
    const todoMatches = doc.content.match(todoRegex);
    if (todoMatches) {
      for (const match of todoMatches) {
        issues.push({
          path: doc.path,
          severity: "info",
          category: "todo",
          message: `Contains marker: ${match}`,
        });
      }
    }

    const verifyMatches = doc.content.match(verifyRegex);
    if (verifyMatches) {
      for (const match of verifyMatches) {
        issues.push({
          path: doc.path,
          severity: "warning",
          category: "verify",
          message: `Contains unverified content: ${match}`,
          suggestion: "Verify this information and remove the marker",
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // 4. Type / directory mismatch
  // ---------------------------------------------------------------
  for (const doc of docs) {
    const expectedDirs = taxonomy.expectedPrefixesFor(doc.type);
    if (!expectedDirs) continue; // dir: null (e.g. index) or unknown — skip

    const matchesExpected = expectedDirs.some((dir) => doc.path.startsWith(dir));
    if (!matchesExpected) {
      issues.push({
        path: doc.path,
        severity: "warning",
        category: "type-mismatch",
        message: `Document type "${doc.type}" expected in ${expectedDirs.join(" or ")}, found at ${doc.path}`,
        suggestion: `Move to ${expectedDirs[0]} or change type`,
      });
    }
  }

  // ---------------------------------------------------------------
  // 5. Orphan detection
  // ---------------------------------------------------------------
  for (const doc of findOrphans(db, docs, taxonomy, { linksAmongDocs: exclude !== undefined })) {
    issues.push({
      path: doc.path,
      severity: "info",
      category: "orphan",
      message: "Document has no incoming or outgoing wiki-links",
      suggestion: "Add [[wiki-links]] to connect this document to others",
    });
  }

  // ---------------------------------------------------------------
  // 6. Canonical budgets — the always-read documents stay short
  // ---------------------------------------------------------------
  for (const { doc, key, tokens, maxTokens } of findBudgetOverruns(docs, taxonomy)) {
    issues.push({
      path: doc.path,
      severity: "warning",
      category: "budget",
      message: `~${tokens} tokens, over the ${maxTokens}-token budget for canonical "${key}"`,
      suggestion: `Move finished or reference material out of ${doc.path}, or raise taxonomy.canonicalPolicy.${key}.maxTokens`,
    });
  }

  // ---------------------------------------------------------------
  // 7. Overdue reviews — next_review passed, or a canonical cadence lapsed
  // ---------------------------------------------------------------
  for (const { doc, due, source } of findOverdueReviews(docs, taxonomy, now)) {
    issues.push({
      path: doc.path,
      severity: "warning",
      category: "review-overdue",
      message:
        source === "next_review"
          ? `next_review ${due} has passed`
          : `Review was due ${due} (reviewDays cadence; last updated ${doc.updated})`,
      suggestion: `Review ${doc.path}, then update it or move next_review forward`,
    });
  }

  // ---------------------------------------------------------------
  // 8. Past dates — in the canonical documents that carry a policy
  // ---------------------------------------------------------------
  const today = isoDay(now);
  for (const key of Object.keys(taxonomy.canonicalPolicy)) {
    const doc = canonicalDoc(docs, taxonomy, key);
    if (!doc) continue;
    const offset = bodyLineOffset(opts.root, doc);
    for (const { line, date, text } of findPastDates(doc.content, today)) {
      const where = offset === null ? `Body line ${line}` : `Line ${line + offset}`;
      issues.push({
        path: doc.path,
        severity: "warning",
        category: "past-date",
        message: `${where} names ${date}, before today (${today}): ${text}`,
        suggestion: "Finish, reschedule or remove the item if that date has passed",
      });
    }
  }

  // ---------------------------------------------------------------
  // 9. Fact drift — a keyed fact restated with another value
  // ---------------------------------------------------------------
  let factsUnread = false;
  const drift = findFactDrift(docs, taxonomy, opts.root, () => (factsUnread = true));
  // Drift it could not look for is not drift that went away.
  if (factsUnread) opts.onCheckFailed?.("fact-drift");
  for (const { doc, key, found, canonical, source } of drift) {
    issues.push({
      path: doc.path,
      severity: "warning",
      category: "fact-drift",
      message: `${key}: found ${found === "" ? '""' : found}, canonical ${canonical}`,
      suggestion: `Update it to match ${source}, or add ${key} to facts_ignore if it is right as a record of the past`,
    });
  }

  return issues;
}

/**
 * The core audit plus every enabled module's hygiene checks, each run against
 * its own module's config. A check that throws becomes one `module-hygiene`
 * warning instead of failing the audit, and `opts.onCheckFailed` hears of
 * it. `brain audit` and `brain maintain` both count issues through this, so
 * their numbers agree. The brain's root reaches the core audit
 * (`AuditOptions.root`) unless `opts` sets another. A check sees the whole
 * index, so `opts.exclude` drops its findings on excluded paths.
 */
export async function auditWithModules(
  db: Database,
  brain: { taxonomy: Taxonomy; root: string; modules: LoadedModule[] },
  opts: AuditOptions = {}
): Promise<AuditIssue[]> {
  const issues = audit(db, brain.taxonomy, { root: brain.root, ...opts });
  for (const mod of brain.modules) {
    for (const check of mod.manifest.hygieneChecks ?? []) {
      try {
        const found = await check({ db, root: brain.root, config: mod.config });
        issues.push(...(opts.exclude ? found.filter((issue) => !opts.exclude!(issue.path)) : found));
      } catch (e) {
        opts.onCheckFailed?.(mod.manifest.name);
        issues.push({
          path: "(module)",
          severity: "warning",
          category: "module-hygiene",
          message: `hygiene check from module "${mod.manifest.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  return issues;
}
