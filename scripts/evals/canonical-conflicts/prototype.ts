// Private report-only #843 controls. No production registration or replacement writer.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { getMarkdownFiles } from "../../../packages/core/src/lib/indexer";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import { frontmatterLength, topLevelBlocks } from "../../../packages/core/src/lib/document-parts";
import { safeResolve } from "../../../packages/core/src/lib/safe-path";
import { hygieneId, type HygieneCandidate } from "../../../packages/core/src/lib/hygiene";
import type { Taxonomy } from "../../../packages/core/src/lib/taxonomy";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export interface Span { start: number; end: number; text: string; field: string; value: string }
export interface Snapshot { path: string; raw: string; hash: string; updated: string; spans: Span[] }
export interface Pair { key: string; canonical: Snapshot; secondary: Snapshot; anchor: Span; restatement: Span }
const answer = z.object({ sameSubject: z.enum(["yes", "no", "unknown"]), contradiction: z.enum(["yes", "no", "unknown"]) }).strict();
export type Judge = (a: { document: string; span: Span }, b: { document: string; span: Span }) => Promise<unknown>;

function day(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? n : null;
}

function decimal(value: string): string | null {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const integer = whole!.replace(/^0+(?=\d)/, ""); const tail = fraction.replace(/0+$/, "");
  return `${value.startsWith("-") && (integer !== "0" || tail) ? "-" : ""}${integer}${tail ? `.${tail}` : ""}`;
}

/** Draft grammar: top-level `Subject | Field | Value` or `Subject: Field = Value`. */
export function extract(raw: string): Span[] {
  const offset = frontmatterLength(raw); const body = raw.slice(offset); const spans: Span[] = [];
  for (const block of topLevelBlocks(body).filter(b => b.type === "paragraph")) {
    const part = body.slice(block.start, block.end);
    for (const m of part.matchAll(/^[^\r\n]+/gm)) {
      const text = m[0];
      const parsed = /^(?:[^|\n]+ \| (Role|Status|Date|Count|Employer) \| ([^|\n]+)|[^:\n]+: (Role|Status|Date|Count|Employer) = ([^\n]+))$/.exec(text);
      if (!parsed || text.length > 240 || /[`<>]/.test(text)) continue;
      const start = offset + block.start + m.index!;
      spans.push({ start, end: start + text.length, text, field: parsed[1] ?? parsed[3]!, value: parsed[2] ?? parsed[4]! });
    }
  }
  return spans;
}

function read(root: string, taxonomy: Taxonomy, path: string, asOf: string, canonical: boolean): Snapshot | null {
  if (taxonomy.isExcludedPath(path) || path.startsWith("context/hygiene/") || path.split("/").some(p => ["archive", "archived"].includes(p))) return null;
  const inbox = taxonomy.types[taxonomy.inboxType()]!.dir;
  if (inbox && (path === inbox || path.startsWith(`${inbox}/`))) return null;
  const full = safeResolve(root, path); if (!full) return null;
  try {
    const raw = readFileSync(full, "utf8"); const data = parseFrontmatter(raw).data;
    if (data.status === "archived" || data.relevance === "historical" || !Object.hasOwn(taxonomy.types, String(data.type))) return null;
    // Conservative draft treatment: any facts_ignore is a manual case, not a new unkeyed mapping.
    if (data.facts_ignore !== undefined || (canonical && data.facts !== undefined)) return null;
    const literal = /^updated:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m.exec(raw.slice(0, frontmatterLength(raw)))?.[1];
    const updatedText = data.updated instanceof Date ? data.updated.toISOString().slice(0, 10) : data.updated;
    const updated = day(updatedText); const now = day(asOf);
    if (literal !== updatedText) return null;
    if (updated === null || now === null || updated > now) return null;
    return { path, raw, hash: sha(raw), updated: updatedText, spans: extract(raw) };
  } catch { return null; }
}

/** Private evaluation reader shared by baseline-output provenance checks. */
export function eligibleSnapshot(root: string, taxonomy: Taxonomy, path: string, asOf: string, canonical: boolean) {
  return read(root, taxonomy, path, asOf, canonical);
}

export function pairs(root: string, taxonomy: Taxonomy, asOf: string): Pair[] {
  const out: Pair[] = []; const paths = getMarkdownFiles(root, taxonomy);
  const canonicalPaths = new Set(Object.keys(taxonomy.canonical).map(k => taxonomy.canonicalPath(k)).filter(Boolean));
  for (const key of Object.keys(taxonomy.canonical)) {
    const path = taxonomy.canonicalPath(key); if (!path) continue;
    const canonical = read(root, taxonomy, path, asOf, true); if (!canonical) continue;
    for (const other of paths.filter(p => !canonicalPaths.has(p))) {
      const secondary = read(root, taxonomy, other, asOf, false); if (!secondary) continue;
      for (const anchor of canonical.spans) for (const restatement of secondary.spans) {
        if (anchor.field === restatement.field) out.push({ key, canonical, secondary, anchor, restatement });
      }
    }
  }
  return out;
}

function provenance(root: string, pair: Pair): boolean {
  return [pair.canonical, pair.secondary].every(s => {
    const full = safeResolve(root, s.path); if (!full) return false;
    try { return sha(readFileSync(full, "utf8")) === s.hash && sha(s.raw) === s.hash; } catch { return false; }
  }) && pair.canonical.raw.slice(pair.anchor.start, pair.anchor.end) === pair.anchor.text
    && pair.secondary.raw.slice(pair.restatement.start, pair.restatement.end) === pair.restatement.text
    && ([[pair.canonical, pair.anchor], [pair.secondary, pair.restatement]] as const).every(([s, span]) =>
      extract(s.raw).some(x => JSON.stringify(x) === JSON.stringify(span)));
}

/** Narrow experiment-only arithmetic premise, taken from explicit source lines.
 * Different numbers/dates are not conflicts without one shared single-valued
 * attribute at one observation time and event. This is no production schema.
 */
function arithmeticScope(snapshot: Snapshot, span: Span, asOf: string): string | null {
  const offset = frontmatterLength(snapshot.raw), body = snapshot.raw.slice(offset);
  const lines = topLevelBlocks(body).filter(b => b.type === "paragraph")
    .flatMap(b => body.slice(b.start, b.end).split(/\r?\n/));
  const labels = ["Subject", "Attribute", "Observation date", "Event scope", "Cardinality"];
  const values: string[] = [];
  for (const label of labels) {
    const matches = lines.filter(line => line.startsWith(`${label}: `));
    if (matches.length !== 1) return null;
    const value = matches[0]!.slice(label.length + 2);
    if (!value.trim() || value !== value.trim() || /[`<>]/.test(value)) return null;
    values.push(value);
  }
  const subject = span.text.includes(" | ") ? span.text.split(" | ")[0] : span.text.split(": ")[0];
  const observed = day(values[2]), now = day(asOf);
  if (values[0] !== subject || values[4] !== "single-valued" || observed === null || now === null || observed > now) return null;
  return JSON.stringify(values);
}

function commonArithmeticScope(pair: Pair, asOf: string): boolean {
  const left = arithmeticScope(pair.canonical, pair.anchor, asOf);
  return left !== null && left === arithmeticScope(pair.secondary, pair.restatement, asOf);
}

/** Both orientations affirm the subject; code owns literal value comparisons and authority. */
export async function inspect(root: string, taxonomy: Taxonomy, pair: Pair, asOf: string, judge: Judge) {
  if (taxonomy.canonicalPath(pair.key) !== pair.canonical.path) return null;
  const freshCanonical = read(root, taxonomy, pair.canonical.path, asOf, true);
  const freshSecondary = read(root, taxonomy, pair.secondary.path, asOf, false);
  if (!freshCanonical || !freshSecondary) return null;
  const gap = (day(freshCanonical.updated)! - day(freshSecondary.updated)!) / 86_400_000;
  if (gap < 7) return null;
  try {
    const a = { document: pair.canonical.raw, span: pair.anchor }, b = { document: pair.secondary.raw, span: pair.restatement };
    const forward = answer.safeParse(await judge(a, b)); const reverse = answer.safeParse(await judge(b, a));
    if (!forward.success || !reverse.success) return null;
    if (forward.data.sameSubject !== "yes" || reverse.data.sameSubject !== "yes") return null;
    // Exact numeric/calendar differences belong to code after a common literal
    // attribute/time/event and single-valued premise; same entity is insufficient.
    if (pair.anchor.field === "Count") {
      if (!commonArithmeticScope(pair, asOf)) return null;
      const a = decimal(pair.anchor.value), b = decimal(pair.restatement.value);
      if (a === null || b === null || a === b) return null;
    } else if (pair.anchor.field === "Date") {
      if (!commonArithmeticScope(pair, asOf)) return null;
      const a = day(pair.anchor.value), b = day(pair.restatement.value);
      if (a === null || b === null || a === b) return null;
    } else if (forward.data.contradiction !== "yes" || reverse.data.contradiction !== "yes") return null;
    if (!provenance(root, pair)) return null;
    if (taxonomy.canonicalPath(pair.key) !== pair.canonical.path) return null;
    const candidate: HygieneCandidate = { category: "conflict", path: pair.secondary.path, evidence: pair.anchor.text,
      message: `${pair.restatement.text} disagrees with ${pair.canonical.path}: ${pair.anchor.text}` };
    // Inspection only; #597 still owns approved category fingerprints and dispositions.
    const evidenceDigest = sha(JSON.stringify([pair.key, pair.canonical.path, pair.anchor.text, pair.secondary.path, pair.restatement.text]));
    return { candidate, id: hygieneId(candidate.category, candidate.path, candidate.evidence), evidenceDigest,
      provenance: { canonical: pair.anchor, secondary: pair.restatement }, replacement: null };
  } catch { return null; }
}
