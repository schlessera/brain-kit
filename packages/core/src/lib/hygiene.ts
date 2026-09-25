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
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, posix, resolve } from "path";

import { auditWithModules, isoDay, loadAuditDocs, type AuditDoc } from "./auditor.js";
import type { LoadedModule } from "./module-types.js";
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
 * An audit issue as a candidate. Each documented category has its evidence
 * rule; any other category (module checks, and core checks the skill did not
 * name) uses the whole message, which is stable while the document is.
 */
export function candidateFromAudit(issue: AuditIssue, docs: Map<string, AuditDoc>): HygieneCandidate {
  const base = { category: issue.category, path: issue.path, message: issue.message };
  switch (issue.category) {
    case "staleness":
      // The type whose staleness threshold applies; the age in the message
      // changes every day and must not move the ID.
      return { ...base, evidence: docs.get(issue.path)?.type ?? "" };
    case "propagation":
    case "orphan":
    case "index-lag":
      return { ...base, evidence: issue.path };
    case "todo":
    case "verify":
      return { ...base, evidence: /\[(?:TODO|VERIFY):[^\]]*\]/.exec(issue.message)?.[0] ?? issue.message };
    case "type-mismatch":
      return { ...base, evidence: /^Document type "([^"]*)"/.exec(issue.message)?.[1] ?? issue.message };
    case "tag-noise":
      // One corpus-wide issue; its counts move with every tag.
      return { ...base, evidence: "" };
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

/** The cells of a markdown table row, outer pipes dropped. Escaped pipes stay in their cell. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
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

/**
 * The document a row links to: the first markdown link or wiki-link in the
 * row, resolved against the index's directory. A link to a directory means
 * its `status.md`, else its `_index.md`. A wiki-link is matched by file name.
 */
function linkedDetail(row: string[], indexDir: string, byPath: Map<string, AuditDoc>): AuditDoc | null {
  for (const cell of row) {
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
    const wiki = /\[\[([^\]|#]+)/.exec(cell)?.[1]?.trim();
    if (wiki) {
      const name = wiki.replace(/\.md$/, "").toLowerCase();
      for (const doc of byPath.values()) {
        const base = doc.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase();
        if (base === name || doc.path.replace(/\.md$/, "").toLowerCase() === name) return doc;
      }
      return null;
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
export function indexTableLag(docs: AuditDoc[]): HygieneCandidate[] {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const out: HygieneCandidate[] = [];
  for (const index of docs) {
    if (index.type !== "index" && !index.path.endsWith("_index.md")) continue;
    if (index.status === "archived") continue;
    const indexDir = posix.dirname(index.path);
    const lines = index.content.split(/\r?\n/);
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!lines[i].trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
      const header = cells(lines[i]).map(plain);
      const updatedCol = header.findIndex((h) => h.includes("updated"));
      const statusCol = header.findIndex((h) => h.includes("status"));
      if (updatedCol === -1) continue;
      for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
        const row = cells(lines[j]);
        const rowUpdated = dayIn(row[updatedCol] ?? "");
        const detail = linkedDetail(row, indexDir === "." ? "" : indexDir, byPath);
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

/** Every candidate the CLI detects, deduplicated by ID, the log's own files left out. */
export async function detectCandidates(
  db: Database,
  brain: { taxonomy: Taxonomy; root: string; modules: LoadedModule[] },
  now: Date
): Promise<HygieneCandidate[]> {
  const inLog = (path: string) => path.startsWith(`${HYGIENE_DIR}/`);
  const docs = loadAuditDocs(db).filter((d) => !inLog(d.path));
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const table = indexTableLag(docs);
  // A row-level finding is more specific than audit's whole-file index-lag.
  const tableIndexes = new Set(table.map((c) => c.path));
  // The log is left out of detection, so writing it cannot change the next run.
  const audited = (await auditWithModules(db, brain, { now, exclude: inLog }))
    .filter((issue) => !(issue.category === "index-lag" && tableIndexes.has(issue.path)))
    .map((issue) => candidateFromAudit(issue, byPath));
  return [...audited, ...silentEdits(db).filter((c) => !inLog(c.path)), ...table];
}

// ---------------------------------------------------------------------------
// The log's files
// ---------------------------------------------------------------------------

export interface HygieneFile {
  /** The frontmatter block with its fences, or "" when the file has none. */
  frontmatter: string;
  /** Everything before the first entry, as written. */
  preamble: string;
  entries: HygieneEntry[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split a hygiene file into frontmatter, preamble and its `### id` entries. */
export function parseHygieneFile(text: string, state: HygieneState): HygieneFile {
  const frontmatter = FRONTMATTER.exec(text)?.[0] ?? "";
  const lines = text.slice(frontmatter.length).split("\n");
  const preamble: string[] = [];
  const entries: HygieneEntry[] = [];
  let current: HygieneEntry | null = null;
  for (const line of lines) {
    const heading = /^### +(\S+)\s*$/.exec(line);
    if (heading) {
      current = { id: heading[1], state, lines: [] };
      entries.push(current);
      continue;
    }
    // A section heading ends the entry above it.
    if (line.startsWith("## ")) current = null;
    if (current) current.lines.push(line);
    else if (entries.length === 0) preamble.push(line);
  }
  for (const entry of entries) {
    while (entry.lines.length > 0 && entry.lines[entry.lines.length - 1].trim() === "") entry.lines.pop();
  }
  return { frontmatter, preamble: preamble.join("\n"), entries };
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
  ["orphan", "Orphans"],
  ["type-mismatch", "Type/directory mismatches"],
];
const SECTION_HEADINGS = new Set(SECTIONS.map(([, heading]) => heading));

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

/** The preamble with trailing blank lines and a trailing "(empty)" placeholder dropped. */
function trimPreamble(preamble: string): string {
  const lines = preamble.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || lines[lines.length - 1].trim() === "(empty)")) {
    lines.pop();
  }
  return lines.join("\n");
}

function renderOpen(preamble: string, entries: HygieneEntry[], categoryOf: Map<string, string>): string {
  // Keep the text before the first category section; the sections are rebuilt.
  const head: string[] = [];
  for (const line of preamble.split("\n")) {
    const heading = /^## +(.*?)\s*$/.exec(line)?.[1];
    if (heading && (SECTION_HEADINGS.has(heading) || heading.startsWith("Other: "))) break;
    head.push(line);
  }
  const bySection = new Map<string, HygieneEntry[]>();
  for (const entry of entries) {
    const category = categoryOf.get(entry.id) ?? "";
    const heading = SECTIONS.find(([c]) => c === category)?.[1] ?? `Other: ${category || "uncategorised"}`;
    bySection.set(heading, [...(bySection.get(heading) ?? []), entry]);
  }
  const order = [...SECTIONS.map(([, h]) => h), ...[...bySection.keys()].filter((h) => !SECTION_HEADINGS.has(h)).sort()];
  const parts = [trimPreamble(head.join("\n"))];
  for (const heading of order) {
    const group = bySection.get(heading);
    if (group && group.length > 0) parts.push(`## ${heading}\n\n${renderEntries(group)}`);
  }
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function renderList(preamble: string, entries: HygieneEntry[]): string {
  const head = trimPreamble(preamble);
  const body = entries.length > 0 ? renderEntries(entries) : "(empty)";
  return `${head ? `${head}\n\n` : ""}${body}\n`;
}

/** Set `updated:` in a frontmatter block to `today`, touching nothing else. */
function withUpdated(frontmatter: string, today: string): string {
  if (/^updated:.*$/m.test(frontmatter)) return frontmatter.replace(/^updated:.*$/m, `updated: ${today}`);
  return frontmatter.replace(/\r?\n---[ \t]*(\r?\n|$)/, `\nupdated: ${today}\n---$1`);
}

function template(name: string, today: string, timestamp: string): string {
  return readFileSync(resolve(TEMPLATES_DIR, name), "utf-8").replaceAll("<TODAY>", today).replaceAll("<TIMESTAMP>", timestamp);
}

/** A file's frontmatter and body, from disk or from its template when missing. */
function load(root: string, name: string, today: string, timestamp: string): { exists: boolean; text: string } {
  const path = resolve(root, HYGIENE_DIR, name);
  if (existsSync(path)) return { exists: true, text: readFileSync(path, "utf-8") };
  return { exists: false, text: template(name, today, timestamp) };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/** resolved.md keeps this many entries, dropping the oldest by `resolved-on`. */
const RESOLVED_CAP = 200;

export interface ReconcileOptions {
  now: Date;
  dryRun?: boolean;
  /** Findings the skill made itself (canonical conflicts), as candidates. */
  extra?: HygieneCandidate[];
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
 * A snoozed entry with no readable `until:` stays snoozed. Files are written
 * only when their body changes (then with `updated` set to today), and
 * last-run.md only when an entry changed state, so a run that changes
 * nothing leaves every file as it was.
 */
export function reconcile(
  root: string,
  candidates: HygieneCandidate[],
  docs: Map<string, { updated: string }>,
  opts: ReconcileOptions
): ReconcileResult {
  const today = isoDay(opts.now.getTime());
  const timestamp = opts.now.toISOString().replace(/\.\d{3}Z$/, "Z");

  // Detected issues by ID; the first candidate for an ID wins.
  const detected = new Map<string, HygieneCandidate>();
  for (const c of [...candidates, ...(opts.extra ?? [])]) {
    if (c.path.startsWith(`${HYGIENE_DIR}/`)) continue;
    const id = hygieneId(c.category, c.path, c.evidence);
    if (!detected.has(id)) detected.set(id, c);
  }

  const files = {
    open: load(root, "open.md", today, timestamp),
    snoozed: load(root, "snoozed.md", today, timestamp),
    resolved: load(root, "resolved.md", today, timestamp),
  };
  const parsed = {
    open: parseHygieneFile(files.open.text, "open"),
    snoozed: parseHygieneFile(files.snoozed.text, "snoozed"),
    resolved: parseHygieneFile(files.resolved.text, "resolved"),
  };

  // One state per ID. A person's move wins over a copy left behind in open.
  const known = new Map<string, HygieneEntry>();
  for (const state of ["snoozed", "resolved", "open"] as const) {
    for (const entry of parsed[state].entries) if (!known.has(entry.id)) known.set(entry.id, entry);
  }

  const next = { open: [] as HygieneEntry[], snoozed: [] as HygieneEntry[], resolved: [] as HygieneEntry[] };
  const categoryOf = new Map<string, string>();
  const counts = { opened: 0, reopened: 0, resolved: 0, stillOpen: 0 };
  const firstSeenOf = (entry: HygieneEntry) =>
    day(/\*\*First seen\*\*:\s*(\S+)/.exec(entry.lines.join("\n"))?.[1] ?? null);

  const openFrom = (candidate: HygieneCandidate, id: string, lines: string[], firstSeen: string) => {
    categoryOf.set(id, candidate.category);
    return { id, state: "open" as const, lines: refreshLines(lines, detectionLines(candidate, docs.get(candidate.path)?.updated, firstSeen, today)) };
  };
  const resolve_ = (entry: HygieneEntry): HygieneEntry => ({
    id: entry.id,
    state: "resolved",
    lines: [...withoutFields(entry.lines, ["until", "resolved-by", "resolved-on"]), "- resolved-by: auto-disappeared", `- resolved-on: ${today}`],
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

  const stateChanged = counts.opened + counts.reopened + counts.resolved > 0;
  const bodies = new Map<string, { exists: boolean; frontmatter: string; oldBody: string; newBody: string }>();
  const plan = (name: string, text: string, exists: boolean, newBody: string) => {
    const frontmatter = FRONTMATTER.exec(text)?.[0] ?? "";
    bodies.set(name, { exists, frontmatter, oldBody: text.slice(frontmatter.length), newBody });
  };
  plan("open.md", files.open.text, files.open.exists, `\n${renderOpen(parsed.open.preamble.replace(/^\n/, ""), next.open, categoryOf)}`);
  plan("snoozed.md", files.snoozed.text, files.snoozed.exists, `\n${renderList(parsed.snoozed.preamble.replace(/^\n/, ""), next.snoozed)}`);
  plan("resolved.md", files.resolved.text, files.resolved.exists, `\n${renderList(parsed.resolved.preamble.replace(/^\n/, ""), next.resolved)}`);

  const index = load(root, "_index.md", today, timestamp);
  const indexFront = FRONTMATTER.exec(index.text)?.[0] ?? "";
  const indexBody = index.text.slice(indexFront.length);
  const countsText = `- Open: ${next.open.length}\n- Snoozed: ${next.snoozed.length}\n- Resolved: ${next.resolved.length}\n`;
  const latest = /^## Latest counts[ \t]*\r?\n/m.exec(indexBody);
  const newIndexBody = latest
    ? `${indexBody.slice(0, latest.index + latest[0].length)}\n${countsText}`
    : `${indexBody.replace(/\s*$/, "")}\n\n## Latest counts\n\n${countsText}`;
  plan("_index.md", index.text, index.exists, newIndexBody);

  const lastRun = load(root, "last-run.md", today, timestamp);
  if (stateChanged || !lastRun.exists) {
    plan(
      "last-run.md",
      lastRun.text,
      lastRun.exists,
      `\n## Last run: ${timestamp}\n\n` +
        `- New open: ${counts.opened}\n- Resolved (disappeared): ${counts.resolved}\n- Reopened: ${counts.reopened}\n` +
        `- Still open: ${counts.stillOpen}\n- Snoozed: ${next.snoozed.length}\n`
    );
  }

  const changedFiles: string[] = [];
  for (const [name, { exists, frontmatter, oldBody, newBody }] of bodies) {
    if (exists && oldBody === newBody) continue;
    const rel = `${HYGIENE_DIR}/${name}`;
    changedFiles.push(rel);
    if (opts.dryRun) continue;
    const full = resolve(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${withUpdated(frontmatter, today)}${newBody}`, "utf-8");
  }

  return {
    ...counts,
    snoozed: next.snoozed.length,
    changedFiles: changedFiles.sort(),
    detected: [...detected].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => ({ id, category: c.category, path: c.path, message: c.message })),
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
  for (const state of ["open", "snoozed", "resolved"] as const) {
    const path = resolve(root, HYGIENE_DIR, `${state}.md`);
    if (!existsSync(path)) continue;
    for (const entry of parseHygieneFile(readFileSync(path, "utf-8"), state).entries) {
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
