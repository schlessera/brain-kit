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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { parseFrontmatter } from "./frontmatter-parse.js";
import { join, posix, resolve } from "path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { auditWithModules, isoDay, loadAuditDocs, type AuditDoc } from "./auditor.js";
import { topLevelBlocks } from "./document-parts.js";
import { editFrontmatter } from "./frontmatter-edit.js";
import { generatedRegionSpan } from "./generated-regions.js";
import { planRegistry, REGISTRY_REGION } from "./index-registry.js";
import { createWikiLinkResolver, extractWikiLinks, wikiLinkTokens } from "./indexer/links.js";
import type { LoadedModule } from "./module-types.js";
import { writeFileSafely } from "./safe-path.js";
import type { Taxonomy } from "./taxonomy.js";
import type { AuditIssue } from "./types.js";
import { validateDetailed, type DetailedValidationIssue, type ValidationDetail, type ValidationRule } from "./validate.js";

export const HYGIENE_DIR = "context/hygiene";
const TEMPLATES_DIR = resolve(import.meta.dir, "../../skills/content-hygiene/templates");

export type HygieneState = "open" | "snoozed" | "dismissed" | "resolved";

export type HygieneSeverity = "error" | "warning" | "info";

/**
 * Which check reported a finding: `audit` (a core `brain audit` category, by
 * name), `validation` (a `brain validate` rule), `module` (a module's hygiene
 * check, by module name), `hygiene` (this file's own passes: silent edits and
 * index table lag) or `skill` (an `--extra` candidate).
 */
export type HygieneSourceKind = "audit" | "hygiene" | "module" | "skill" | "validation";

export interface HygieneSource {
  source: HygieneSourceKind;
  name: string;
  /** The severity the source gave it; null when the source has none. */
  severity: HygieneSeverity | null;
}

/** A detected issue, before it is matched against the log. */
export interface HygieneCandidate {
  category: string;
  path: string;
  /** The smallest stable piece of evidence; it goes into the ID. */
  evidence: string;
  message: string;
  /** Who reported it. Without one, reconcile records it as `hygiene`, named by its category. */
  source?: HygieneSource;
  /** Urgency the source states explicitly. Absent means unknown; nothing guesses it. */
  urgency?: string;
  /**
   * The category's fingerprint inputs besides severity and urgency
   * (`FINGERPRINT_FIELDS`): `tokens` for a broken link, `value` and `rule`
   * for a required field, `rule` for another validation finding.
   */
  facts?: Record<string, string>;
}

/**
 * One canonical finding: every candidate with the same ID, joined. Its
 * provenance keeps each contributing source, its severity is the most severe
 * one, and its fingerprint covers the category's evidence fields only.
 */
export interface HygieneFinding {
  id: string;
  category: string;
  path: string;
  evidence: string;
  message: string;
  severity: HygieneSeverity | null;
  urgency: string | null;
  /** Never empty, sorted by source then name. */
  sources: HygieneSource[];
  fingerprint: string;
  /** Each fingerprint field's hash, so a change can be named. */
  fingerprintFields: Record<string, string>;
}

/** An entry of the log: its `### id` heading and the lines under it. */
export interface HygieneEntry {
  id: string;
  state: HygieneState;
  lines: string[];
  /** The `## ` heading the entry sat under, or null. */
  section: string | null;
}

/** A dismissed or snoozed finding that returned because its evidence changed. */
export interface HygieneInvalidation {
  id: string;
  disposition: "dismissed" | "snoozed";
  /** The day the disposition was made. */
  dispositionOn: string | null;
  /** The fingerprint fields that changed. */
  changed: string[];
  /** When the change also changed the finding's ID: the ID the disposition was made on. */
  previousId: string | null;
}

export interface ReconcileResult {
  opened: number;
  reopened: number;
  resolved: number;
  stillOpen: number;
  snoozed: number;
  /** Entries left dismissed. */
  dismissed: number;
  /** Dispositions whose evidence changed this run, so their finding is open again. */
  invalidated: number;
  invalidations: HygieneInvalidation[];
  /** Hygiene files written (or, with dryRun, that would be). */
  changedFiles: string[];
  /** Every issue detected this run, with its ID, for the skill's auto-fix decisions. */
  detected: Array<{
    id: string;
    category: string;
    path: string;
    message: string;
    severity: HygieneSeverity | null;
    urgency: string | null;
    sources: HygieneSource[];
    fingerprint: string;
  }>;
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
// Canonical findings and evidence fingerprints
// ---------------------------------------------------------------------------

/**
 * How a `brain validate` rule joins hygiene: its category, and the evidence
 * that goes into the ID. This is the whole equivalence map. A validation
 * finding and an audit finding are one problem only where both map to the
 * same category, path and evidence, which is the case for exactly one pair:
 * an unresolved wiki-link (`link-unresolved`) and audit's `broken-link`, both
 * keyed by the target as written. Every other rule is its own category, so it
 * joins nothing but itself (two tag rules on one tag are one `tag` finding).
 */
export const VALIDATION_JOIN: Record<ValidationRule, (detail: ValidationDetail) => { category: string; evidence: string }> = {
  "frontmatter-missing": () => ({ category: "frontmatter", evidence: "" }),
  "frontmatter-invalid": () => ({ category: "frontmatter", evidence: "" }),
  "required-missing": (d) => ({ category: "required-field", evidence: d.field ?? "" }),
  "type-invalid": () => ({ category: "required-field", evidence: "type" }),
  "field-invalid": (d) => ({ category: "invalid-field", evidence: d.field ?? "" }),
  "archived-primary": () => ({ category: "field-conflict", evidence: "status/relevance" }),
  "tag-format": (d) => ({ category: "tag", evidence: d.value ?? "" }),
  "tag-alias": (d) => ({ category: "tag", evidence: d.value ?? "" }),
  "tag-vocabulary": (d) => ({ category: "tag", evidence: d.value ?? "" }),
  "link-unresolved": (d) => ({ category: "broken-link", evidence: d.target ?? "" }),
  "supersedes-unresolved": (d) => ({ category: "broken-supersedes", evidence: d.target ?? "" }),
  "supersedes-cycle": (d) => ({ category: "supersedes-cycle", evidence: d.target ?? "" }),
};

/** A validation issue as a candidate, through `VALIDATION_JOIN`; its message is never read. */
export function candidateFromValidation(issue: DetailedValidationIssue): HygieneCandidate {
  const { category, evidence } = VALIDATION_JOIN[issue.detail.rule](issue.detail);
  const facts: Record<string, string> = { rule: issue.detail.rule };
  if (issue.detail.value !== undefined) facts.value = issue.detail.value;
  return {
    category,
    path: issue.file,
    evidence,
    message: issue.message,
    source: { source: "validation", name: issue.detail.rule, severity: issue.level },
    facts,
  };
}

/**
 * The fields each category's evidence fingerprint covers. The fingerprint is
 * separate from the ID: the ID names the problem, the fingerprint says
 * whether a dismissal or snooze still applies to it. Line numbers, the rest
 * of the document, messages (which carry ages and counts) and age itself are
 * never in it.
 *
 * - `broken-link`: the target as written, every link token naming it as
 *   written (`[[target|label]]`, sorted), severity, urgency.
 * - `required-field`: the field, its raw value (`absent` when missing), the
 *   rule it breaks, severity, urgency.
 * - any other category: its ID evidence, the validation rules that report it
 *   (empty for other sources), severity, urgency.
 *
 * `severity` is the most severe source's (`unknown` when no source gives
 * one); `urgency` is the urgency a source states, `unknown` when none does.
 */
export const FINGERPRINT_FIELDS: Record<string, readonly string[]> = {
  "broken-link": ["target", "tokens", "severity", "urgency"],
  "required-field": ["field", "value", "rule", "severity", "urgency"],
};
const DEFAULT_FINGERPRINT_FIELDS = ["evidence", "rule", "severity", "urgency"] as const;

const SEVERITY_RANK: Record<HygieneSeverity, number> = { error: 0, warning: 1, info: 2 };
const SOURCE_RANK: Record<HygieneSourceKind, number> = { audit: 0, hygiene: 1, module: 2, skill: 3, validation: 4 };
const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** A candidate's source: as given, else `hygiene` named by its category. */
const sourceOf = (c: HygieneCandidate): HygieneSource => c.source ?? { source: "hygiene", name: c.category, severity: null };

const compareSources = (a: HygieneSource, b: HygieneSource) =>
  SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
  (a.severity === b.severity ? 0 : a.severity === null ? 1 : b.severity === null ? -1 : SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

/** Every value the candidates give `key`, deduplicated and sorted, one per line. */
function joined(values: Array<string | undefined>): string {
  return [...new Set(values.filter((v): v is string => v !== undefined))].sort().join("\n");
}

/**
 * The candidates, joined into one canonical finding per ID. The result does
 * not depend on the order the candidates come in: provenance is sorted and
 * deduplicated, fingerprint inputs are sorted, and the message is the first
 * source's by `SOURCE_RANK`, then name, then text.
 */
export function canonicalFindings(candidates: HygieneCandidate[]): Map<string, HygieneFinding> {
  const groups = new Map<string, HygieneCandidate[]>();
  for (const c of candidates) {
    if (c.path.startsWith(`${HYGIENE_DIR}/`)) continue;
    const id = hygieneId(c.category, c.path, c.evidence);
    groups.set(id, [...(groups.get(id) ?? []), c]);
  }
  const out = new Map<string, HygieneFinding>();
  for (const id of [...groups.keys()].sort()) {
    const group = [...groups.get(id)!].sort(
      (a, b) => compareSources(sourceOf(a), sourceOf(b)) || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
    );
    const { category, path, evidence, message } = group[0];
    const sources: HygieneSource[] = [];
    for (const s of group.map(sourceOf).sort(compareSources)) {
      const last = sources[sources.length - 1];
      if (!last || compareSources(last, s) !== 0) sources.push({ source: s.source, name: s.name, severity: s.severity });
    }
    const severity = sources.map((s) => s.severity).filter((s): s is HygieneSeverity => s !== null)
      .sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? null;
    const urgency = joined(group.map((c) => c.urgency)) || null;
    const fact = (key: string) => joined(group.map((c) => c.facts?.[key]));
    const values: Record<string, string> = {
      target: evidence,
      field: evidence,
      evidence,
      tokens: fact("tokens"),
      value: fact("value"),
      rule: fact("rule"),
      severity: severity ?? "unknown",
      urgency: urgency ?? "unknown",
    };
    // Own keys only: a module or skill category may be named `constructor`.
    const fieldNames = Object.hasOwn(FINGERPRINT_FIELDS, category) ? FINGERPRINT_FIELDS[category] : DEFAULT_FINGERPRINT_FIELDS;
    const fingerprintFields = Object.fromEntries(fieldNames.map((name) => [name, sha1(values[name]).slice(0, 8)]));
    out.set(id, {
      id,
      category,
      path,
      evidence,
      message,
      severity,
      urgency,
      sources,
      fingerprint: fingerprintOf(category, fingerprintFields),
      fingerprintFields,
    });
  }
  return out;
}

/** The fingerprint: 12 hex digits of SHA-1 over the category and each field's hash, in the category's field order. */
function fingerprintOf(category: string, fields: Record<string, string>): string {
  return sha1([category, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join("\n")).slice(0, 12);
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

/**
 * Every candidate the CLI detects, the log's own files left out, and the
 * checks that failed. Besides audit, module checks and this file's own passes
 * it runs `brain validate`'s corpus checks (`validation` in `failedChecks`
 * when they cannot run) and joins them through `VALIDATION_JOIN`.
 */
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
  const table = indexTableLag(docs, registryIndexes, indexedWikiLinks(db)).map((c) => withSource(c, { source: "hygiene", name: "index-table", severity: null }));
  // A row-level finding is more specific than audit's whole-file index-lag.
  const tableIndexes = new Set(table.map((c) => c.path));
  const failed = new Set<string>();
  const moduleOf = new Map<AuditIssue, string>();
  // The log is left out of detection, so writing it cannot change the next run.
  const audited = (await auditWithModules(db, brain, {
    now,
    exclude: inLog,
    onCheckFailed: (name) => failed.add(name),
    onModuleIssue: (issue, module) => moduleOf.set(issue, module),
  }))
    .filter((issue) => !(issue.category === "index-lag" && tableIndexes.has(issue.path)))
    .map((issue) => {
      const module = moduleOf.get(issue);
      return withSource(candidateFromAudit(issue, byPath), module === undefined
        ? { source: "audit", name: issue.category, severity: issue.severity }
        : { source: "module", name: module, severity: issue.severity });
    });
  let validated: HygieneCandidate[] = [];
  try {
    validated = validateDetailed(brain.root, brain.taxonomy).filter((issue) => !inLog(issue.file)).map(candidateFromValidation);
  } catch {
    failed.add("validation");
  }
  const silent = silentEdits(db).filter((c) => !inLog(c.path)).map((c) => withSource(c, { source: "hygiene", name: "silent-edit", severity: null }));
  return {
    candidates: withLinkTokens(brain.root, [...audited, ...silent, ...table, ...validated]),
    failedChecks: [...failed].sort(),
  };
}

function withSource(candidate: HygieneCandidate, source: HygieneSource): HygieneCandidate {
  return { ...candidate, source };
}

/**
 * Each broken-link candidate with its `tokens` fact: the document's link
 * tokens naming its target, as written, read from the file on disk the way
 * validation reads it, so every source fingerprints the same bytes.
 */
function withLinkTokens(root: string, candidates: HygieneCandidate[]): HygieneCandidate[] {
  const bodies = new Map<string, string>();
  const body = (path: string) => {
    let text = bodies.get(path);
    if (text === undefined) {
      try {
        const file = resolve(root, path);
        // A module may name any path; only a document inside the brain is read.
        if (!file.startsWith(`${resolve(root)}/`)) throw new Error("outside the brain");
        const raw = readFileSync(file, "utf-8");
        try {
          text = parseFrontmatter(raw).content;
        } catch {
          text = raw;
        }
      } catch {
        text = "";
      }
      bodies.set(path, text);
    }
    return text;
  };
  return candidates.map((c) =>
    c.category === "broken-link" ? { ...c, facts: { ...c.facts, tokens: wikiLinkTokens(body(c.path), c.evidence).join("\n") } } : c
  );
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

/** The lines a disposition writes, and the receipt of one that was invalidated. */
const DISPOSITION_FIELDS = ["until", "dismissed-on", "snoozed-on", "reason", "disposition-fingerprint", "invalidated"];

/**
 * When a snooze is due, in epoch milliseconds: an ISO date-time is due at that
 * instant; a date (`until: 2026-08-01`, as people write it) at the start of
 * that UTC day, so it is due on that day as before. Null when unreadable.
 */
function dueAt(until: string | null): number | null {
  if (until === null) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(until)) {
    // A date-time written without a zone is read as UTC, the same on every machine.
    const at = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(until) ? until : `${until}Z`);
    return Number.isNaN(at) ? null : at;
  }
  const d = day(until);
  const at = d === null ? NaN : Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(at) ? null : at;
}

/** An ISO date (`YYYY-MM-DD`) or date-time with a zone (`2026-10-12T08:00:00+02:00`, `…Z`). */
export const UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** A source as the log writes it: `kind/name (severity)`, the name escaped where it could break the line apart. */
function renderSource(s: HygieneSource): string {
  const name = s.name.replace(/[^A-Za-z0-9._@+-]/g, (ch) => encodeURIComponent(ch));
  return `${s.source}/${name}${s.severity ? ` (${s.severity})` : ""}`;
}

function parseSources(value: string | null): HygieneSource[] {
  if (!value) return [];
  const out: HygieneSource[] = [];
  for (const part of value.split(" · ")) {
    const m = /^(audit|hygiene|module|skill|validation)\/(\S+?)(?: \((error|warning|info)\))?$/.exec(part.trim());
    if (!m) continue;
    let name = m[2];
    try {
      name = decodeURIComponent(name);
    } catch {
      // A hand edit left a malformed escape: keep it as written.
    }
    out.push({ source: m[1] as HygieneSourceKind, name, severity: (m[3] as HygieneSeverity | undefined) ?? null });
  }
  return out;
}

/** A fingerprint as the log writes it: `abcdef012345 (target 1a2b3c4d, tokens …)`. */
function renderFingerprint(fingerprint: string, fields: Record<string, string>): string {
  return `${fingerprint} (${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join(", ")})`;
}

function parseFingerprint(value: string | null): { fingerprint: string; fields: Record<string, string> } | null {
  const m = value ? /^([0-9a-f]{12})(?: \(([^)]*)\))?$/.exec(value) : null;
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const part of (m[2] ?? "").split(", ")) {
    const f = /^([a-z-]+) ([0-9a-f]{8})$/.exec(part.trim());
    if (f) fields[f[1]] = f[2];
  }
  return { fingerprint: m[1], fields };
}

/** The fingerprint fields that differ; every field of either side when one side's fields are unknown. */
function changedFields(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  return names.filter((name) => before[name] !== after[name]);
}

/** An entry's line for `key`, everything after the colon as written. */
function rawField(entry: HygieneEntry, key: string): string | null {
  const pattern = new RegExp(`^[-*\\s]*\\**${key}\\**\\s*:\\**\\s*(.*?)\\s*$`, "i");
  for (const line of entry.lines) {
    const m = pattern.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** The disposition an entry records, read back from its lines. */
interface RecordedDisposition {
  kind: "dismissed" | "snoozed";
  /** When it was made, as written. */
  on: string | null;
  fingerprint: { fingerprint: string; fields: Record<string, string> } | null;
}

function recordedDisposition(entry: HygieneEntry): RecordedDisposition | null {
  if (entry.state !== "dismissed" && entry.state !== "snoozed") return null;
  return {
    kind: entry.state,
    on: field(entry, entry.state === "dismissed" ? "dismissed-on" : "snoozed-on"),
    fingerprint: parseFingerprint(field(entry, "disposition-fingerprint")),
  };
}

/** `- invalidated: 2026-10-06 · dismissed on 2026-10-02 · changed: target, tokens[ · was <id>]` */
function invalidationLine(today: string, inv: HygieneInvalidation): string {
  return `- invalidated: ${today} · ${inv.disposition} on ${inv.dispositionOn ?? "unknown"} · changed: ${inv.changed.join(", ") || "fingerprint"}` +
    (inv.previousId ? ` · was ${inv.previousId}` : "");
}

function parseInvalidation(entry: HygieneEntry): { on: string; disposition: "dismissed" | "snoozed"; dispositionOn: string | null; changed: string[]; previousId: string | null } | null {
  const value = rawField(entry, "invalidated");
  const m = value ? /^(\d{4}-\d{2}-\d{2}) · (dismissed|snoozed) on (\S+) · changed: ([a-z, -]+?)(?: · was (\S+))?$/.exec(value) : null;
  if (!m) return null;
  return {
    on: m[1],
    disposition: m[2] as "dismissed" | "snoozed",
    dispositionOn: day(m[3]),
    changed: m[4].split(",").map((s) => s.trim()).filter(Boolean),
    previousId: m[5] ?? null,
  };
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
  ["required-field", "Required frontmatter fields"],
  ["orphan", "Orphans"],
  ["type-mismatch", "Type/directory mismatches"],
];
const SECTION_HEADINGS = new Set(SECTIONS.map(([, heading]) => heading));
const isOpenSection = (heading: string) => SECTION_HEADINGS.has(heading) || heading.startsWith("Other: ");
const sectionFor = (category: string) => SECTIONS.find(([c]) => c === category)?.[1] ?? `Other: ${category}`;

/** The generated lines of an open entry, fresh from its detection. */
function detectionLines(finding: HygieneFinding, updated: string | undefined, firstSeen: string, lastSeen: string): string[] {
  return [
    `- **Files**: \`${finding.path}\`${updated ? ` (updated ${updated})` : ""}`,
    `- **Issue**: ${finding.message.replace(/\s+/g, " ").trim()}`,
    `- **First seen**: ${firstSeen} · **Last seen**: ${lastSeen}`,
    `- **Sources**: ${finding.sources.map(renderSource).join(" · ")}`,
    `- **Fingerprint**: ${renderFingerprint(finding.fingerprint, finding.fingerprintFields)}`,
  ];
}

/** Replace the generated lines, keep anything a person wrote under the entry. */
function refreshLines(lines: string[], fresh: string[]): string[] {
  const kept = lines.filter((line) => !/^- \*\*(Files|Issue|First seen|Sources|Fingerprint)\*\*:/.test(line));
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
  /** Dismissals and snoozes to record this run (`brain hygiene dismiss` / `snooze`). */
  dispositions?: HygieneDispositionRequest[];
  /**
   * Writes one file whose bytes on disk should still be `expected` (null:
   * absent); the default is `replaceIfUnchanged`. Tests inject failures here.
   */
  write?: (path: string, text: string, expected: string | null) => void;
}

/** Dismiss or snooze one detected finding, if its fingerprint is still `expectFingerprint`. */
export type HygieneDispositionRequest =
  | { kind: "dismissed"; id: string; expectFingerprint: string; reason?: string }
  | { kind: "snoozed"; id: string; expectFingerprint: string; until: string; reason?: string };

/**
 * A disposition reconcile would not record: the finding is not detected now,
 * or its evidence is no longer what the caller saw. Thrown before any file is
 * written.
 */
export class HygieneRefusal extends Error {
  constructor(
    readonly reason: "not-detected" | "stale-fingerprint",
    readonly id: string,
    readonly expectedFingerprint: string,
    readonly currentFingerprint: string | null
  ) {
    super(
      reason === "not-detected"
        ? `${id} is not detected now; nothing was written`
        : `${id} has fingerprint ${currentFingerprint}, not ${expectedFingerprint}: its evidence changed; nothing was written`
    );
  }
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
  writeFileSafely(path, text, {
    beforePublish: () => {
      afterStage?.();
      const now = existsSync(path) ? readFileSync(path, "utf-8") : null;
      if (now !== expected) {
        throw new HygieneLogError(`${path} changed while brain hygiene reconcile ran; it was not overwritten, run it again`);
      }
    },
  });
}

/**
 * Match `candidates` against the log and apply the state machine:
 *
 * | Existing state | Detected now? | Action |
 * |---|---|---|
 * | (none) | yes | add to open |
 * | open | yes | update last seen, keep in open |
 * | open | no | move to resolved (resolved-by: auto-disappeared) |
 * | snoozed (not due) | yes, fingerprint changed | move to open (invalidated) |
 * | snoozed (not due) | otherwise | leave snoozed |
 * | snoozed (due) | yes | move back to open |
 * | snoozed (due) | no | move to resolved (auto-disappeared) |
 * | dismissed | yes, fingerprint changed | move to open (invalidated) |
 * | dismissed | yes, unchanged | leave dismissed |
 * | dismissed | no | move to resolved (auto-disappeared) |
 * | resolved | yes | re-open (reopened: today, was resolved-by: prev) |
 * | resolved | no | leave resolved |
 *
 * Candidates with the same ID are one finding (`canonicalFindings`). A snooze
 * is due when its `until:` arrives (`dueAt`); one with no readable `until:`
 * stays snoozed. Only a disposition that recorded the fingerprint it applied
 * to (`disposition-fingerprint:`) can be invalidated: one moved by hand has
 * none and keeps its old behaviour. An invalidated finding opens with an
 * `invalidated:` receipt naming the fields that changed and when the
 * disposition was made. When the change also changed the ID (a broken link's
 * target), the receipt goes on the new finding only if the pairing is
 * unambiguous: the run detects exactly one new finding with that category and
 * path, and exactly one disposition with them is no longer detected.
 *
 * `dispositions` records dismissals and snoozes on findings detected now; one
 * whose fingerprint is not the expected one throws `HygieneRefusal` before
 * anything is written. While any check failed (`failedChecks`), no entry is
 * resolved unless it was detected again: an open entry stays open and an
 * expired snooze or a dismissal stays where it is, since "not detected" means
 * nothing when a detector did not run.
 *
 * Every log file is read and parsed before anything is written, and one that
 * cannot be parsed safely stops the run. Files are written only when their
 * body changes (then with `updated` set to today), and last-run.md only when
 * an entry changed state or the skill reports fixes, so a run that changes
 * nothing leaves every file as it was. Each file is replaced atomically, and a
 * move between files is written in two passes: first every file with its
 * arrivals added and nothing taken away, then the final contents. A run that
 * stops part-way leaves an entry in two files, never in none, and the next
 * run keeps one copy (snoozed, then dismissed, then resolved, then open).
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

  // One canonical finding per ID, whatever order the sources came in.
  const detected = canonicalFindings([...candidates, ...(opts.extra ?? [])]);

  // A disposition applies to the evidence its caller saw, or not at all.
  const requested = new Map<string, HygieneDispositionRequest>();
  for (const request of opts.dispositions ?? []) {
    const finding = detected.get(request.id);
    if (!finding) throw new HygieneRefusal("not-detected", request.id, request.expectFingerprint, null);
    if (finding.fingerprint !== request.expectFingerprint) {
      throw new HygieneRefusal("stale-fingerprint", request.id, request.expectFingerprint, finding.fingerprint);
    }
    requested.set(request.id, request);
  }

  const rel = (name: string) => `${HYGIENE_DIR}/${name}`;
  const loaded = {
    open: load(root, "open.md", today, timestamp),
    snoozed: load(root, "snoozed.md", today, timestamp),
    dismissed: load(root, "dismissed.md", today, timestamp),
    resolved: load(root, "resolved.md", today, timestamp),
    index: load(root, "_index.md", today, timestamp),
    lastRun: load(root, "last-run.md", today, timestamp),
  };
  const parsed = {
    open: parseLogFile(loaded.open.text, rel("open.md"), "open", isOpenSection),
    snoozed: parseLogFile(loaded.snoozed.text, rel("snoozed.md"), "snoozed", (h) => h === "Snoozed"),
    dismissed: parseLogFile(loaded.dismissed.text, rel("dismissed.md"), "dismissed", (h) => h === "Dismissed"),
    resolved: parseLogFile(loaded.resolved.text, rel("resolved.md"), "resolved", (h) => h === "Resolved"),
  };
  const index = parseLogFile(loaded.index.text, rel("_index.md"), null, (h) => h === "Latest counts");
  const lastRun = parseLogFile(loaded.lastRun.text, rel("last-run.md"), null, (h) => h.startsWith("Last run:") || h === "Auto-fixes applied this run");

  // One state per ID. A person's move wins over a copy left behind in open.
  const known = new Map<string, HygieneEntry>();
  for (const state of ["snoozed", "dismissed", "resolved", "open"] as const) {
    for (const entry of parsed[state].entries) if (!known.has(entry.id)) known.set(entry.id, entry);
  }

  // While any check failed, "not detected" may only mean "not looked for":
  // an entry that was not detected again is left as it is.
  const complete = failedChecks.length === 0;

  const next = { open: [] as HygieneEntry[], snoozed: [] as HygieneEntry[], dismissed: [] as HygieneEntry[], resolved: [] as HygieneEntry[] };
  const categoryOf = new Map<string, string>();
  const counts = { opened: 0, reopened: 0, resolved: 0, stillOpen: 0 };
  const invalidations: HygieneInvalidation[] = [];
  const firstSeenOf = (entry: HygieneEntry) =>
    day(/\*\*First seen\*\*:\s*(\S+)/.exec(entry.lines.join("\n"))?.[1] ?? null);

  const openFrom = (finding: HygieneFinding, id: string, lines: string[], firstSeen: string): HygieneEntry => {
    categoryOf.set(id, finding.category);
    return {
      id,
      state: "open",
      lines: refreshLines(lines, detectionLines(finding, docs.get(finding.path)?.updated, firstSeen, today)),
      section: null,
    };
  };
  const resolve_ = (entry: HygieneEntry): HygieneEntry => ({
    id: entry.id,
    state: "resolved",
    lines: [...withoutFields(entry.lines, [...DISPOSITION_FIELDS, "resolved-by", "resolved-on"]), "- resolved-by: auto-disappeared", `- resolved-on: ${today}`],
    section: null,
  });
  // A requested disposition, with the fingerprint it applies to.
  const disposedFrom = (finding: HygieneFinding, id: string, lines: string[], firstSeen: string, request: HygieneDispositionRequest): HygieneEntry => {
    categoryOf.set(id, finding.category);
    const kept = withoutFields(lines, [...DISPOSITION_FIELDS, "resolved-by", "resolved-on"]);
    const record = request.kind === "dismissed" ? [`- dismissed-on: ${timestamp}`] : [`- until: ${request.until}`, `- snoozed-on: ${timestamp}`];
    const reason = request.reason?.replace(/\s+/g, " ").trim();
    if (reason) record.push(`- reason: ${reason}`);
    record.push(`- disposition-fingerprint: ${renderFingerprint(finding.fingerprint, finding.fingerprintFields)}`);
    return {
      id,
      state: request.kind,
      lines: [...refreshLines(kept, detectionLines(finding, docs.get(finding.path)?.updated, firstSeen, today)), ...record],
      section: null,
    };
  };
  // A disposition whose evidence changed: the finding is open again, with a receipt.
  const invalidate = (finding: HygieneFinding, recorded: RecordedDisposition, lines: string[], firstSeen: string, previousId: string | null) => {
    const invalidation: HygieneInvalidation = {
      id: finding.id,
      disposition: recorded.kind,
      dispositionOn: day(recorded.on),
      changed: recorded.fingerprint ? changedFields(recorded.fingerprint.fields, finding.fingerprintFields) : [],
      previousId,
    };
    invalidations.push(invalidation);
    next.open.push(openFrom(finding, finding.id, [...withoutFields(lines, DISPOSITION_FIELDS), invalidationLine(today, invalidation)], firstSeen));
  };
  const changed = (recorded: RecordedDisposition | null, finding: HygieneFinding) =>
    recorded?.fingerprint != null && recorded.fingerprint.fingerprint !== finding.fingerprint;
  // Dispositions still in force whose finding was not detected: the ID may have changed with the evidence.
  const vanished: Array<{ entry: HygieneEntry; recorded: RecordedDisposition; path: string | null }> = [];
  const filesOf = (entry: HygieneEntry) => /\*\*Files\*\*:\s*`([^`]+)`/.exec(entry.lines.join("\n"))?.[1] ?? null;

  // Existing entries, in the order their files list them.
  for (const state of ["open", "snoozed", "dismissed", "resolved"] as const) {
    for (const entry of parsed[state].entries) {
      if (known.get(entry.id) !== entry) continue;
      const finding = detected.get(entry.id);
      const request = requested.get(entry.id);
      if (finding && request) {
        next[request.kind].push(disposedFrom(finding, entry.id, entry.lines, firstSeenOf(entry) ?? today, request));
        continue;
      }
      const recorded = recordedDisposition(entry);
      if (state === "open") {
        if (finding) {
          next.open.push(openFrom(finding, entry.id, entry.lines, firstSeenOf(entry) ?? today));
          counts.stillOpen++;
        } else if (!complete) {
          next.open.push(entry);
          counts.stillOpen++;
        } else {
          next.resolved.push(resolve_(entry));
          counts.resolved++;
        }
      } else if (state === "snoozed") {
        const due = dueAt(field(entry, "until"));
        if (due === null || due > opts.now.getTime()) {
          if (finding && changed(recorded, finding)) invalidate(finding, recorded!, entry.lines, firstSeenOf(entry) ?? today, null);
          else next.snoozed.push(entry);
          if (!finding && recorded?.fingerprint) vanished.push({ entry, recorded, path: filesOf(entry) });
        } else if (finding) {
          next.open.push(openFrom(finding, entry.id, withoutFields(entry.lines, DISPOSITION_FIELDS), firstSeenOf(entry) ?? today));
          counts.reopened++;
        } else if (!complete) {
          next.snoozed.push(entry);
        } else {
          next.resolved.push(resolve_(entry));
          counts.resolved++;
        }
      } else if (state === "dismissed") {
        if (finding) {
          if (changed(recorded, finding)) invalidate(finding, recorded!, entry.lines, firstSeenOf(entry) ?? today, null);
          else next.dismissed.push(entry);
        } else {
          if (recorded?.fingerprint) vanished.push({ entry, recorded, path: filesOf(entry) });
          if (!complete) next.dismissed.push(entry);
          else {
            next.resolved.push(resolve_(entry));
            counts.resolved++;
          }
        }
      } else if (finding) {
        const prev = field(entry, "resolved-by") ?? "unknown";
        const lines = [...withoutFields(entry.lines, ["resolved-by", "resolved-on", "reopened"]), `- reopened: ${today} (was resolved-by: ${prev})`];
        next.open.push(openFrom(finding, entry.id, lines, firstSeenOf(entry) ?? today));
        counts.reopened++;
      } else {
        next.resolved.push(entry);
      }
    }
  }
  // New issues, in ID order.
  const fresh = [...detected.keys()].filter((id) => !known.has(id)).sort();
  const sameProblemSlot = (id: string, category: string, path: string) =>
    id.length === `${category}-${shortPath(path)}-`.length + 4 && id.startsWith(`${category}-${shortPath(path)}-`);
  for (const id of fresh) {
    const finding = detected.get(id)!;
    const request = requested.get(id);
    if (request) {
      next[request.kind].push(disposedFrom(finding, id, [], today, request));
      continue;
    }
    // A disposition whose ID changed with its evidence: paired only when nothing else could be meant.
    const prior = vanished.filter((v) => v.path === finding.path && sameProblemSlot(v.entry.id, finding.category, finding.path));
    const siblings = fresh.filter((other) => {
      const f = detected.get(other)!;
      return f.category === finding.category && f.path === finding.path && !requested.has(other);
    });
    if (prior.length === 1 && siblings.length === 1) {
      invalidate(finding, prior[0].recorded, [], today, prior[0].entry.id);
    } else {
      next.open.push(openFrom(finding, id, [], today));
    }
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
  const listHeading = { snoozed: "Snoozed", dismissed: "Dismissed", resolved: "Resolved" } as const;
  const stateBody = (state: HygieneState, entries: HygieneEntry[]) =>
    state === "open"
      ? renderLogFile(parsed.open, openBlock(parsed.open, entries, headingOf))
      : renderLogFile(parsed[state], listBlock(parsed[state], listHeading[state], entries));
  // The first pass: arrivals added, departures still in place.
  const withDepartures = (state: HygieneState) => {
    const staying = new Set(next[state].map((e) => e.id));
    return [...next[state], ...parsed[state].entries.filter((e) => !staying.has(e.id))];
  };

  const stateChanged = counts.opened + counts.reopened + counts.resolved + invalidations.length + requested.size > 0;
  const countsText =
    `- Open: ${next.open.length}\n- Snoozed: ${next.snoozed.length}\n- Dismissed: ${next.dismissed.length}\n- Resolved: ${next.resolved.length}\n`;
  const fixLines = fixed.length > 0 ? fixed.map((f) => `- \`${f.path}\`: ${f.fix.replace(/\s+/g, " ").trim()}`).join("\n") : "(none)";
  const lastRunBlock =
    `## Last run: ${timestamp}\n\n` +
    `- Auto-fixed: ${fixed.length}\n- New open: ${counts.opened}\n- Resolved (disappeared): ${counts.resolved}\n- Reopened: ${counts.reopened}\n` +
    `- Still open: ${counts.stillOpen}\n- Snoozed: ${next.snoozed.length}\n\n` +
    `## Auto-fixes applied this run\n\n${fixLines}\n`;

  const sources = {
    "open.md": { from: loaded.open, file: parsed.open },
    "snoozed.md": { from: loaded.snoozed, file: parsed.snoozed },
    "dismissed.md": { from: loaded.dismissed, file: parsed.dismissed },
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
    ["dismissed.md", textFor("dismissed.md", stateBody("dismissed", next.dismissed))],
    ["resolved.md", textFor("resolved.md", stateBody("resolved", next.resolved))],
    ["_index.md", textFor("_index.md", renderLogFile(index, `## Latest counts\n\n${countsText}`))],
  ]);
  if (stateChanged || fixed.length > 0 || loaded.lastRun.disk === null) {
    final.set("last-run.md", textFor("last-run.md", renderLogFile(lastRun, lastRunBlock)));
  }
  const changedFiles = [...final].filter(([name, text]) => sources[name].from.disk !== text).map(([name]) => rel(name));
  // The first pass: each state file with its arrivals added and nothing taken away.
  const firstPass = (["open", "snoozed", "dismissed", "resolved"] as const).map(
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
    dismissed: next.dismissed.length,
    invalidated: invalidations.length,
    invalidations: invalidations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    changedFiles: changedFiles.sort(),
    detected: [...detected.values()].map((f) => ({
      id: f.id,
      category: f.category,
      path: f.path,
      message: f.message,
      severity: f.severity,
      urgency: f.urgency,
      sources: f.sources,
      fingerprint: f.fingerprint,
    })),
    autoFixed: fixed.length,
    failedChecks,
  };
}

/** One entry of the log, as `brain hygiene list` reports it. */
export interface HygieneLogEntry {
  id: string;
  state: HygieneState;
  path: string | null;
  issue: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** A snooze's day (`YYYY-MM-DD`), as before; `dueAt` is the instant. */
  until: string | null;
  /** When a snooze becomes due, as an ISO date-time (a date-only `until` is due at its start, UTC). */
  dueAt: string | null;
  resolvedBy: string | null;
  resolvedOn: string | null;
  /** The sources the finding was last detected with; empty for an entry written before they were recorded. */
  sources: HygieneSource[];
  /** The most severe source's severity. */
  severity: HygieneSeverity | null;
  /** The evidence fingerprint the finding was last detected with. */
  fingerprint: string | null;
  /** A dismissal or snooze recorded by `brain hygiene dismiss`/`snooze` (or moved by hand: then without a fingerprint). */
  disposition: { kind: "dismissed" | "snoozed"; on: string | null; reason: string | null; fingerprint: string | null } | null;
  /** Why a dismissed or snoozed finding is open again before its time. */
  invalidation: { on: string; disposition: "dismissed" | "snoozed"; dispositionOn: string | null; changed: string[]; previousId: string | null } | null;
}

/** The log as it stands: every entry of open.md, snoozed.md, dismissed.md and resolved.md. */
export function readHygieneLog(root: string): HygieneLogEntry[] {
  const out: HygieneLogEntry[] = [];
  const owns = {
    open: isOpenSection,
    snoozed: (h: string) => h === "Snoozed",
    dismissed: (h: string) => h === "Dismissed",
    resolved: (h: string) => h === "Resolved",
  };
  for (const state of ["open", "snoozed", "dismissed", "resolved"] as const) {
    const path = resolve(root, HYGIENE_DIR, `${state}.md`);
    if (!existsSync(path)) continue;
    for (const entry of parseLogFile(readFileSync(path, "utf-8"), `${HYGIENE_DIR}/${state}.md`, state, owns[state]).entries) {
      const text = entry.lines.join("\n");
      const sources = parseSources(field(entry, "sources"));
      const due = state === "snoozed" ? dueAt(field(entry, "until")) : null;
      const recorded = recordedDisposition(entry);
      out.push({
        id: entry.id,
        state,
        path: /\*\*Files\*\*:\s*`([^`]+)`/.exec(text)?.[1] ?? null,
        issue: /\*\*Issue\*\*:\s*(.+)/.exec(text)?.[1]?.trim() ?? null,
        firstSeen: day(/\*\*First seen\*\*:\s*(\S+)/.exec(text)?.[1] ?? null),
        lastSeen: day(/\*\*Last seen\*\*:\s*(\S+)/.exec(text)?.[1] ?? null),
        until: day(field(entry, "until")),
        dueAt: due === null ? null : new Date(due).toISOString().replace(/\.000Z$/, "Z"),
        resolvedBy: field(entry, "resolved-by"),
        resolvedOn: day(field(entry, "resolved-on")),
        sources,
        severity: sources.map((s) => s.severity).filter((s): s is HygieneSeverity => s !== null)
          .sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? null,
        fingerprint: parseFingerprint(field(entry, "fingerprint"))?.fingerprint ?? null,
        disposition: recorded && {
          kind: recorded.kind,
          on: recorded.on,
          reason: rawField(entry, "reason") || null,
          fingerprint: recorded.fingerprint?.fingerprint ?? null,
        },
        invalidation: state === "open" ? parseInvalidation(entry) : null,
      });
    }
  }
  return out;
}
