import { actualWriteDayUTC, assertWriteDayUTC } from "./write-day";
/** Private offline prototype for #842; no production command or agent integration. */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import { editFrontmatter } from "../../../packages/core/src/lib/frontmatter-edit";
import { isoDay } from "../../../packages/core/src/lib/auditor";
import { getMarkdownFiles } from "../../../packages/core/src/lib/indexer";
import { replaceIfUnchanged, type Detection } from "../../../packages/core/src/lib/hygiene";
import type { Taxonomy } from "../../../packages/core/src/lib/taxonomy";
import { VALID_STATUSES } from "../../../packages/core/src/lib/types";

export interface Input { path: string; raw: string; mtimeMs: number; data: Record<string, unknown> }
export interface Edit { path: string; before: string; after: string; kind: "dates" | "table" }
export interface Plan { inputs: Input[]; edits: Edit[]; refused: Array<{ path: string; reason: string }> }

/** Reject aliases and traversal before reading, including symlinked parent directories. */
function regularPath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("noncanonical path");
  let full = realpathSync(root);
  for (const [i, part] of path.split("/").entries()) {
    full = join(full, part);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink() || (i === path.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("not a regular contained file");
  }
  return full;
}

export function capture(root: string, taxonomy: Taxonomy): Input[] {
  return getMarkdownFiles(root, taxonomy).map(path => {
    const full = regularPath(root, path);
    const raw = readFileSync(full, "utf8");
    return { path, raw, mtimeMs: statSync(full).mtimeMs, data: parseFrontmatter(raw).data };
  });
}

export function excluded(input: Input, taxonomy: Taxonomy): boolean {
  const inbox = taxonomy.dirForType(taxonomy.inboxType());
  return taxonomy.isExcludedPath(input.path) || input.data.status === "archived" ||
    input.path.split("/").includes("archived") || input.path.startsWith("context/hygiene/") ||
    Boolean(inbox && (input.path === inbox || input.path.startsWith(`${inbox}/`)));
}

function date(value: unknown): string | null {
  const text = value instanceof Date && Number.isFinite(value.getTime()) ? isoDay(value.getTime()) : value;
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    Number.isFinite(Date.parse(text)) && isoDay(Date.parse(text)) === text ? text : null;
}

function sourceDate(input: Input, key: "created" | "updated"): string | null {
  const match = new RegExp(`^${key}:[ \\t]+(?:"(\\d{4}-\\d{2}-\\d{2})"|'(\\d{4}-\\d{2}-\\d{2})'|(\\d{4}-\\d{2}-\\d{2}))[ \\t]*(?:#.*)?\\r?$`, "m").exec(input.raw);
  const lexical = match?.slice(1).find(Boolean);
  return lexical && date(lexical) === lexical && date(input.data[key]) === lexical ? lexical : null;
}

interface Node { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const markdown = unified().use(remarkParse).use(remarkGfm);

/** Intentionally narrow: top-level plain pipe tables and one explicit relative markdown link. */
function repairTables(input: Input, inputs: Input[], taxonomy: Taxonomy, detected: Detection): { text: string; reason?: string } {
  const findings = detected.candidates.filter(c => c.path === input.path && c.category === "index-lag");
  if (!findings.length) return { text: input.raw };
  if (input.data.registry !== undefined || input.raw.includes("<!-- brain:generated:")) return { text: input.raw, reason: "generated registry ownership" };
  const ast = markdown.parse(input.raw) as Node;
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const seen = new Set<string>();
  const matched = new Set<string>();
  for (const table of (ast.children ?? []).filter(n => n.type === "table")) {
    const [header, ...rows] = table.children ?? [];
    const cells = (n: Node) => (n.children ?? []).map(c => {
      const children = c.children ?? [];
      const start = children[0]?.position?.start.offset, end = children.at(-1)?.position?.end.offset;
      return start === undefined || end === undefined ? "" : input.raw.slice(start, end).trim();
    });
    const names = header ? cells(header).map(s => s.toLowerCase()) : [];
    if (!names.includes("status") || !names.includes("updated")) continue;
    if (new Set(names).size !== names.length || names.some(n => !["link", "status", "updated", "title"].includes(n))) return { text: input.raw, reason: "unknown or duplicate columns" };
    const linkCol = names.indexOf("link"), statusCol = names.indexOf("status"), updatedCol = names.indexOf("updated");
    if (linkCol < 0) return { text: input.raw, reason: "no explicit link column" };
    for (const row of rows) {
      const values = cells(row);
      const link = /^\[[^\]\n]+\]\(([^()\s#%]+\.md)\)$/.exec(values[linkCol] ?? "");
      if (!link || /^[a-z]+:/i.test(link[1]) || link[1].startsWith("/") || link[1].includes("\\")) return { text: input.raw, reason: "ambiguous link" };
      const target = posix.normalize(posix.join(posix.dirname(input.path), link[1]));
      if (seen.has(target)) return { text: input.raw, reason: "duplicate linked target" };
      seen.add(target);
      const detail = inputs.find(d => d.path === target);
      if (!detail || excluded(detail, taxonomy)) return { text: input.raw, reason: "missing or excluded detail" };
      const updated = sourceDate(detail, "updated"), rowUpdated = date(values[updatedCol]);
      if (!updated || !rowUpdated) return { text: input.raw, reason: "invalid date" };
      if (updated <= rowUpdated) continue;
      if (!findings.some(c => c.evidence === values[linkCol])) return { text: input.raw, reason: "detection and row disagree" };
      matched.add(values[linkCol]);
      const status = detail.data.status;
      const titleCol = names.indexOf("title");
      if (typeof status !== "string" || !VALID_STATUSES.some(value => value === status) ||
        !VALID_STATUSES.some(value => value === values[statusCol]) ||
        (titleCol >= 0 && values[titleCol] !== detail.data.title)) return { text: input.raw, reason: "multiple differing columns or unsupported value" };
      if (values[statusCol] === status) return { text: input.raw, reason: "Updated-only drift is outside Phase 3's Status repair" };
      const start = row.position?.start.offset, end = row.position?.end.offset;
      if (start === undefined || end === undefined) return { text: input.raw, reason: "missing source positions" };
      const line = input.raw.slice(start, end);
      if (!line.startsWith("|") || !line.endsWith("|") || line.includes("\\") || line.includes("\n")) return { text: input.raw, reason: "unsupported row syntax" };
      const parts = line.split("|");
      if (parts.length !== names.length + 2) return { text: input.raw, reason: "ambiguous delimiters" };
      const set = (column: number, value: string) => { parts[column + 1] = parts[column + 1].replace(/^(\s*)\S[\s\S]*?(\s*)$/, `$1${value}$2`); };
      set(statusCol, status); set(updatedCol, updated);
      replacements.push({ start, end, text: parts.join("|") });
    }
  }
  if (findings.some(c => !matched.has(c.evidence))) return { text: input.raw, reason: "unmatched detected row" };
  let text = input.raw;
  for (const r of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + r.text + text.slice(r.end);
  return { text };
}

export function plan(inputs: Input[], taxonomy: Taxonomy, detected: Detection, today: string): Plan {
  const result: Plan = { inputs, edits: [], refused: [] };
  if (detected.failedChecks.length) return { ...result, refused: [{ path: "(brain)", reason: `failed checks: ${detected.failedChecks.join(", ")}` }] };
  for (const input of inputs) {
    if (excluded(input, taxonomy)) continue;
    const created = sourceDate(input, "created"), updated = sourceDate(input, "updated");
    if (!created || !updated) { result.refused.push({ path: input.path, reason: "non-date-only frontmatter" }); continue; }
    // Registry ownership applies to date repairs too; no partial rewrite of an index.
    if (input.data.registry !== undefined || input.raw.includes("<!-- brain:generated:")) {
      result.refused.push({ path: input.path, reason: "generated registry ownership" }); continue;
    }
    const table = repairTables(input, inputs, taxonomy, detected);
    if (table.reason) { result.refused.push({ path: input.path, reason: table.reason }); continue; }
    let next = table.text;
    let kind: Edit["kind"] = "table";
    if (updated < created) {
      const later = [created, updated, isoDay(input.mtimeMs)].sort().at(-1)!;
      const edited = editFrontmatter(next, { created: later, updated: later });
      if (edited === null) { result.refused.push({ path: input.path, reason: "frontmatter cannot be edited without reserialization" }); continue; }
      next = edited; kind = "dates";
    } else if (next !== input.raw) {
      const edited = editFrontmatter(next, { updated: [updated, today].sort().at(-1)! });
      if (edited === null) { result.refused.push({ path: input.path, reason: "frontmatter cannot be edited without reserialization" }); continue; }
      next = edited;
    }
    if (next !== input.raw) result.edits.push({ path: input.path, before: input.raw, after: next, kind });
  }
  return result;
}

export interface ApplyResult { written: string[]; stale: string[]; error?: string }

/** Preflight the complete captured input, including read-only detail files and date mtimes. */
export function apply(root: string, proposal: Plan, dryRun = false, writeDayUTC = actualWriteDayUTC()): ApplyResult {
  assertWriteDayUTC(writeDayUTC);
  const stale = proposal.inputs.filter(input => {
    try {
      const full = regularPath(root, input.path);
      return readFileSync(full, "utf8") !== input.raw || statSync(full).mtimeMs !== input.mtimeMs;
    } catch { return true; }
  }).map(d => d.path);
  if (stale.length || dryRun) return { written: [], stale };
  const written: Edit[] = [];
  try {
    for (const edit of proposal.edits) {
      assertWriteDayUTC(writeDayUTC);
      replaceIfUnchanged(regularPath(root, edit.path), edit.after, edit.before, () => assertWriteDayUTC(writeDayUTC));
      written.push(edit);
    }
    return { written: written.map(e => e.path), stale: [] };
  } catch (error) {
    // Best-effort rollback while each file still contains our bytes; this is not a crash-safe transaction.
    for (const edit of written.reverse()) {
      try { assertWriteDayUTC(writeDayUTC); replaceIfUnchanged(regularPath(root, edit.path), edit.before, edit.after, () => assertWriteDayUTC(writeDayUTC)); } catch { /* Report surviving writes below. */ }
    }
    return { written: written.filter(e => readFileSync(join(root, e.path), "utf8") === e.after).map(e => e.path), stale: [], error: String(error) };
  }
}
