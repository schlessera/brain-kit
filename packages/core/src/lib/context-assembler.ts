import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "./context.js";
import type { EmbeddingProvider } from "./seams.js";
import { hybridSearch } from "./search-engine.js";
import type { SearchResult } from "./types.js";

interface AssembleOptions {
  query: string;
  maxTokens?: number;
  includeIdentity?: boolean;
  includeCurrentFocus?: boolean;
  /** Embedding provider forwarded to vector search; absent → FTS-only results. */
  embeddings?: EmbeddingProvider;
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

/**
 * Cut `body` at the last paragraph or section boundary that keeps
 * `heading + body + marker` within `budget` tokens. Returns null when not even
 * the heading and the marker fit. A body with no boundary that fits is left
 * out, never cut mid-sentence.
 */
function truncateAtBoundary(heading: string, body: string, marker: string, budget: number): string | null {
  const shell = `${heading}\n${marker}`;
  if (estimateTokens(shell) > budget) return null;
  const paragraphs = body.split(/\n{2,}/);
  let kept = "";
  for (const paragraph of paragraphs) {
    const next = kept ? `${kept}\n\n${paragraph}` : paragraph;
    if (estimateTokens(`${heading}\n${next}\n\n${marker}`) > budget) break;
    kept = next;
  }
  return kept ? `${heading}\n${kept}\n\n${marker}` : shell;
}

/** A search hit's body: no FTS5 highlight markers, and no line that could
 * open a section of the assembled output. */
function cleanSnippet(snippet: string): string {
  return snippet
    .replace(/>>>|<<</g, "")
    .replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "**$1**")
    .trim();
}

function hitHeader(result: SearchResult): string {
  const facts = [`(${result.path})`];
  if (result.updated) facts.push(`updated ${result.updated.slice(0, 10)}`);
  if (result.status) facts.push(result.status);
  const summary = result.summary ? ` — ${result.summary.replace(/\s+/g, " ").trim()}` : "";
  return `### ${result.title} ${facts.join(" · ")}${summary}`;
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
    const { results } = await hybridSearch(
      db,
      { query: opts.query, limit: Math.min(Math.ceil(maxTokens / TOKENS_PER_HIT), CONTEXT_SEARCH_CAP) },
      { embeddings: opts.embeddings, taxonomy: ctx.taxonomy }
    );

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
