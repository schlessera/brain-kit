/**
 * The content-hygiene log, reconciled by the CLI (`brain hygiene`).
 *
 * The content-hygiene skill used to carry this logic as prose an agent had to
 * reproduce on every run: the stable issue IDs, the open/snoozed/resolved
 * state machine, the table diff behind index-lag, and the write policy that
 * keeps a no-op run free of diffs. It lives here now, so it is the same on
 * every run and has tests. The skill keeps the judgment passes (canonical
 * conflicts, which auto-fixes to apply) and hands its findings in as
 * `--extra` candidates.
 *
 * The log is markdown under `context/hygiene/`, laid out by the skill's
 * templates, and people edit it by hand: they move entries between files and
 * add `until:` dates. Matching is by ID, so those moves stand.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "fs";
import { parseFrontmatter } from "./frontmatter-parse.js";
import { basename, dirname, join, posix, resolve } from "path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { auditWithModules, isoDay, loadAuditDocs, type AuditDoc } from "./auditor.js";
import { topLevelBlocks } from "./document-parts.js";
import { editFrontmatter } from "./frontmatter-edit.js";
import { generatedRegionSpan } from "./generated-regions.js";
import { planRegistry, REGISTRY_REGION } from "./index-registry.js";
import { createWikiLinkResolver, extractWikiLinks } from "./indexer/links.js";
import type { LoadedModule } from "./module-types.js";
import { writeExclusive } from "./safe-path.js";
import type { Taxonomy } from "./taxonomy.js";
import type { AuditIssue } from "./types.js";

export const HYGIENE_DIR = "context/hygiene";
const TEMPLATES_DIR = resolve(import.meta.dir, "../../skills/content-hygiene/templates");

export type HygieneState = "open" | "snoozed" | "resolved";

/** A detected issue, before it is matched against the log. */
export interface HygieneCandidate {
  category: string;
  path: string;
  /** The smallest stable piece of evidence; it goes into the ID. */
  evidence: string;
  message: string;
}

/** An entry of the log: its `### id` heading and the lines under it. */
export interface HygieneEntry {
  id: string;
  state: HygieneState;
  lines: string[];
  /** The `## ` heading the entry sat under, or null. */
  section: string | null;
}

export interface ReconcileResult {
  opened: number;
  reopened: number;
  resolved: number;
  stillOpen: number;
  snoozed: number;
  /** Hygiene files written (or, with dryRun, that would be). */
  changedFiles: string[];
  /** Every issue detected this run, with its ID, for the skill's auto-fix decisions. */
  detected: Array<{ id: string; category: string; path: string; message: string }>;
  /** Auto-fixes the skill reported (`--fixed`), recorded in last-run.md. */
  autoFixed: number;
  /** Checks that could not run: a module whose hygiene check threw, or a core check that could not read its input. */
  failedChecks: string[];
}

// ---------------------------------------------------------------------------
// Stable IDs
// ---------------------------------------------------------------------------

/**
 * The last two segments of `path`, extension dropped, as a slug: `/` and `.`
 * become `-`, everything lowercase, and any other character outside
 * `[a-z0-9_-]` becomes `-`, with runs collapsed and the ends trimmed.
 */
export function shortPath(path: string): string {
  const segments = path.split("/").filter(Boolean).slice(-2);
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last].replace(/\.[^./]*$/, "");
  return segments
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** `{category}-{shortpath}-{hash4}`, hash4 the first four hex digits of SHA-1 over `{category}|{path}|{evidence}`. */
export function hygieneId(category: string, path: string, evidence: string): string {
  const hash = createHash("sha1").update(`${category}|${path}|${evidence}`).digest("hex").slice(0, 4);
  return `${category}-${shortPath(path)}-${hash}`;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * An audit issue as a candidate. Every core category has an evidence rule
 * that leaves out what changes while the issue stays the same (ages, counts,
 * today's date, line numbers), so the ID holds from one run to the next. A
 * module's categories use the whole message, which is stable while the
 * document is.
 */
export function candidateFromAudit(issue: AuditIssue, docs: Map<string, AuditDoc>): HygieneCandidate {
  const base = { category: issue.category, path: issue.path, message: issue.message };
  const from = (pattern: RegExp) => pattern.exec(issue.message)?.slice(1).join("") ?? issue.message;
  switch (issue.category) {
    case "staleness":
      // The type whose staleness threshold applies.
      return { ...base, evidence: docs.get(issue.path)?.type ?? "" };
    case "propagation":
    case "orphan":
    case "index-lag":
    case "stale-draft":
      return { ...base, evidence: issue.path };
    case "review-overdue":
    case "tag-noise":
    case "todo":
    case "verify":
      // One per document (review-overdue; todo and verify, which group a
      // document's markers, so adding one keeps the ID) or per corpus (tag-noise).
      return { ...base, evidence: "" };
    case "broken-link":
      // The target as written; the ambiguity count in the message can change.
      return { ...base, evidence: issue.target ?? from(/\[\[([\s\S]*?)\]\]/) };
    case "type-mismatch":
      return { ...base, evidence: from(/^Document type "([^"]*)"/) };
    case "budget":
      return { ...base, evidence: from(/canonical "([^"]*)"/) };
    case "past-date":
      // The date and the line's text, not its number or today.
      return { ...base, evidence: from(/names (\d{4}-\d{2}-\d{2}), before today \([^)]*\)(: [\s\S]*)$/) };
    case "fact-drift":
      // `{key}={found}`: the same wrong value keeps its ID, another one gets a new one.
      return { ...base, evidence: /^([^:]*): found ([\s\S]*), canonical [\s\S]*$/.exec(issue.message)?.slice(1).join("=") ?? issue.message };
    case "repeated-text":
      // The paragraph, not how many documents carry it.
      return { ...base, evidence: from(/: "([\s\S]*)"$/) };
    case "module-hygiene":
      return { ...base, evidence: from(/module "([^"]*)"/) };
    default:
      return { ...base, evidence: issue.message };
  }
}

const MS_PER_DAY = 86_400_000;
/** Silent edits count once the file is this many days newer than its `updated`. */
const SILENT_EDIT_DAYS = 7;

/**
 * Silently edited files: the same query `brain briefing` runs, without its
 * row limit, kept when the file is more than SILENT_EDIT_DAYS newer than its
 * frontmatter `updated`.
 */
export function silentEdits(db: Database): HygieneCandidate[] {
  const rows = db
    .prepare(
      `SELECT file_mtime, updated, path FROM documents
       WHERE file_mtime > updated
         AND (accepted_mtime IS NULL OR file_mtime > accepted_mtime)
         AND status != 'archived'
       ORDER BY path`
    )
    .all() as { file_mtime: string; updated: string; path: string }[];
  const out: HygieneCandidate[] = [];
  for (const row of rows) {
    const drift = Math.floor((Date.parse(row.file_mtime) - Date.parse(row.updated)) / MS_PER_DAY);
    if (!(drift > SILENT_EDIT_DAYS)) continue;
    out.push({
      category: "silent-edit",
      path: row.path,
      evidence: row.path,
      message: `File changed ${row.file_mtime}, frontmatter updated ${row.updated} (${drift} days apart)`,
    });
  }
  return out;
}

/*
 * The slice of mdast the table pass reads, typed structurally (see
 * document-parts.ts for why not through `@types/mdast`).
 */
interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

const markdown = unified().use(remarkParse).use(remarkGfm);

/**
 * Every GFM table in `content`, as rows of trimmed raw cell source. GFM
 * splits wiki-link display pipes too, so mask them in the parser copy with
 * a single code unit. Offsets still address the original, unmodified text.
 */
function tables(content: string): string[][][] {
  const source = content.replace(/\[\[[^\]\n]*\]\]/g, (link) => link.replace(/(?<!\\)\|/g, "\uFF5C"));
  const cellText = (cell: MdNode) => {
    const kids = cell.children ?? [];
    const start = kids[0]?.position?.start.offset;
    const end = kids[kids.length - 1]?.position?.end.offset;
    if (start === undefined || end === undefined) return "";
    return content.slice(start, end).trim();
  };
  const out: string[][][] = [];
  const walk = (node: MdNode) => {
    if (node.type === "table") {
      out.push((node.children ?? []).map((row) => (row.children ?? []).map(cellText)));
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(markdown.parse(source) as MdNode);
  return out;
}

/** Plain text of a cell for header matching: markup, links and case gone. */
function plain(cell: string): string {
  return cell
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim()
    .toLowerCase();
}

/** The first `YYYY-MM-DD` in a cell. */
function dayIn(cell: string): string | null {
  return /\d{4}-\d{2}-\d{2}/.exec(cell)?.[0] ?? null;
}

/** Indexed targets from the full corpus, including null for unresolved/ambiguous links. */
type ResolvedWikiLinks = ReadonlyMap<string, ReadonlyMap<string, string | null>>;

/** Reuse the indexer's wiki-link/alias result, built with the configured directory anchors. */
function indexedWikiLinks(db: Database): ResolvedWikiLinks {
  const links = new Map<string, Map<string, string | null>>();
  const rows = db.query(`SELECT source.path AS sourcePath, l.target, target.path AS targetPath
    FROM links l JOIN documents source ON source.id = l.source_id
    LEFT JOIN documents target ON target.id = l.target_id`).all() as
    { sourcePath: string; target: string; targetPath: string | null }[];
  for (const row of rows) {
    const targets = links.get(row.sourcePath) ?? new Map<string, string | null>();
    targets.set(row.target, row.targetPath);
    links.set(row.sourcePath, targets);
  }
  return links;
}

/**
 * The first markdown or wiki-link a row names. Markdown links retain their
 * index-directory semantics; wiki-links use the index document as source.
 */
function linkedDetail(
  row: string[], indexDir: string, indexPath: string, byPath: Map<string, AuditDoc>,
  resolveWiki: (target: string, sourcePath: string) => string | null
): AuditDoc | null {
  for (const rawCell of row) {
    const cell = rawCell.replace(/\\\|/g, "|");
    const md = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(cell)?.[1];
    if (md && !/^[a-z]+:/i.test(md) && !md.startsWith("#")) {
      let href = md.split("#")[0];
      try {
        href = decodeURI(href);
      } catch {
        // A malformed escape: use the link as written.
      }
      const target = posix.normalize(posix.join(indexDir, href));
      const candidates = md.endsWith("/")
        ? [posix.join(target, "status.md"), posix.join(target, "_index.md")]
        : [target, `${target}.md`, posix.join(target, "status.md"), posix.join(target, "_index.md")];
      for (const c of candidates) {
        const doc = byPath.get(c.replace(/^\.\//, ""));
        if (doc) return doc;
      }
      return null;
    }
    const wiki = extractWikiLinks(rawCell)[0];
    if (wiki) {
      const target = resolveWiki(wiki, indexPath);
      return target ? byPath.get(target) ?? null : null;
    }
  }
  return null;
}

/**
 * Index-vs-detail lag, row by row: for every index document's table with an
 * Updated column, each row whose linked detail document is newer than the
 * row's Updated date. Rows whose detail is missing are skipped (orphan and
 * structure checks cover them). The evidence is the row's first cell.
 */
export function indexTableLag(
  docs: AuditDoc[], registryIndexes: ReadonlySet<string> = new Set(), resolvedLinks?: ResolvedWikiLinks
): HygieneCandidate[] {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  // Corpus-only callers share basename/path resolution. Production supplies
  // the indexer's complete result, including real aliases and custom anchors.
  // Never retry a missing/null indexed target against the filtered doc set:
  // excluding the hygiene log from detection must not resolve an ambiguity.
  const resolveWiki = resolvedLinks
    ? (target: string, sourcePath: string) => resolvedLinks.get(sourcePath)?.get(target) ?? null
    : createWikiLinkResolver(new Map(docs.map((d) => [d.path, d.title])));
  const out: HygieneCandidate[] = [];
  for (const index of docs) {
    if (index.type !== "index" && !index.path.endsWith("_index.md")) continue;
    if (index.status === "archived") continue;
    const indexDir = posix.dirname(index.path);
    for (const [headerRow, ...rows] of tables(outsideRegistry(index, registryIndexes))) {
      const header = (headerRow ?? []).map(plain);
      const updatedCol = header.findIndex((h) => h.includes("updated"));
      const statusCol = header.findIndex((h) => h.includes("status"));
      if (updatedCol === -1) continue;
      for (const rawRow of rows) {
        // Preserve displayed evidence/IDs while resolving wiki targets as indexed.
        const row = rawRow.map((cell) => cell.replace(/\\\|/g, "|"));
        const rowUpdated = dayIn(row[updatedCol] ?? "");
        const detail = linkedDetail(rawRow, indexDir === "." ? "" : indexDir, index.path, byPath, resolveWiki);
        if (!detail || !rowUpdated || !(detail.updated > rowUpdated)) continue;
        const first = plain(row[0] ?? "") || row[0] || "";
        const rowStatus = statusCol === -1 ? null : (row[statusCol] ?? "").trim();
        out.push({
          category: "index-lag",
          path: index.path,
          evidence: row[0] ?? "",
          message:
            `Row "${first}" says updated ${rowUpdated}` +
            (rowStatus !== null ? `, status ${rowStatus || "(empty)"}` : "") +
            `; ${detail.path} has updated ${detail.updated}, status ${detail.status}`,
        });
      }
    }
  }
  return out;
}

/** What the CLI detected, and which module checks did not run. */
export interface Detection {
  candidates: HygieneCandidate[];
  /** Checks that could not run: module names, and core categories (`fact-drift`, `tag-noise`). */
  failedChecks: string[];
}

/**
 * An index's body without its generated registry region, when the index opts
 * in (`registry:`): that table is `brain registry`'s, audit reports it as
 * index-stale, and a hand fix would be overwritten. Tables outside the region,
 * and any index that does not opt in, are diffed as written. Malformed markers
 * leave the body whole; `brain registry` reports those.
 */
function outsideRegistry(index: AuditDoc, registryIndexes: ReadonlySet<string>): string {
  if (!registryIndexes.has(index.path)) return index.content;
  try {
    const span = generatedRegionSpan(index.content, REGISTRY_REGION);
    return span ? index.content.slice(0, span[0]) + index.content.slice(span[1]) : index.content;
  } catch {
    return index.content;
  }
}

/** Every candidate the CLI detects, the log's own files left out, and the module checks that failed. */
export async function detectCandidates(
  db: Database,
  brain: { taxonomy: Taxonomy; root: string; modules: LoadedModule[] },
  now: Date
): Promise<Detection> {
  const inLog = (path: string) => path.startsWith(`${HYGIENE_DIR}/`);
  const docs = loadAuditDocs(db).filter((d) => !inLog(d.path));
  const byPath = new Map(docs.map((d) => [d.path, d]));
  // The indexes that opt in to a generated registry table; none when the
  // brain's root cannot be scanned (audit reports that check as failed).
  const registryIndexes = new Set(
    existsSync(brain.root) ? planRegistry(brain.root, brain.taxonomy, isoDay(now.getTime())).indexes.map((i) => i.path) : []
  );
  const table = indexTableLag(docs, registryIndexes, indexedWikiLinks(db));
  // A row-level finding is more specific than audit's whole-file index-lag.
  const tableIndexes = new Set(table.map((c) => c.path));
  const failed = new Set<string>();
  // The log is left out of detection, so writing it cannot change the next run.
  const audited = (await auditWithModules(db, brain, { now, exclude: inLog, onCheckFailed: (name) => failed.add(name) }))
    .filter((issue) => !(issue.category === "index-lag" && tableIndexes.has(issue.path)))
    .map((issue) => candidateFromAudit(issue, byPath));
  return {
    candidates: [...audited, ...silentEdits(db).filter((c) => !inLog(c.path)), ...table],
    failedChecks: [...failed].sort(),
  };
}

// ---------------------------------------------------------------------------
// The log's files
// ---------------------------------------------------------------------------

/** A log file `brain hygiene` will not rewrite, or one that changed under it. */
export class HygieneLogError extends Error {}

/** An entry heading: `### ` and one token ending in the ID's `-hash4`. */
const ENTRY_HEADING = /^### +(\S+-[0-9a-f]{4})[ \t]*\r?$/;
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** A `## ` section of a log file, or (heading null) the text before the first one. */
interface Segment {
  heading: string | null;
  /** The segment's source, heading included. */
  text: string;
  /** The text between the heading and the first entry (all of it when there is none). */
  intro: string;
  entries: HygieneEntry[];
  /** Rebuilt by the tool; everything else is kept byte for byte. */
  owned: boolean;
}

interface LogFile {
  /** The frontmatter block with its fences, or "" when the file has none. */
  frontmatter: string;
  body: string;
  segments: Segment[];
  entries: HygieneEntry[];
}

/**
 * The frontmatter and body of a log file. A file that opens a frontmatter
 * block it does not close, or whose block is not a YAML mapping, is refused:
 * rewriting it would mean guessing where the frontmatter ends.
 */
function splitFrontmatter(text: string, rel: string): { frontmatter: string; body: string } {
  if (!/^---[ \t]*\r?\n/.test(text)) return { frontmatter: "", body: text };
  const frontmatter = FRONTMATTER.exec(text)?.[0];
  if (!frontmatter) throw new HygieneLogError(`${rel}: the frontmatter is never closed with ---; fix it by hand, brain hygiene will not rewrite it`);
  let data: unknown;
  try {
    data = parseFrontmatter(frontmatter).data;
  } catch (e) {
    throw new HygieneLogError(`${rel}: the frontmatter is not valid YAML (${(e as Error).message.split("\n")[0]}); fix it by hand, brain hygiene will not rewrite it`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HygieneLogError(`${rel}: the frontmatter is not a YAML mapping; fix it by hand, brain hygiene will not rewrite it`);
  }
  return { frontmatter, body: text.slice(frontmatter.length) };
}

/** A heading block's text: its first line without the `#` markers. */
function headingText(line: string): string {
  return line.replace(/^ {0,3}#{1,6}[ \t]*/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
}

/**
 * Split a log file into its `## ` sections, as GFM parses them (a heading in a
 * code block is not one). With `state`, each section's `### id` entries are
 * read: an entry runs to the next entry or section heading, and keeps
 * whatever a person wrote under it. A section is owned, and rebuilt on
 * write, when `owns` accepts its heading or it holds entries; any other
 * section is kept as written. A section with an unknown heading that holds
 * both entries and other text is refused, since rebuilding it would lose one
 * or the other.
 */
function parseLogFile(text: string, rel: string, state: HygieneState | null, owns: (heading: string) => boolean): LogFile {
  const { frontmatter, body } = splitFrontmatter(text, rel);
  const lineEnd = (start: number) => {
    const nl = body.indexOf("\n", start);
    return nl === -1 ? body.length : nl;
  };
  const headings = topLevelBlocks(body).filter((b) => b.type === "heading");
  const sections = headings.filter((h) => (h.depth ?? 1) <= 2);
  const entryStarts = state === null ? [] : headings.filter((h) => h.depth === 3 && ENTRY_HEADING.test(body.slice(h.start, lineEnd(h.start)))).map((h) => h.start);

  const bounds = [...new Set([0, ...sections.map((h) => h.start)])].sort((a, b) => a - b);
  const segments: Segment[] = [];
  bounds.forEach((start, i) => {
    const end = bounds[i + 1] ?? body.length;
    const head = sections.find((h) => h.start === start);
    const heading = head ? headingText(body.slice(start, lineEnd(start))) : null;
    const contentStart = head ? Math.min(end, lineEnd(head.end > start ? head.end - 1 : start) + 1) : start;
    const starts = entryStarts.filter((s) => s >= contentStart && s < end);
    const entries = starts.map((s, j): HygieneEntry => {
      const lines = body.slice(Math.min(lineEnd(s) + 1, end), starts[j + 1] ?? end).split("\n");
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      return { id: ENTRY_HEADING.exec(body.slice(s, lineEnd(s)))![1], state: state!, lines, section: heading };
    });
    const intro = body.slice(contentStart, starts[0] ?? end);
    const owned = heading !== null && (owns(heading) || entries.length > 0);
    if (heading !== null && !owns(heading) && entries.length > 0 && intro.trim() !== "") {
      throw new HygieneLogError(
        `${rel}: the section "## ${heading}" holds entries and other text; move the text to its own section or the entries under a log heading`
      );
    }
    segments.push({ heading, text: body.slice(start, end), intro, entries, owned });
  });
  return { frontmatter, body, segments, entries: segments.flatMap((s) => s.entries) };
}

/**
 * The body with the owned sections replaced by `block`, placed where the
 * first of them was (at the end when there is none). Every other byte stays.
 */
function renderLogFile(file: LogFile, block: string): string {
  const pieces: Array<string | null> = [];
  let placed = false;
  for (const segment of file.segments) {
    if (!segment.owned && segment.entries.length === 0) {
      pieces.push(segment.text);
      continue;
    }
    // Entries before any heading: the text above them stays.
    if (segment.heading === null) pieces.push(segment.intro);
    if (!placed) pieces.push(null);
    placed = true;
  }
  let out = "";
  pieces.forEach((piece, i) => {
    if (piece !== null) out += piece;
    else if (block) out += pieces.slice(i + 1).some((p) => p) ? `${block}\n` : block;
  });
  // No owned section yet: the block goes after a blank line, and not a byte before it changes.
  if (!placed && block) out += `${out === "" || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  return out;
}

/** A `key: value` field of an entry, however it is bolded or backticked. */
function field(entry: HygieneEntry, key: string): string | null {
  const pattern = new RegExp(`^[-*\\s]*\\**${key}\\**\\s*:\\**\\s*\`?([^\`]+?)\`?\\s*$`, "i");
  for (const line of entry.lines) {
    const m = pattern.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function day(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** Drop the lines carrying any of `keys`. */
function withoutFields(lines: string[], keys: string[]): string[] {
  const pattern = new RegExp(`^[-*\\s]*\\**(?:${keys.join("|")})\\**\\s*:`, "i");
  return lines.filter((line) => !pattern.test(line));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** open.md's sections, in the template's order. */
const SECTIONS: Array<[string, string]> = [
  ["conflict", "Conflicts"],
  ["index-lag", "Index lag"],
  ["staleness", "Staleness"],
  ["propagation", "Derivation drift"],
  ["silent-edit", "Silent edits"],
  ["todo", "TODO markers"],
  ["verify", "VERIFY markers"],
  ["broken-link", "Broken links"],
  ["orphan", "Orphans"],
  ["type-mismatch", "Type/directory mismatches"],
];
const SECTION_HEADINGS = new Set(SECTIONS.map(([, heading]) => heading));
const isOpenSection = (heading: string) => SECTION_HEADINGS.has(heading) || heading.startsWith("Other: ");
const sectionFor = (category: string) => SECTIONS.find(([c]) => c === category)?.[1] ?? `Other: ${category}`;

/** The generated lines of an open entry, fresh from its detection. */
function detectionLines(candidate: HygieneCandidate, updated: string | undefined, firstSeen: string, lastSeen: string): string[] {
  return [
    `- **Files**: \`${candidate.path}\`${updated ? ` (updated ${updated})` : ""}`,
    `- **Issue**: ${candidate.message.replace(/\s+/g, " ").trim()}`,
    `- **First seen**: ${firstSeen} · **Last seen**: ${lastSeen}`,
  ];
}

/** Replace the generated lines, keep anything a person wrote under the entry. */
function refreshLines(lines: string[], fresh: string[]): string[] {
  const kept = lines.filter((line) => !/^- \*\*(Files|Issue|First seen)\*\*:/.test(line));
  while (kept.length > 0 && kept[0].trim() === "") kept.shift();
  return [...fresh, ...kept];
}

function renderEntries(entries: HygieneEntry[]): string {
  return entries.map((e) => [`### ${e.id}`, ...e.lines].join("\n")).join("\n\n");
}

/** A section's intro as kept: trimmed, the template's "(empty)" placeholder dropped. */
function introOf(file: LogFile, heading: string): string {
  const intro = file.segments.find((s) => s.heading === heading)?.intro.trim() ?? "";
  return intro === "(empty)" ? "" : intro;
}

/** open.md's owned block: one section per category that has entries or an intro, in the template's order. */
function openBlock(file: LogFile, entries: HygieneEntry[], headingOf: (entry: HygieneEntry) => string): string {
  const bySection = new Map<string, HygieneEntry[]>();
  for (const entry of entries) {
    const heading = headingOf(entry);
    bySection.set(heading, [...(bySection.get(heading) ?? []), entry]);
  }
  for (const segment of file.segments) {
    if (segment.heading !== null && isOpenSection(segment.heading) && introOf(file, segment.heading) && !bySection.has(segment.heading)) {
      bySection.set(segment.heading, []);
    }
  }
  const order = [...SECTIONS.map(([, h]) => h), ...[...bySection.keys()].filter((h) => !SECTION_HEADINGS.has(h)).sort()];
  const parts: string[] = [];
  for (const heading of order) {
    const group = bySection.get(heading);
    if (!group) continue;
    const intro = introOf(file, heading);
    parts.push([`## ${heading}`, intro, renderEntries(group)].filter(Boolean).join("\n\n"));
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}

/** snoozed.md's or resolved.md's owned block: its one section. */
function listBlock(file: LogFile, heading: string, entries: HygieneEntry[]): string {
  const intro = introOf(file, heading);
  return `${[`## ${heading}`, intro, entries.length > 0 ? renderEntries(entries) : "(empty)"].filter(Boolean).join("\n\n")}\n`;
}

/**
 * `frontmatter` with `updated:` set to `today`, through `editFrontmatter`,
 * which keeps every other byte and reads the result back. A block it will not
 * edit (a form it does not handle, or no frontmatter at all) stays as it is.
 */
function withUpdated(frontmatter: string, today: string): string {
  if (!frontmatter) return frontmatter;
  return editFrontmatter(frontmatter, { updated: today }) ?? frontmatter;
}

function template(name: string, today: string, timestamp: string): string {
  return readFileSync(resolve(TEMPLATES_DIR, name), "utf-8").replaceAll("<TODAY>", today).replaceAll("<TIMESTAMP>", timestamp);
}

/** A log file's text on disk (null when missing), and the text to start from: the file, or its template. */
function load(root: string, name: string, today: string, timestamp: string): { disk: string | null; text: string } {
  const path = resolve(root, HYGIENE_DIR, name);
  const disk = existsSync(path) ? readFileSync(path, "utf-8") : null;
  return { disk, text: disk ?? template(name, today, timestamp) };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/** resolved.md keeps this many entries, dropping the oldest by `resolved-on`. */
const RESOLVED_CAP = 200;

/** An auto-fix the skill applied, for last-run.md. */
export interface HygieneFix {
  path: string;
  fix: string;
}

export interface ReconcileOptions {
  now: Date;
  dryRun?: boolean;
  /** Findings the skill made itself (canonical conflicts), as candidates. */
  extra?: HygieneCandidate[];
  /** Auto-fixes the skill applied this run; they go into last-run.md. */
  fixed?: HygieneFix[];
  /** Checks that could not run (`detectCandidates`). */
  failedChecks?: string[];
  /**
   * Writes one file whose bytes on disk should still be `expected` (null:
   * absent); the default is `replaceIfUnchanged`. Tests inject failures here.
   */
  write?: (path: string, text: string, expected: string | null) => void;
}

/**
 * Replace `path` with `text` through a temporary sibling and a rename, so the
 * file is either old or new, never partial, and only while it still holds
 * `expected` (null: absent). The comparison is made after the new bytes are
 * staged, right before the rename, so a person's save while reconcile ran is
 * seen rather than overwritten. There is no lock: a save that lands between
 * that last read and the rename is still lost. That window is a residual we
 * accept, as `brain tags --apply` does (#463). `afterStage` runs between
 * staging and the comparison, for tests.
 */
export function replaceIfUnchanged(path: string, text: string, expected: string | null, afterStage?: () => void): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) throw new HygieneLogError(`${path} is not a regular file; brain hygiene will not replace it`);
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  writeExclusive(tmp, text, entry);
  try {
    afterStage?.();
    const now = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (now !== expected) {
      throw new HygieneLogError(`${path} changed while brain hygiene reconcile ran; it was not overwritten, run it again`);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Match `candidates` against the log and apply the state machine:
 *
 * | Existing state | Detected now? | Action |
 * |---|---|---|
 * | (none) | yes | add to open |
 * | open | yes | update last seen, keep in open |
 * | open | no | move to resolved (resolved-by: auto-disappeared) |
 * | snoozed (until > today) | either | leave snoozed |
 * | snoozed (until ≤ today) | yes | move back to open |
 * | snoozed (until ≤ today) | no | move to resolved (auto-disappeared) |
 * | resolved | yes | re-open (reopened: today, was resolved-by: prev) |
 * | resolved | no | leave resolved |
 *
 * A snoozed entry with no readable `until:` stays snoozed. While any check
 * failed (`failedChecks`), no entry is resolved unless it was detected again:
 * an open entry stays open and an expired snooze stays snoozed, since "not
 * detected" means nothing when a detector did not run.
 *
 * Every log file is read and parsed before anything is written, and one that
 * cannot be parsed safely stops the run. Files are written only when their
 * body changes (then with `updated` set to today), and last-run.md only when
 * an entry changed state or the skill reports fixes, so a run that changes
 * nothing leaves every file as it was. Each file is replaced atomically, and a
 * move between files is written in two passes: first every file with its
 * arrivals added and nothing taken away, then the final contents. A run that
 * stops part-way leaves an entry in two files, never in none, and the next
 * run keeps one copy (snoozed, then resolved, then open).
 */
export function reconcile(
  root: string,
  candidates: HygieneCandidate[],
  docs: Map<string, { updated: string }>,
  opts: ReconcileOptions
): ReconcileResult {
  const today = isoDay(opts.now.getTime());
  const timestamp = opts.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const fixed = opts.fixed ?? [];
  const failedChecks = [...(opts.failedChecks ?? [])].sort();

  // Detected issues by ID; the first candidate for an ID wins.
  const detected = new Map<string, HygieneCandidate>();
  for (const c of [...candidates, ...(opts.extra ?? [])]) {
    if (c.path.startsWith(`${HYGIENE_DIR}/`)) continue;
    const id = hygieneId(c.category, c.path, c.evidence);
    if (!detected.has(id)) detected.set(id, c);
  }

  const rel = (name: string) => `${HYGIENE_DIR}/${name}`;
  const loaded = {
    open: load(root, "open.md", today, timestamp),
    snoozed: load(root, "snoozed.md", today, timestamp),
    resolved: load(root, "resolved.md", today, timestamp),
    index: load(root, "_index.md", today, timestamp),
    lastRun: load(root, "last-run.md", today, timestamp),
  };
  const parsed = {
    open: parseLogFile(loaded.open.text, rel("open.md"), "open", isOpenSection),
    snoozed: parseLogFile(loaded.snoozed.text, rel("snoozed.md"), "snoozed", (h) => h === "Snoozed"),
    resolved: parseLogFile(loaded.resolved.text, rel("resolved.md"), "resolved", (h) => h === "Resolved"),
  };
  const index = parseLogFile(loaded.index.text, rel("_index.md"), null, (h) => h === "Latest counts");
  const lastRun = parseLogFile(loaded.lastRun.text, rel("last-run.md"), null, (h) => h.startsWith("Last run:") || h === "Auto-fixes applied this run");

  // One state per ID. A person's move wins over a copy left behind in open.
  const known = new Map<string, HygieneEntry>();
  for (const state of ["snoozed", "resolved", "open"] as const) {
    for (const entry of parsed[state].entries) if (!known.has(entry.id)) known.set(entry.id, entry);
  }

  // While any check failed, "not detected" may only mean "not looked for":
  // an entry that was not detected again is left as it is.
  const complete = failedChecks.length === 0;

  const next = { open: [] as HygieneEntry[], snoozed: [] as HygieneEntry[], resolved: [] as HygieneEntry[] };
  const categoryOf = new Map<string, string>();
  const counts = { opened: 0, reopened: 0, resolved: 0, stillOpen: 0 };
  const firstSeenOf = (entry: HygieneEntry) =>
    day(/\*\*First seen\*\*:\s*(\S+)/.exec(entry.lines.join("\n"))?.[1] ?? null);

  const openFrom = (candidate: HygieneCandidate, id: string, lines: string[], firstSeen: string): HygieneEntry => {
    categoryOf.set(id, candidate.category);
    return {
      id,
      state: "open",
      lines: refreshLines(lines, detectionLines(candidate, docs.get(candidate.path)?.updated, firstSeen, today)),
      section: null,
    };
  };
  const resolve_ = (entry: HygieneEntry): HygieneEntry => ({
    id: entry.id,
    state: "resolved",
    lines: [...withoutFields(entry.lines, ["until", "resolved-by", "resolved-on"]), "- resolved-by: auto-disappeared", `- resolved-on: ${today}`],
    section: null,
  });

  // Existing entries, in the order their files list them.
  for (const state of ["open", "snoozed", "resolved"] as const) {
    for (const entry of parsed[state].entries) {
      if (known.get(entry.id) !== entry) continue;
      const candidate = detected.get(entry.id);
      if (state === "open") {
        if (candidate) {
          next.open.push(openFrom(candidate, entry.id, entry.lines, firstSeenOf(entry) ?? today));
          counts.stillOpen++;
        } else if (!complete) {
          next.open.push(entry);
          counts.stillOpen++;
        } else {
          next.resolved.push(resolve_(entry));
          counts.resolved++;
        }
      } else if (state === "snoozed") {
        const until = day(field(entry, "until"));
        if (until === null || until > today) {
          next.snoozed.push(entry);
        } else if (candidate) {
          next.open.push(openFrom(candidate, entry.id, withoutFields(entry.lines, ["until"]), firstSeenOf(entry) ?? today));
          counts.reopened++;
        } else if (!complete) {
          next.snoozed.push(entry);
        } else {
          next.resolved.push(resolve_(entry));
          counts.resolved++;
        }
      } else if (candidate) {
        const prev = field(entry, "resolved-by") ?? "unknown";
        const lines = [...withoutFields(entry.lines, ["resolved-by", "resolved-on", "reopened"]), `- reopened: ${today} (was resolved-by: ${prev})`];
        next.open.push(openFrom(candidate, entry.id, lines, firstSeenOf(entry) ?? today));
        counts.reopened++;
      } else {
        next.resolved.push(entry);
      }
    }
  }
  // New issues, in ID order.
  for (const id of [...detected.keys()].sort()) {
    if (known.has(id)) continue;
    next.open.push(openFrom(detected.get(id)!, id, [], today));
    counts.opened++;
  }
  // The newest 200 resolved entries by resolved-on stay.
  if (next.resolved.length > RESOLVED_CAP) {
    const ranked = next.resolved
      .map((entry, i) => ({ entry, i, on: day(field(entry, "resolved-on")) ?? "" }))
      .sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : a.i - b.i))
      .slice(0, RESOLVED_CAP);
    const keep = new Set(ranked.map((r) => r.entry));
    next.resolved = next.resolved.filter((e) => keep.has(e));
  }

  // An entry with no detection this run keeps the section it sat in.
  const headingOf = (entry: HygieneEntry) => {
    const category = categoryOf.get(entry.id);
    if (category) return sectionFor(category);
    if (entry.section && isOpenSection(entry.section)) return entry.section;
    const prefix = SECTIONS.map(([c]) => c).filter((c) => entry.id.startsWith(`${c}-`)).sort((a, b) => b.length - a.length)[0];
    return sectionFor(prefix ?? "uncategorised");
  };
  const stateBody = (state: HygieneState, entries: HygieneEntry[]) =>
    state === "open"
      ? renderLogFile(parsed.open, openBlock(parsed.open, entries, headingOf))
      : renderLogFile(parsed[state], listBlock(parsed[state], state === "snoozed" ? "Snoozed" : "Resolved", entries));
  // The first pass: arrivals added, departures still in place.
  const withDepartures = (state: HygieneState) => {
    const staying = new Set(next[state].map((e) => e.id));
    return [...next[state], ...parsed[state].entries.filter((e) => !staying.has(e.id))];
  };

  const stateChanged = counts.opened + counts.reopened + counts.resolved > 0;
  const countsText = `- Open: ${next.open.length}\n- Snoozed: ${next.snoozed.length}\n- Resolved: ${next.resolved.length}\n`;
  const fixLines = fixed.length > 0 ? fixed.map((f) => `- \`${f.path}\`: ${f.fix.replace(/\s+/g, " ").trim()}`).join("\n") : "(none)";
  const lastRunBlock =
    `## Last run: ${timestamp}\n\n` +
    `- Auto-fixed: ${fixed.length}\n- New open: ${counts.opened}\n- Resolved (disappeared): ${counts.resolved}\n- Reopened: ${counts.reopened}\n` +
    `- Still open: ${counts.stillOpen}\n- Snoozed: ${next.snoozed.length}\n\n` +
    `## Auto-fixes applied this run\n\n${fixLines}\n`;

  const sources = {
    "open.md": { from: loaded.open, file: parsed.open },
    "snoozed.md": { from: loaded.snoozed, file: parsed.snoozed },
    "resolved.md": { from: loaded.resolved, file: parsed.resolved },
    "_index.md": { from: loaded.index, file: index },
    "last-run.md": { from: loaded.lastRun, file: lastRun },
  };
  type Name = keyof typeof sources;
  // The text a file gets for `body`: as it was when the body is unchanged, else with `updated` set to today.
  const textFor = (name: Name, body: string) => {
    const { from, file } = sources[name];
    return from.disk !== null && body === file.body ? from.disk : `${withUpdated(file.frontmatter, today)}${body}`;
  };
  const final = new Map<Name, string>([
    ["open.md", textFor("open.md", stateBody("open", next.open))],
    ["snoozed.md", textFor("snoozed.md", stateBody("snoozed", next.snoozed))],
    ["resolved.md", textFor("resolved.md", stateBody("resolved", next.resolved))],
    ["_index.md", textFor("_index.md", renderLogFile(index, `## Latest counts\n\n${countsText}`))],
  ]);
  if (stateChanged || fixed.length > 0 || loaded.lastRun.disk === null) {
    final.set("last-run.md", textFor("last-run.md", renderLogFile(lastRun, lastRunBlock)));
  }
  const changedFiles = [...final].filter(([name, text]) => sources[name].from.disk !== text).map(([name]) => rel(name));
  // The first pass: each state file with its arrivals added and nothing taken away.
  const firstPass = (["open", "snoozed", "resolved"] as const).map(
    (state) => [`${state}.md`, textFor(`${state}.md`, stateBody(state, withDepartures(state)))] as const
  );
  // Nothing is written that the next run would refuse to read.
  for (const [name, text] of [...firstPass, ...final]) {
    if (text !== sources[name].from.disk) parseLogFile(text, rel(name), null, () => false);
  }

  if (!opts.dryRun && changedFiles.length > 0) {
    const write = opts.write ?? replaceIfUnchanged;
    const dir = resolve(root, HYGIENE_DIR);
    mkdirSync(dir, { recursive: true });
    const real = realpathSync(dir);
    const onDisk = new Map<Name, string | null>((Object.keys(sources) as Name[]).map((name) => [name, sources[name].from.disk]));
    const commit = (name: Name, text: string) => {
      if (onDisk.get(name) === text) return;
      const path = join(real, name);
      const now = existsSync(path) ? readFileSync(path, "utf-8") : null;
      if (now !== onDisk.get(name)) {
        throw new HygieneLogError(`${rel(name)} changed while brain hygiene reconcile ran; nothing more was written, run it again`);
      }
      write(path, text, onDisk.get(name) ?? null);
      onDisk.set(name, text);
    };
    for (const [name, text] of firstPass) commit(name, text);
    for (const [name, text] of final) commit(name, text);
  }

  return {
    ...counts,
    snoozed: next.snoozed.length,
    changedFiles: changedFiles.sort(),
    detected: [...detected].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => ({ id, category: c.category, path: c.path, message: c.message })),
    autoFixed: fixed.length,
    failedChecks,
  };
}

/** The log as it stands: every entry of open.md, snoozed.md and resolved.md. */
export function readHygieneLog(root: string): Array<{
  id: string;
  state: HygieneState;
  path: string | null;
  issue: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  until: string | null;
  resolvedBy: string | null;
  resolvedOn: string | null;
}> {
  const out = [];
  const owns = { open: isOpenSection, snoozed: (h: string) => h === "Snoozed", resolved: (h: string) => h === "Resolved" };
  for (const state of ["open", "snoozed", "resolved"] as const) {
    const path = resolve(root, HYGIENE_DIR, `${state}.md`);
    if (!existsSync(path)) continue;
    for (const entry of parseLogFile(readFileSync(path, "utf-8"), `${HYGIENE_DIR}/${state}.md`, state, owns[state]).entries) {
      const text = entry.lines.join("\n");
      out.push({
        id: entry.id,
        state,
        path: /\*\*Files\*\*:\s*`([^`]+)`/.exec(text)?.[1] ?? null,
        issue: /\*\*Issue\*\*:\s*(.+)/.exec(text)?.[1]?.trim() ?? null,
        firstSeen: day(/\*\*First seen\*\*:\s*(\S+)/.exec(text)?.[1] ?? null),
        lastSeen: day(/\*\*Last seen\*\*:\s*(\S+)/.exec(text)?.[1] ?? null),
        until: day(field(entry, "until")),
        resolvedBy: field(entry, "resolved-by"),
        resolvedOn: day(field(entry, "resolved-on")),
      });
    }
  }
  return out;
}
