import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "./context.js";
import type { EmbeddingProvider } from "./seams.js";
import { topLevelBlocks } from "./document-parts.js";
import { chunkMatchLine, hybridSearch } from "./search-engine.js";
import type { ChunkMatch, SearchResult } from "./types.js";

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
  /** The moment search measures recency from; defaults to the wall clock.
   * `brain eval --context` pins it so a run is reproducible. */
  now?: Date;
  /** When given, filled with the paths the output includes, per section, so
   * a caller (`brain eval --context`) need not parse the markdown back. */
  report?: AssembleReport;
}

/** Which documents an assembled context includes, and where. */
export interface AssembleReport {
  /** The canonical identity document, when its section (whole or cut) is in. */
  identity: string | null;
  /** The canonical current-focus document, when its section is in. */
  focus: string | null;
  /** Search hits, in output order. */
  results: string[];
  /** `### Related` neighbours, summary lines only, in output order. */
  related: string[];
}

/** An empty report, for callers that pass `report`. */
export function emptyAssembleReport(): AssembleReport {
  return { identity: null, focus: null, results: [], related: [] };
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
function truncateAtBoundary(
  heading: string,
  body: string,
  marker: string,
  budget: number,
  cost: (text: string) => number = estimateTokens
): string | null {
  const shell = `${heading}\n${marker}`;
  if (cost(shell) > budget) return null;
  let kept = "";
  for (const block of topLevelBlocks(body)) {
    const text = body.slice(0, block.end).trimEnd();
    if (cost(`${heading}\n${text}\n\n${marker}`) > budget) break;
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
 * Identity or current focus (#381), read for placing: the summary leads,
 * then the whole body when it fits. Otherwise the lead (the text before the
 * first top-level `##` heading), then the `##` sections whole, in order, while
 * they fit, then a pointer to the file. Only a lead that does not fit on its
 * own is cut, after its last whole block that fits.
 */
interface Canonical {
  slot: "identity" | "focus";
  path: string;
  heading: string;
  /** The heading, summary and whole body. */
  whole: string;
  /** The summary and lead. */
  hot: string;
  sections: string[];
  marker: string;
}

const CANONICAL_HEADINGS = { identity: "## Identity", focus: "## Current Focus" } as const;

/** A canonical document, or null when its path is unset, the file is missing, or it has no text. */
function loadCanonical(root: string, slot: Canonical["slot"], path: string | null): Canonical | null {
  const doc = path ? readMarkdownContent(root, path) : null;
  if (!path || !doc) return null;
  const heading = CANONICAL_HEADINGS[slot];
  // The summary leads whether or not the rest fits.
  const text = [doc.summary, doc.body].filter((part) => !!part).join("\n\n");
  if (!text) return null;
  const { lead, sections } = splitSections(doc.body);
  const hot = [doc.summary, lead].filter((part) => !!part).join("\n\n");
  return { slot, path, heading, whole: `${heading}\n${text}`, hot, sections, marker: `(truncated — brain read ${path})` };
}

/**
 * The most of a canonical document that fits `room` tokens, or null when not
 * even its heading and pointer fit. `cost` is what a form would cost where it
 * goes, separator included, rounded as one text the way `push` charges it.
 */
function canonicalForm(doc: Canonical, room: number, cost: (text: string) => number): string | null {
  if (cost(doc.whole) <= room) return doc.whole;
  const { heading, hot, marker } = doc;
  const fits = (blocks: string[]) => cost(`${heading}\n${[...blocks, marker].join("\n\n")}`) <= room;
  // Only a lead that overflows on its own is cut at a block boundary.
  if (hot && !fits([hot])) return truncateAtBoundary(heading, hot, marker, room, cost);
  const kept = hot ? [hot] : [];
  for (const section of doc.sections) {
    if (!fits([...kept, section])) break;
    kept.push(section);
  }
  return fits(kept) ? `${heading}\n${[...kept, marker].join("\n\n")}` : null;
}

/**
 * A canonical document's minimal form (#518): the summary and lead with the
 * pointer, or the whole document when that is shorter. It does not depend on
 * the budget, so what it leaves for search hits grows with the budget.
 */
function minimalForm(doc: Canonical): string {
  const lead = `${doc.heading}\n${[...(doc.hot ? [doc.hot] : []), doc.marker].join("\n\n")}`;
  return estimateTokens(doc.whole) <= estimateTokens(lead) ? doc.whole : lead;
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

  const canonicals = [
    opts.includeIdentity !== false ? loadCanonical(ctx.root, "identity", ctx.taxonomy.canonicalPath("identity")) : null,
    opts.includeCurrentFocus !== false ? loadCanonical(ctx.root, "focus", ctx.taxonomy.canonicalPath("currentFocus")) : null,
  ].filter((doc): doc is Canonical => doc !== null);

  // Monotone in the budget (#518): search hits are placed against what is
  // left after each canonical document's minimal form, and only the budget
  // left after the hits grows those documents towards their whole body. When
  // the minimal forms do not all fit, the canonical documents fill the budget
  // on their own, as much of each as fits, and no hit is placed: a hit placed
  // then would be pushed out again as a cut lead grows with the budget.
  const minimal = canonicals.map(minimalForm);
  const minimalFits = minimal.reduce((sum, form, i) => sum + estimateTokens(i > 0 ? SEPARATOR + form : form), 0) <= maxTokens;
  const placed: Array<{ doc: Canonical; index: number }> = [];
  for (const [i, doc] of canonicals.entries()) {
    const form = minimalFits ? minimal[i]! : canonicalForm(doc, budget, costOf);
    if (form !== null && push(form)) {
      included.add(doc.path);
      placed.push({ doc, index: parts.length - 1 });
      if (opts.report) opts.report[doc.slot] = doc.path;
    }
  }

  // Leftover budget after the hits grows each canonical document, identity
  // first, from its minimal form towards its whole body. It runs once, before
  // the related lines take what is left.
  let grown = false;
  const growCanonicals = () => {
    if (grown) return;
    grown = true;
    for (const { doc, index } of placed) {
      const cost = (text: string) => estimateTokens(index > 0 ? SEPARATOR + text : text);
      const current = parts[index]!;
      const form = canonicalForm(doc, budget + cost(current), cost);
      // Growth only ever adds: a form no longer than the placed one stays out.
      if (form === null || form.length <= current.length) continue;
      budget -= cost(form) - cost(current);
      parts[index] = form;
    }
  };

  // Search results: a pool sized to the budget, filled greedily — a hit that
  // does not fit is skipped and the next one tried.
  if (opts.query && minimalFits && budget > BUDGET_FLOOR) {
    const { results, warnings } = await hybridSearch(
      db,
      { query: opts.query, limit: Math.min(Math.ceil(maxTokens / TOKENS_PER_HIT), CONTEXT_SEARCH_CAP), now: opts.now, chunks: true },
      { embeddings: opts.embeddings, taxonomy: ctx.taxonomy }
    );
    opts.warnings?.push(...warnings);

    const hits: string[] = [];
    // One hit may take this much of the budget, as a snippet or a section, so
    // a long section cannot crowd out every other hit.
    const hitCap = Math.floor(maxTokens * SECTION_BUDGET_SHARE);
    // Monotone in the budget, as the canonical documents are (#518): every
    // hit is first placed as its one-line snippet, whose size does not depend
    // on the budget, and only the budget left after all of them grows each
    // one, in rank order, into its best chunk's section. A hit whose section
    // would fit a larger budget therefore never pushes out a later hit.
    const placedHits: Array<{ result: SearchResult; index: number }> = [];
    for (const result of results) {
      if (budget < BUDGET_FLOOR) break;
      if (included.has(result.path)) continue;
      const body = cleanSnippet(result.snippet ?? "");
      const snippet = body ? `${hitHeader(result)}\n${body}` : hitHeader(result);
      if (estimateTokens(snippet) <= hitCap && push(snippet)) {
        included.add(result.path);
        hits.push(result.path);
        placedHits.push({ result, index: parts.length - 1 });
        opts.report?.results.push(result.path);
      }
    }
    for (const { result, index } of placedHits) {
      const best = result.chunks?.[0];
      if (!best) continue;
      const cost = (text: string) => estimateTokens(index > 0 ? SEPARATOR + text : text);
      const current = parts[index]!;
      // Within the cap and what is left, with this hit's snippet given back.
      const room = Math.min(hitCap, budget + cost(current) - (index > 0 ? estimateTokens(SEPARATOR) : 0));
      const section = hitSection(result, best, chunkMatchLine(db, opts.query, result.path, best.chunk_index), ctx.root, room);
      if (section === null || cost(section) - cost(current) > budget) continue;
      budget -= cost(section) - cost(current);
      parts[index] = section;
    }

    growCanonicals();

    // Leftover budget goes to the top hits' neighbours: summary lines only,
    // under their own heading so they read as related, not as search hits.
    // Lines are added while the section still fits, so it stops on its own.
    if (hits.length > 0) {
      const lines: string[] = [];
      const relatedPaths: string[] = [];
      for (const doc of neighbours(db, hits.slice(0, TOP_HITS_FOR_NEIGHBOURS), included)) {
        const next = `${RELATED_HEADING}\n${[...lines, neighbourLine(doc)].join("\n")}`;
        if (costOf(next) > budget) break;
        lines.push(neighbourLine(doc));
        relatedPaths.push(doc.path);
        included.add(doc.path);
      }
      if (lines.length > 0 && push(`${RELATED_HEADING}\n${lines.join("\n")}`)) {
        opts.report?.related.push(...relatedPaths);
      }
    }
  }

  growCanonicals();

  return parts.join(SEPARATOR);
}

/** The largest share of the budget one hit's section may take. */
const SECTION_BUDGET_SHARE = 0.4;

/** A heading block's text: an ATX heading without its `#` markers, or a setext heading's lines joined. */
function headingBlockText(source: string): string {
  const lines = source.split("\n");
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(lines[0]!)) {
    return lines[0]!.replace(/^ {0,3}#{1,6}[ \t]*/, "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
  }
  return lines.slice(0, -1).map((line) => line.trim()).join(" ");
}

/**
 * Every top-level heading of `text`, ATX or setext, rewritten as an ATX
 * heading at level 5 or deeper (its own level plus two, at most 6), so a
 * section cannot open a heading at the output's `##`/`###`/`####` levels. The
 * parse decides what a heading is, so a `#` line in code or a quote is left
 * as it is.
 */
function demoteHeadings(text: string): string {
  let out = "";
  let at = 0;
  for (const block of topLevelBlocks(text)) {
    if (block.type !== "heading") continue;
    const depth = Math.min(6, Math.max(5, (block.depth ?? 1) + 2));
    out += `${text.slice(at, block.start)}${"#".repeat(depth)} ${headingBlockText(text.slice(block.start, block.end))}`;
    at = block.end;
  }
  return out + text.slice(at);
}

/** How a type 1–5 HTML block (CommonMark 4.6) that opens `source` ends, if it does not already. */
function openHtmlTerminator(source: string): string | null {
  const start = source.trimStart();
  const kinds: Array<[RegExp, string]> = [
    [/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i, ""],
    [/^<!--/, "-->"],
    [/^<\?/, "?>"],
    [/^<![A-Za-z]/, ">"],
    [/^<!\[CDATA\[/, "]]>"],
  ];
  for (const [opens, end] of kinds) {
    if (!opens.test(start)) continue;
    const terminator = end || `</${/^<([a-z]+)/i.exec(start)![1]!.toLowerCase()}>`;
    return source.toLowerCase().includes(terminator.toLowerCase()) ? null : terminator;
  }
  return null;
}

/**
 * `text` with a construct left open at its end closed: a fence without its
 * closing fence, or an HTML block (a comment, `<script>`, …) without its end
 * marker. Such a construct runs to the end of the document, so in the output
 * it would swallow every hit after it. Only the last top-level block can be
 * one; one inside a list or a quote ends with its container.
 */
function closeOpenConstructs(text: string): string {
  const last = topLevelBlocks(text).at(-1);
  if (!last) return text;
  const source = text.slice(last.start, last.end);
  if (last.type === "code") {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
    if (!fence) return text;
    const lines = source.split("\n");
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \t]*$`);
    return lines.length > 1 && closing.test(lines[lines.length - 1]!) ? text : `${text}\n${fence}`;
  }
  if (last.type === "html") {
    const terminator = openHtmlTerminator(source);
    return terminator ? `${text}\n${terminator}` : text;
  }
  return text;
}

/** The non-blank lines of a chunk, as the section's source has them. */
function chunkLines(content: string): string[] {
  return content.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
}

/**
 * The part of a document a chunk comes from: its lead (the text before the
 * first top-level `##`) or one `##` section, as the source parses today.
 *
 * When the query's first match in the chunk is known (`matchLine`, the line
 * that holds it), the part holding that line is taken. That is what decides a
 * folded chunk, one into which the chunker merged a short section: it carries
 * that section's `##` heading, and only the match says which part answers.
 * Otherwise, for a chunk that is not folded, the part holding most of its
 * lines is taken (the chunker can repeat a table's header row or re-prefix a
 * nested table's row, so not every line need be there), ties going to the
 * part the chunk's heading names, then the first.
 *
 * Null, so the caller keeps the snippet, when the part cannot be told: a
 * folded chunk whose match line is unknown, a match line more than one part
 * holds in a folded chunk, or a chunk no part holds half of (the file has
 * changed since it was indexed).
 */
function sourcePart(body: string, chunk: ChunkMatch, matchLine: string | null): { name: string | null; text: string } | null {
  const { lead, sections } = splitSections(body);
  const parts = [
    { name: null as string | null, text: lead },
    ...sections.map((section) => {
      const heading = topLevelBlocks(section)[0]!;
      const name = headingBlockText(section.slice(heading.start, heading.end));
      // What follows the heading: blank lines before it go, indentation stays.
      const rest = section.slice(heading.end).replace(/^[ \t]*\r?\n/, "").replace(/^(?:[ \t]*\r?\n)+/, "");
      return { name, text: rest.trimEnd() };
    }),
  ];
  const folded = topLevelBlocks(chunk.content).some((block) => block.type === "heading" && (block.depth ?? 1) <= 2);
  let candidates = parts;
  if (matchLine !== null) {
    const asHeading = /^#{1,6}(?:[ \t]|$)/.test(matchLine) ? headingBlockText(matchLine) : null;
    candidates = parts.filter((part) => part.text.includes(matchLine) || (asHeading !== null && part.name === asHeading));
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) return null;
  }
  if (folded) return null;
  const lines = chunkLines(chunk.content);
  if (lines.length === 0) return null;
  const hinted = chunk.heading.replace(/ \(cont\.\)$/, "").split(" › ")[0];
  let best: { part: (typeof parts)[number]; found: number } | null = null;
  for (const part of candidates) {
    const found = lines.filter((line) => part.text.includes(line)).length;
    const better =
      !best || found > best.found || (found === best.found && part.name === hinted && best.part.name !== hinted);
    if (better) best = { part, found };
  }
  return best && best.found * 2 >= lines.length && best.found > 0 ? best.part : null;
}

/**
 * A hit as the whole `##` section (or the lead) its best chunk comes from
 * (`sourcePart`, with the line of the query's first match in it), read from
 * the source file: under the hit's header and a `####` naming the
 * section, with its headings demoted below that and a construct left open at
 * its end closed. Longer than `cap` tokens, it is cut after its last whole
 * block that fits, with a pointer to the file. Null, so the caller falls back
 * to the snippet, when the file cannot be read or no longer holds the chunk,
 * when not even the header fits, or when no block but a heading survives the
 * cut.
 */
function hitSection(result: SearchResult, best: ChunkMatch, matchLine: string | null, root: string, cap: number): string | null {
  const doc = readMarkdownContent(root, result.path);
  const part = doc ? sourcePart(doc.body, best, matchLine) : null;
  if (!part || !part.text) return null;
  const text = closeOpenConstructs(demoteHeadings(part.text));
  const named = part.name ? `\n#### ${oneLine(part.name)}` : "";
  const head = `${hitHeader(result)}${named}`;
  const whole = `${head}\n${text}`;
  if (estimateTokens(whole) <= cap) return whole;
  const marker = `(truncated — brain read ${result.path})`;
  const cut = truncateAtBoundary(head, text, marker, cap);
  if (cut === null) return null;
  // A cut that keeps no block but headings says nothing the snippet does not.
  const kept = cut.slice(head.length + 1, cut.length - marker.length);
  return topLevelBlocks(kept).some((block) => block.type !== "heading") ? cut : null;
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
