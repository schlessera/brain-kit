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
  return blockSafe(snippet.replace(/>>>|<<</g, ""));
}

/**
 * `oneLine`, with a leading character that would start a heading, quote,
 * list, thematic break, fence or table escaped: for text that opens a line or
 * a list item.
 */
function blockSafe(text: string): string {
  return oneLine(text)
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
function readMarkdownContent(root: string, relativePath: string): { body: string; summary: string | null } | null {
  try {
    const fullPath = resolve(root, relativePath);
    const raw = readFileSync(fullPath, "utf-8");
    const { content, data } = matter(raw);
    const summary = typeof data.summary === "string" && data.summary.trim() ? oneLine(data.summary) : null;
    return { body: content.trim(), summary };
  } catch {
    return null;
  }
}

/** A `#` or `##` heading line: what ends a document's lead and starts a section. */
const SECTION_LINE = /^ {0,3}#{1,2}(?:[ \t]|$)/;

/**
 * Split a body into its lead (everything before the first `#`/`##` heading)
 * and its sections (each heading with the text up to the next one). A heading
 * inside a fenced block does not split.
 */
function splitSections(body: string): { lead: string; sections: string[] } {
  const lines = body.split("\n");
  const starts: number[] = [];
  let inFence = false;
  for (let k = 0; k < lines.length; k++) {
    if (!inFence && SECTION_LINE.test(lines[k]!)) starts.push(k);
    if (FENCE_LINE.test(lines[k]!)) inFence = !inFence;
  }
  const bounds = [...starts, lines.length];
  return {
    lead: lines.slice(0, starts[0] ?? lines.length).join("\n").trim(),
    sections: starts.map((start, i) => lines.slice(start, bounds[i + 1]).join("\n").trim()),
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

  // Fixed sections: whole when they fit, else cut at a paragraph boundary with
  // a pointer to the full file, else skipped. A small budget is never exceeded
  // before search results are considered.
  // A document that does not fit leads with its hot part (#381): its
  // `summary` and the lead before its first `#`/`##` heading, then its
  // sections whole, in order, while they fit. A lead that does not fit on its
  // own is cut at a block boundary.
  const pushCanonical = (heading: string, path: string | null): void => {
    const doc = path ? readMarkdownContent(ctx.root, path) : null;
    if (!path || !doc || !doc.body) return;
    if (push(`${heading}\n${doc.body}`)) {
      included.add(path);
      return;
    }
    const marker = `(truncated — brain read ${path})`;
    const room = budget - (parts.length > 0 ? estimateTokens(SEPARATOR) : 0);
    const { lead, sections } = splitSections(doc.body);
    const hot = [doc.summary, lead].filter((part): part is string => !!part && part !== "").join("\n\n");
    const fits = (blocks: string[]) => estimateTokens(`${heading}\n${blocks.join("\n\n")}\n\n${marker}`) <= room;
    if (!hot || !fits([hot])) {
      const cut = truncateAtBoundary(heading, hot || doc.body, marker, room);
      if (cut && push(cut)) included.add(path);
      return;
    }
    const kept = [hot];
    for (const section of sections) {
      if (!fits([...kept, section])) break;
      kept.push(section);
    }
    if (push(`${heading}\n${kept.join("\n\n")}\n\n${marker}`)) included.add(path);
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
