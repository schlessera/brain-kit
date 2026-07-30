import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "./context.js";
import type { EmbeddingProvider } from "./seams.js";
import { hybridSearch } from "./search-engine.js";

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
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

  // Fixed sections respect the budget too: fit whole, else truncate into the
  // remaining budget, else skip — small --max-tokens must never be exceeded
  // before search results are even considered.
  const pushWithinBudget = (section: string): void => {
    const cost = estimateTokens(section);
    if (cost <= budget) {
      parts.push(section);
      budget -= cost;
      return;
    }
    if (budget >= 50) {
      parts.push(section.slice(0, budget * 4 - 2).trimEnd() + " …");
      budget = 0;
    }
  };

  // 1. Identity section
  if (opts.includeIdentity !== false) {
    const identityPath = ctx.taxonomy.canonicalPath("identity");
    const identity = identityPath ? readMarkdownContent(ctx.root, identityPath) : null;
    if (identity) {
      pushWithinBudget(`## Identity\n${identity.slice(0, 500)}`);
    }
  }

  // 2. Current focus section
  if (opts.includeCurrentFocus !== false) {
    const focusPath = ctx.taxonomy.canonicalPath("currentFocus");
    const focus = focusPath ? readMarkdownContent(ctx.root, focusPath) : null;
    if (focus) {
      pushWithinBudget(`## Current Focus\n${focus.slice(0, 800)}`);
    }
  }

  // 3. Search results
  if (opts.query && budget > 200) {
    const { results } = await hybridSearch(
      db,
      { query: opts.query, limit: 10 },
      { embeddings: opts.embeddings }
    );

    for (const result of results) {
      const section = `\n### ${result.title} (${result.path})\n${result.snippet}`;
      const cost = estimateTokens(section);

      if (budget - cost < 0) break;

      parts.push(section);
      budget -= cost;
    }
  }

  return parts.join("\n\n");
}
