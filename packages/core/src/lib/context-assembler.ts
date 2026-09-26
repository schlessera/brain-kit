import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "./context.js";
import type { EmbeddingProvider } from "./seams.js";
import { topLevelBlocks } from "./document-parts.js";
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

/**
 * Cut `body` after the last top-level block (as GFM parses it: a paragraph,
 * a list, a fence, a heading) that keeps `heading + body + marker` within
 * `budget` tokens, so a cut never falls inside a block. Returns null when not
 * even the heading and the marker fit; a body whose first block does not fit
 * is left out, never cut mid-sentence.
 */
function truncateAtBoundary(heading: string, body: string, marker: string, budget: number): string | null {
  const shell = `${heading}\n${marker}`;
  if (estimateTokens(shell) > budget) return null;
  let kept = "";
  for (const block of topLevelBlocks(body)) {
    const text = body.slice(0, block.end).trimEnd();
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
  return blockSafe(snippet.replace(/>>>|<<</g, ""));
}

/**
 * `oneLine`, with a leading character that would start a heading, quote,
 * list, thematic break, fence, table, or link or footnote definition escaped:
 * for text that opens a line or a list item.
 */
function blockSafe(text: string): string {
  return oneLine(text)
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([#>+\-*_=|`~[])/, "\\$1");
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
function readMarkdownContent(root: string, relativePath: string): { body: string; summary: string | null } | null {
  try {
    const fullPath = resolve(root, relativePath);
    const raw = readFileSync(fullPath, "utf-8");
    // Options bypass gray-matter's cache (#142).
    const { content, data } = matter(raw, {});
    // The summary opens a line of the output, so it must not open a block.
    const summary = typeof data.summary === "string" && data.summary.trim() ? blockSafe(data.summary) : null;
    // Leading blank lines and trailing whitespace go; the first line's
    // indentation stays, since it can make that line indented code.
    return { body: content.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd(), summary };
  } catch {
    return null;
  }
}

/**
 * Split a body into its lead (everything before its first top-level `##`
 * heading, setext included) and its sections (each such heading with the
 * source up to the next). Only parsed top-level headings count, so a `##`
 * line inside a fence, a list or a quote does not split.
 */
function splitSections(body: string): { lead: string; sections: string[] } {
  const starts = topLevelBlocks(body)
    .filter((block) => block.type === "heading" && block.depth === 2)
    .map((block) => block.start);
  const bounds = [...starts, body.length];
  return {
    lead: body.slice(0, starts[0] ?? body.length).trimEnd(),
    sections: starts.map((start, i) => body.slice(start, bounds[i + 1]).trimEnd()),
  };
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

  // Identity and focus (#381): the `summary` first, then the whole body when
  // it fits. Otherwise the lead (the text before the first top-level `##`
  // heading), then the `##` sections whole, in order, while they fit, then a
  // pointer to the file. Only a lead that does not fit on its own is cut, after
  // its last whole block that fits. A small budget is never exceeded before
  // search results are considered.
  const pushCanonical = (heading: string, path: string | null): void => {
    const doc = path ? readMarkdownContent(ctx.root, path) : null;
    if (!path || !doc) return;
    // The summary leads whether or not the rest fits.
    const whole = [doc.summary, doc.body].filter((part) => !!part).join("\n\n");
    if (!whole) return;
    if (push(`${heading}\n${whole}`)) {
      included.add(path);
      return;
    }
    const marker = `(truncated — brain read ${path})`;
    const room = budget - (parts.length > 0 ? estimateTokens(SEPARATOR) : 0);
    const { lead, sections } = splitSections(doc.body);
    const hot = [doc.summary, lead].filter((part) => !!part).join("\n\n");
    const fits = (blocks: string[]) => estimateTokens(`${heading}\n${[...blocks, marker].join("\n\n")}`) <= room;
    // Only a lead that overflows on its own is cut at a block boundary.
    if (hot && !fits([hot])) {
      const cut = truncateAtBoundary(heading, hot, marker, room);
      if (cut && push(cut)) included.add(path);
      return;
    }
    const kept = hot ? [hot] : [];
    for (const section of sections) {
      if (!fits([...kept, section])) break;
      kept.push(section);
    }
    if (push(`${heading}\n${[...kept, marker].join("\n\n")}`)) included.add(path);
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

    const hits: string[] = [];
    for (const result of results) {
      if (budget < BUDGET_FLOOR) break;
      if (included.has(result.path)) continue;
      const body = cleanSnippet(result.snippet ?? "");
      const section = body ? `${hitHeader(result)}\n${body}` : hitHeader(result);
      if (push(section)) {
        included.add(result.path);
        hits.push(result.path);
      }
    }

    // Leftover budget goes to the top hits' neighbours: summary lines only,
    // under their own heading so they read as related, not as search hits.
    // Lines are added while the section still fits, so it stops on its own.
    if (hits.length > 0) {
      const lines: string[] = [];
      for (const doc of neighbours(db, hits.slice(0, TOP_HITS_FOR_NEIGHBOURS), included)) {
        const next = `${RELATED_HEADING}\n${[...lines, neighbourLine(doc)].join("\n")}`;
        if (costOf(next) > budget) break;
        lines.push(neighbourLine(doc));
        included.add(doc.path);
      }
      if (lines.length > 0) push(`${RELATED_HEADING}\n${lines.join("\n")}`);
    }
  }

  return parts.join(SEPARATOR);
}

interface NeighbourDoc {
  path: string;
  title: string;
  summary: string | null;
  status: string | null;
}

/** How many of the top hits contribute neighbours. */
const TOP_HITS_FOR_NEIGHBOURS = 3;
const RELATED_HEADING = "### Related";

/** A neighbour as one list item: the title opens the item, so it is made
 * block-safe; path and summary follow inline, flattened to one line. */
function neighbourLine(doc: NeighbourDoc): string {
  const summary = doc.summary ? ` — ${oneLine(doc.summary)}` : "";
  return `- ${blockSafe(doc.title)} (${oneLine(doc.path)})${summary}`;
}

/**
 * The top hits' neighbours, in the order they are offered to the budget:
 * first the nearest `_index.md` in each hit's directory or an ancestor, then
 * the documents one link away from the hits in either direction, the ones
 * more hits link first, then by path. A document already in `exclude` or
 * archived is never offered, and none is offered twice.
 */
function neighbours(db: Database, hits: string[], exclude: Set<string>): NeighbourDoc[] {
  const byPath = db.prepare("SELECT path, title, summary, status FROM documents WHERE path = ?");
  const linked = db.prepare(
    `SELECT d.path, d.title, d.summary, d.status FROM links l
       JOIN documents d ON d.id = l.target_id
       WHERE l.source_id = (SELECT id FROM documents WHERE path = ?1)
     UNION
     SELECT d.path, d.title, d.summary, d.status FROM links l
       JOIN documents d ON d.id = l.source_id
       WHERE l.target_id = (SELECT id FROM documents WHERE path = ?1)`
  );
  const seen = new Set(exclude);
  const offered: NeighbourDoc[] = [];
  const offer = (doc: NeighbourDoc | null | undefined): boolean => {
    if (!doc || seen.has(doc.path) || doc.status === "archived") return false;
    seen.add(doc.path);
    offered.push(doc);
    return true;
  };

  for (const hit of hits) {
    const dirs = hit.split("/").slice(0, -1);
    for (let depth = dirs.length; depth >= 0; depth--) {
      const index = [...dirs.slice(0, depth), "_index.md"].join("/");
      if (index === hit) continue;
      const doc = byPath.get(index) as NeighbourDoc | null;
      if (!doc) continue;
      offer(doc);
      break;
    }
  }

  const counts = new Map<string, { doc: NeighbourDoc; hits: number }>();
  for (const hit of hits) {
    for (const doc of linked.all(hit) as NeighbourDoc[]) {
      const entry = counts.get(doc.path);
      if (entry) entry.hits++;
      else counts.set(doc.path, { doc, hits: 1 });
    }
  }
  const ranked = [...counts.values()].sort(
    (a, b) => b.hits - a.hits || (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0)
  );
  for (const { doc } of ranked) offer(doc);
  return offered;
}
