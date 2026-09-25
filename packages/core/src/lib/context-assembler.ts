import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "./context.js";
import type { EmbeddingProvider } from "./seams.js";
import { hybridSearch } from "./search-engine.js";
import type { SearchResult } from "./types.js";

export interface AssembleOptions {
  query: string;
  maxTokens?: number;
  includeIdentity?: boolean;
  includeCurrentFocus?: boolean;
  /** Embedding provider forwarded to vector search; absent → FTS-only results. */
  embeddings?: EmbeddingProvider;
  /** When given, the search's warnings (a degraded lane, for example) are
   * appended to it, so a caller can report them beside the text. */
  warnings?: string[];
}

/**
 * Rough token estimate: ~4 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Tokens a hit is budgeted from `maxTokens`: the candidate pool is sized so
 * the budget can be filled, up to CONTEXT_SEARCH_CAP results. */
const TOKENS_PER_HIT = 150;
const CONTEXT_SEARCH_CAP = 50;
/** Below this many tokens left, no further section is attempted. */
const BUDGET_FLOOR = 20;

const SEPARATOR = "\n\n";

/** An ATX heading line, or a fence line (``` / ~~~), as CommonMark reads them. */
const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * Cut `body` at the last block boundary that keeps `heading + body + marker`
 * within `budget` tokens. A boundary is a blank line (whitespace-only counts)
 * or the start of a heading, never a point inside a fenced block. A line of
 * only whitespace is blank, which covers the `\r` of a CRLF blank line. Returns
 * null when not even the heading and the marker fit; a body with no boundary
 * that fits is left out, never cut mid-sentence.
 */
function truncateAtBoundary(heading: string, body: string, marker: string, budget: number): string | null {
  const shell = `${heading}\n${marker}`;
  if (estimateTokens(shell) > budget) return null;
  const lines = body.split("\n");
  // cuts[k]: keeping lines[0..k) ends on a block boundary.
  const cuts: number[] = [];
  let inFence = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (!inFence && k > 0 && (line.trim() === "" || HEADING_LINE.test(line))) cuts.push(k);
    if (FENCE_LINE.test(line)) inFence = !inFence;
  }
  let kept = "";
  for (const cut of cuts) {
    const text = lines.slice(0, cut).join("\n").trimEnd();
    if (!text) continue;
    if (estimateTokens(`${heading}\n${text}\n\n${marker}`) > budget) break;
    kept = text;
  }
  return kept ? `${heading}\n${kept}\n\n${marker}` : shell;
}

/**
 * Text as one line of inline content: whitespace runs become single spaces
 * and every `<` is escaped, so no HTML block or comment can start.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/</g, "\\<");
}

/**
 * A search hit's body as contained plain text: one line, no FTS5 highlight
 * markers, and a leading character that would start a heading, quote, list,
 * thematic break, fence or table escaped.
 */
function cleanSnippet(snippet: string): string {
  return oneLine(snippet.replace(/>>>|<<</g, ""))
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([#>+\-*_=|`~])/, "\\$1");
}

/** A hit's one-line header. Every field is flattened to one line, so a
 * multiline title or summary cannot open a section of its own. */
function hitHeader(result: SearchResult): string {
  const facts = [`(${oneLine(result.path)})`];
  if (result.updated) facts.push(`updated ${oneLine(result.updated.slice(0, 10))}`);
  if (result.status) facts.push(oneLine(result.status));
  const summary = result.summary ? ` — ${oneLine(result.summary)}` : "";
  return `### ${oneLine(result.title)} ${facts.join(" · ")}${summary}`;
}

/**
 * Read a markdown file and extract the content after frontmatter.
 * Returns null if the file doesn't exist.
 */
function readMarkdownContent(root: string, relativePath: string): string | null {
  try {
    const fullPath = resolve(root, relativePath);
    const raw = readFileSync(fullPath, "utf-8");
    const { content } = matter(raw);
    return content.trim();
  } catch {
    return null;
  }
}

/**
 * Assemble context for agent consumption by combining identity, current focus,
 * and search results within a token budget.
 *
 * Identity and current-focus locations come from the taxonomy's canonical
 * paths; each section is skipped when its canonical path is unset (null) or the
 * file is missing.
 */
export async function assembleContext(
  db: Database,
  ctx: BrainContext,
  opts: AssembleOptions
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 4000;
  let budget = maxTokens;
  const parts: string[] = [];
  const included = new Set<string>();

  // The separator before a section is part of its cost, so the joined output
  // stays within the budget by estimateTokens.
  const costOf = (section: string) => estimateTokens(parts.length > 0 ? SEPARATOR + section : section);
  const push = (section: string): boolean => {
    const cost = costOf(section);
    if (cost > budget) return false;
    parts.push(section);
    budget -= cost;
    return true;
  };

  // Fixed sections: whole when they fit, else cut at a paragraph boundary with
  // a pointer to the full file, else skipped. A small budget is never exceeded
  // before search results are considered.
  const pushCanonical = (heading: string, path: string | null): void => {
    const body = path ? readMarkdownContent(ctx.root, path) : null;
    if (!path || !body) return;
    if (push(`${heading}\n${body}`)) {
      included.add(path);
      return;
    }
    const separatorCost = parts.length > 0 ? estimateTokens(SEPARATOR) : 0;
    const cut = truncateAtBoundary(heading, body, `(truncated — brain read ${path})`, budget - separatorCost);
    if (cut && push(cut)) included.add(path);
  };

  if (opts.includeIdentity !== false) {
    pushCanonical("## Identity", ctx.taxonomy.canonicalPath("identity"));
  }
  if (opts.includeCurrentFocus !== false) {
    pushCanonical("## Current Focus", ctx.taxonomy.canonicalPath("currentFocus"));
  }

  // Search results: a pool sized to the budget, filled greedily — a hit that
  // does not fit is skipped and the next one tried.
  if (opts.query && budget > BUDGET_FLOOR) {
    const { results, warnings } = await hybridSearch(
      db,
      { query: opts.query, limit: Math.min(Math.ceil(maxTokens / TOKENS_PER_HIT), CONTEXT_SEARCH_CAP) },
      { embeddings: opts.embeddings, taxonomy: ctx.taxonomy }
    );
    opts.warnings?.push(...warnings);

    for (const result of results) {
      if (budget < BUDGET_FLOOR) break;
      if (included.has(result.path)) continue;
      const body = cleanSnippet(result.snippet ?? "");
      const section = body ? `${hitHeader(result)}\n${body}` : hitHeader(result);
      if (push(section)) included.add(result.path);
    }
  }

  return parts.join(SEPARATOR);
}
