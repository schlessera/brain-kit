/**
 * `supersedes:` frontmatter (#412): on a newer document, the documents it
 * replaces. Each entry is a wiki-link target, written `"[[plan-v1]]"` or bare
 * `plan-v1`, and resolves the way a wiki-link in the body does, aliases
 * included. A superseded document stays searchable and ranks lower
 * (SUPERSEDED_FACTOR); archiving it is a separate decision.
 */
import { extractWikiLinks } from "./indexer/links.js";

/**
 * How much a superseded document's score is multiplied by, after fusion and
 * reranking, in every mode: of the order of a historical document's
 * relevance factor (reranker.ts), so it drops below what replaced it without
 * leaving the results.
 */
export const SUPERSEDED_FACTOR = 0.85;

/**
 * The targets a `supersedes` value names, or null when its shape is wrong
 * (not a string or an array of strings). Absent is `[]`.
 */
export function supersedesTargets(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!entries || entries.some((entry) => typeof entry !== "string")) return null;
  const targets: string[] = [];
  for (const entry of entries as string[]) {
    const text = entry.trim();
    if (!text) continue;
    targets.push(...(text.includes("[[") ? extractWikiLinks(text) : [text.split("|")[0]!.trim()]));
  }
  return [...new Set(targets)];
}
