/**
 * `supersedes:` frontmatter (#412): on a newer document, the documents it
 * replaces. Each entry is a wiki-link target, written `"[[plan-v1]]"` or bare
 * `plan-v1`, and resolves the way a wiki-link in the body does, aliases
 * included. A superseded document stays searchable and ranks lower
 * (SUPERSEDED_FACTOR); archiving it is a separate decision.
 */

/**
 * How much a superseded document's score is multiplied by, after fusion and
 * reranking, in every mode: of the order of a historical document's
 * relevance factor (reranker.ts), so it drops below what replaced it without
 * leaving the results.
 */
export const SUPERSEDED_FACTOR = 0.85;

/**
 * The targets a `supersedes` value names, or null when it is not a valid one.
 * Absent is `[]`. A value is valid when it is a string, or a non-empty list of
 * strings, and every entry is one complete target: `"[[target]]"` (a label
 * after `|` allowed) or bare `target`. An empty, blank or null entry, an
 * unclosed `[[`, an empty `[[]]`, or several links in one entry is invalid, so
 * a typo is reported instead of silently naming nothing.
 */
export function supersedesTargets(value: unknown): string[] | null {
  if (value === undefined) return [];
  const entries = typeof value === "string" ? [value] : Array.isArray(value) && value.length > 0 ? value : null;
  if (!entries) return null;
  const targets: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return null;
    const text = entry.trim();
    const linked = /^\[\[([^[\]]*)\]\]$/.exec(text);
    const inner = linked ? linked[1]! : text;
    if (!linked && /[[\]]/.test(text)) return null;
    const target = inner.split("|")[0]!.trim();
    if (!target) return null;
    targets.push(target);
  }
  return [...new Set(targets)];
}
