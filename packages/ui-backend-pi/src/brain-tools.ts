/**
 * The curated brain tools (#2517): the read paths of the brain MCP surface
 * (`brain_search`, `brain_context`, `brain_read`, `brain_list`,
 * `brain_graph`) and the legacy in-process writers (`brain_add`,
 * `brain_update`, `brain_archive`), one named factory each.
 */
import { Type } from "typebox";
import { readFileSync } from "fs";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import {
  coverageNote,
  emptyContextCoverage,
  isIsoDate,
  MAX_SCOPE_ENTRIES,
  MAX_SCOPE_ENTRY_LENGTH,
  READ_MANY_DESCRIPTION,
  READ_MANY_MAX_PATH_CHARS,
  READ_MANY_MAX_REQUESTS,
  READ_MANY_MAX_SECTION_CHARS,
  READ_MANY_MAX_TOTAL_CHARS,
  READ_MANY_MIN_ITEM_CHARS,
  READ_MANY_MIN_TOTAL_CHARS,
  readDocumentPart,
  readMany,
  SEARCH_SORTS,
  type SearchOptions,
} from "@schlessera/brain/internal";

import { clip, MAX_OUTPUT_BYTES, MAX_READ_BYTES, PI_BRAIN_UPDATE_TOOL_NAME, textResult, type BrainToolKit } from "./tool-kit.js";

/** The input `brain_search` accepts, in the names the model sends. */
interface BrainSearchParams {
  query: string;
  type?: string;
  tag?: string;
  limit?: number;
  updated_since?: string;
  updated_before?: string;
  deadline_from?: string;
  deadline_to?: string;
  sort?: SearchOptions["sort"];
  upcoming?: boolean;
  overview?: boolean;
}

/** The longest summary one overview search result shows, in code points. */
const SEARCH_SUMMARY_CHARS = 300;

/** A summary as one bounded line: whitespace runs collapsed, at most SEARCH_SUMMARY_CHARS code points. */
function summaryLine(summary: string): string {
  const points = Array.from(summary.replace(/\s+/g, " ").trim());
  return points.length > SEARCH_SUMMARY_CHARS ? `${points.slice(0, SEARCH_SUMMARY_CHARS - 1).join("")}…` : points.join("");
}

/**
 * Overview search output within MAX_OUTPUT_BYTES UTF-8 bytes: warnings,
 * then whole result entries in rank order while they fit, then how many
 * were left out. Never cut inside an entry.
 */
function fitSearchOverview(warnings: string[], entries: string[]): string {
  const footer = (n: number) => `… ${n} more result(s) omitted to fit the output budget`;
  const lines: string[] = [];
  let size = 0;
  const add = (line: string, reserve: number) => {
    const cost = Buffer.byteLength(line, "utf8") + (lines.length > 0 ? 1 : 0);
    if (size + cost + reserve > MAX_OUTPUT_BYTES) return false;
    lines.push(line);
    size += cost;
    return true;
  };
  const reserve = Buffer.byteLength(footer(COUNT_PLACEHOLDER), "utf8") + 1;
  for (const w of warnings) if (!add(`> ${w}`, reserve)) break;
  if (entries.length === 0) add("No results found.", 0);
  for (const [i, entry] of entries.entries()) {
    if (!add(entry, i === entries.length - 1 ? 0 : reserve)) {
      lines.push(footer(entries.length - i));
      break;
    }
  }
  return lines.join("\n");
}

/**
 * The longest JSON a listing or a graph returns: the budget text output is
 * clipped at. JSON is never clipped as text, which would not parse; it is
 * cut by structure instead, whole rows or whole edges at a time.
 */
const MAX_JSON_CHARS = MAX_OUTPUT_BYTES;

/** Width of the largest omission count, so the reserved size is never short. */
const COUNT_PLACEHOLDER = Number.MAX_SAFE_INTEGER;

/**
 * A listing within MAX_JSON_CHARS: the rows in order while they fit, then
 * `truncated: true` and how many rows were left out.
 */
function fitListing<T>(documents: T[]): { documents: T[]; truncated?: true; omitted?: number } {
  const whole = { documents };
  if (JSON.stringify(whole).length <= MAX_JSON_CHARS) return whole;
  let size = JSON.stringify({ documents: [], truncated: true, omitted: COUNT_PLACEHOLDER }).length;
  const kept: T[] = [];
  for (const doc of documents) {
    const cost = JSON.stringify(doc).length + (kept.length > 0 ? 1 : 0);
    if (size + cost > MAX_JSON_CHARS) break;
    kept.push(doc);
    size += cost;
  }
  return { documents: kept, truncated: true, omitted: documents.length - kept.length };
}

/**
 * A graph within MAX_JSON_CHARS: edges in walk order while they and the
 * nodes of their endpoints fit, then `truncated: true` and how many edges
 * were left out. Every returned edge keeps its endpoint nodes; nodes stay in
 * path order.
 */
function fitGraph<E extends { source: string; target: string; resolved: boolean }, N extends { path: string }>(
  edges: E[],
  nodes: N[]
): { edges: E[]; nodes: N[]; truncated?: true; omitted_edges?: number } {
  const whole = { edges, nodes };
  if (JSON.stringify(whole).length <= MAX_JSON_CHARS) return whole;
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  let size = JSON.stringify({ edges: [], nodes: [], truncated: true, omitted_edges: COUNT_PLACEHOLDER }).length;
  const kept: E[] = [];
  const keptNodes = new Set<string>();
  for (const edge of edges) {
    const fresh = [edge.source, ...(edge.resolved ? [edge.target] : [])].filter(
      (p, i, all) => !keptNodes.has(p) && byPath.has(p) && all.indexOf(p) === i
    );
    let cost = JSON.stringify(edge).length + (kept.length > 0 ? 1 : 0);
    for (const path of fresh) cost += JSON.stringify(byPath.get(path)).length + (keptNodes.size > 0 || path !== fresh[0] ? 1 : 0);
    if (size + cost > MAX_JSON_CHARS) break;
    kept.push(edge);
    for (const path of fresh) keptNodes.add(path);
    size += cost;
  }
  return {
    edges: kept,
    nodes: nodes.filter((n) => keptNodes.has(n.path)),
    truncated: true,
    omitted_edges: edges.length - kept.length,
  };
}

/** `brain_search`: hybrid search with explicit date filters and sorts. */
export function brainSearchTool(kit: BrainToolKit): ToolDefinition {
  const { brain } = kit;
  return {
    name: "brain_search",
    label: "Search brain",
    description:
      "Hybrid (full-text + vector) search across the knowledge base. Prefer this " +
      "over grep for finding notes by meaning. Returns ranked results with snippets. " +
      "For questions about time (\"what is due next\", \"what changed this week\"), turn the " +
      "dates into the date filters yourself (YYYY-MM-DD, inclusive) and pick a sort; " +
      "upcoming is a shortcut for deadline_from today, sort deadline. " +
      "Pass overview to also see each result's status, updated date (from frontmatter, not file or project activity), " +
      "deadline and summary, so you can choose what to read.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or keyword query." }),
      type: Type.Optional(Type.String({ description: "Filter by document type." })),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
      updated_since: Type.Optional(Type.String({ description: "Only documents updated on or after this date (YYYY-MM-DD)." })),
      updated_before: Type.Optional(Type.String({ description: "Only documents updated on or before this date (YYYY-MM-DD)." })),
      deadline_from: Type.Optional(Type.String({ description: "Only documents with a deadline on or after this date (YYYY-MM-DD)." })),
      deadline_to: Type.Optional(Type.String({ description: "Only documents with a deadline on or before this date (YYYY-MM-DD)." })),
      sort: Type.Optional(
        Type.Union(SEARCH_SORTS.map((s) => Type.Literal(s)), {
          description: "Result order: score (default), updated (newest first) or deadline (earliest first, undated last).",
        })
      ),
      upcoming: Type.Optional(
        Type.Boolean({ description: "Same as deadline_from today and sort deadline; an explicit deadline_from or sort wins." })
      ),
      overview: Type.Optional(
        Type.Boolean({ description: "Also show status, updated, deadline and summary for every result." })
      ),
    }),
    async execute(_id: string, params: BrainSearchParams) {
      // Core also refuses a bad date or sort; checking the dates here names the
      // input the model sent (deadline_from, not deadlineFrom).
      for (const key of ["updated_since", "updated_before", "deadline_from", "deadline_to"] as const) {
        const value = params[key];
        if (value !== undefined && (typeof value !== "string" || !isIsoDate(value))) {
          throw new Error(`${key} must be a date written YYYY-MM-DD, got ${JSON.stringify(value)}`);
        }
      }
      const { results, warnings } = await brain.search({
        query: params.query,
        type: params.type,
        tag: params.tag,
        limit: params.limit ?? 10,
        updatedSince: params.updated_since,
        updatedBefore: params.updated_before,
        deadlineFrom: params.deadline_from ?? (params.upcoming ? new Date().toISOString().slice(0, 10) : undefined),
        deadlineTo: params.deadline_to,
        sort: params.sort ?? (params.upcoming ? "deadline" : undefined),
      });
      if (params.overview === true) {
        // The facts core already returned, under an explicit budget (#3643).
        const entries = results.map((r) => {
          const facts = [
            `status ${r.status || "active"}`,
            ...(r.updated ? [`updated ${r.updated}`] : []),
            ...(r.deadline ? [`due ${r.deadline}`] : []),
          ].join(" · ");
          return (
            `- ${r.path} — ${r.title} [${r.type}] · ${facts}` +
            (r.summary ? `\n    summary: ${summaryLine(r.summary)}` : "") +
            (r.snippet ? `\n    ${r.snippet}` : "")
          );
        });
        return textResult(fitSearchOverview(warnings, entries), { count: results.length });
      }
      const lines: string[] = [];
      for (const w of warnings) lines.push(`> ${w}`);
      if (results.length === 0) lines.push("No results found.");
      for (const r of results) {
        lines.push(
          `- ${r.path} — ${r.title} [${r.type}]` +
            (r.snippet ? `\n    ${r.snippet}` : "")
        );
      }
      return textResult(clip(lines.join("\n")), { count: results.length });
    },
  } satisfies ToolDefinition;
}

/** One of `brain_context`'s path scope lists, bounded as core bounds it. */
const scopeList = (description: string) =>
  Type.Array(Type.String({ minLength: 1, maxLength: MAX_SCOPE_ENTRY_LENGTH }), { maxItems: MAX_SCOPE_ENTRIES, description });

/** `brain_context`: a token-limited context block for a query. */
export function brainContextTool(kit: BrainToolKit): ToolDefinition {
  const { brain } = kit;
  return {
    name: "brain_context",
    label: "Assemble context",
    description:
      "Assemble a token-limited markdown context block of the most relevant notes " +
      "for a query. Use to ground an answer in the knowledge base.",
    parameters: Type.Object({
      query: Type.String({ description: "What to gather context about." }),
      maxTokens: Type.Optional(Type.Number({ description: "Token budget (default 4000)." })),
      include: Type.Optional(scopeList(
        'Only draw on these repository-relative paths: an exact file path, or a folder ending in "/" for everything under it.'
      )),
      exclude: Type.Optional(scopeList('Never draw on these paths (exact, or a folder ending in "/"); an exclusion wins over include.')),
    }),
    async execute(_id: string, params: { query: string; maxTokens?: number; include?: string[]; exclude?: string[] }) {
      const scoped = (params.include?.length ?? 0) > 0 || (params.exclude?.length ?? 0) > 0;
      if (!scoped) {
        const block = await brain.context(params.query, params.maxTokens ?? 4000);
        return textResult(block || "No relevant context found.", { query: params.query });
      }
      // A scoped block says what it covers, after the block and outside its budget.
      const coverage = emptyContextCoverage();
      const block = await brain.context(params.query, params.maxTokens ?? 4000, { include: params.include, exclude: params.exclude, coverage });
      return textResult(`${block || "No relevant context found in the scope."}\n\n${coverageNote(coverage)}`, { query: params.query, coverage });
    },
  } satisfies ToolDefinition;
}

/** `brain_read`: one document, a section of it or its outline. */
export function brainReadTool(kit: BrainToolKit): ToolDefinition {
  const { resolveOrThrow, rememberBase } = kit;
  return {
    name: "brain_read",
    label: "Read brain document",
    description:
      "Read a specific document from the brain knowledge base by its relative path. " +
      "By default returns the whole file, frontmatter included, clipped only at the tool's output limit. " +
      "Pass `section` to get one section by its heading (matched on its visible text, ignoring case; " +
      "the first of two equal headings wins), or `max_tokens` to get the frontmatter and an outline of " +
      "headings with their token counts instead of a file larger than that. `max_tokens` is the threshold " +
      "for switching to the outline, not a cap on the output.",
    parameters: Type.Object({
      path: Type.String({ description: 'Repo-relative document path, e.g. "me/identity.md".' }),
      section: Type.Optional(
        Type.String({
          description:
            "Heading text of one section to return, from its heading to the next heading of the same or higher level.",
        })
      ),
      max_tokens: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Threshold, not a cap: when the result would be larger than this, return the frontmatter and an outline instead.",
        })
      ),
    }),
    async execute(_id: string, params: { path: string; section?: string; max_tokens?: number }) {
      const abs = resolveOrThrow(params.path);
      // The same reader as the MCP tool and `brain read`; with neither option
      // it returns the file untouched, so the default read is unchanged. The
      // byte clip applies to what it selected, so a section past the clip
      // point of the whole file is still reachable.
      const raw = readFileSync(abs, "utf-8");
      rememberBase(params.path, raw);
      const text = readDocumentPart(raw, {
        section: params.section,
        maxTokens: params.max_tokens,
        sectionHint: 'section: "<heading>"',
      });
      return textResult(clip(text, MAX_READ_BYTES), { path: params.path });
    },
  } satisfies ToolDefinition;
}

/**
 * `brain_read_many` (#3642): core's bounded multi-read, the operation the MCP
 * tool and `brain read-many` run. Each request resolves through this
 * roster's own containment (`resolveInRepo`, the rule `brain_read` uses), and
 * the call stops between files when the tool or the turn is aborted. It
 * remembers no write base: a retrieval hash is not a hosted write receipt.
 * Its result is already within its cap, and JSON clipped as text would not
 * parse, so it is never clipped.
 */
export function brainReadManyTool(kit: BrainToolKit): ToolDefinition {
  const { brain, turn } = kit;
  const request = Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: READ_MANY_MAX_PATH_CHARS, description: "Repo-relative document path." }),
      section: Type.Optional(Type.String({ maxLength: READ_MANY_MAX_SECTION_CHARS, description: "Heading text of one section." })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line to page from (next.offset)." })),
      column: Type.Optional(Type.Integer({ minimum: 0, description: "Column in the offset line (next.column)." })),
      expected_sha256: Type.Optional(
        Type.String({ pattern: "^[0-9a-f]{64}$", description: "sha256 of an earlier item of this file." })
      ),
    },
    { additionalProperties: false }
  );
  return {
    name: "brain_read_many",
    label: "Read brain documents",
    description: READ_MANY_DESCRIPTION,
    parameters: Type.Object(
      {
        requests: Type.Array(request, { minItems: 1, maxItems: READ_MANY_MAX_REQUESTS, description: "In priority order." }),
        max_total_chars: Type.Optional(
          Type.Integer({ minimum: READ_MANY_MIN_TOTAL_CHARS, maximum: READ_MANY_MAX_TOTAL_CHARS })
        ),
        max_item_chars: Type.Optional(
          Type.Integer({ minimum: READ_MANY_MIN_ITEM_CHARS, maximum: READ_MANY_MAX_TOTAL_CHARS })
        ),
      },
      { additionalProperties: false }
    ),
    async execute(_id: string, params: unknown, signal?: AbortSignal) {
      const aborted = signal && turn.signal ? AbortSignal.any([signal, turn.signal]) : signal ?? turn.signal ?? undefined;
      const result = await readMany(brain.root, params, { signal: aborted, resolve: (path) => brain.resolveInRepo(path) });
      return textResult(JSON.stringify(result), { count: result.items.length, truncated: result.truncated });
    },
  } satisfies ToolDefinition;
}

/** `brain_list`: document metadata, cut by whole rows. */
export function brainListTool(kit: BrainToolKit): ToolDefinition {
  const { brain } = kit;
  return {
    name: "brain_list",
    label: "List brain documents",
    description:
      "List documents in the brain knowledge base with optional filters for type, tag, " +
      "status, and relevance. Returns metadata (path, title, type, relevance, status, tags). " +
      "For an inventory, pass path_prefix (a folder, matched on whole path segments) and/or overview " +
      "(adds summary, updated: the frontmatter date, not file or project activity, deadline, indexed_at and " +
      "indexed_body_bytes: UTF-8 bytes of the indexed body, not the file size). Those return one bounded page, " +
      "newest updated first then by path, with total and next_cursor; pass next_cursor as cursor for the next page " +
      "until it is null.",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Filter by document type." })),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      status: Type.Optional(
        Type.String({ description: "Filter by status (active, archived, draft)." })
      ),
      relevance: Type.Optional(
        Type.String({ description: "Filter by relevance (primary, secondary, historical)." })
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)." })),
      path_prefix: Type.Optional(
        Type.String({ description: 'Only documents at or below this folder or file, e.g. "projects/active".' })
      ),
      overview: Type.Optional(
        Type.Boolean({ description: "Add summary, updated, deadline, indexed_at and indexed_body_bytes to every row." })
      ),
      cursor: Type.Optional(Type.String({ description: "next_cursor from the previous page of the same listing." })),
    }),
    async execute(
      _id: string,
      params: {
        type?: string;
        tag?: string;
        status?: string;
        relevance?: string;
        limit?: number;
        path_prefix?: string;
        overview?: boolean;
        cursor?: string;
      }
    ) {
      if (params.path_prefix !== undefined || params.overview !== undefined || params.cursor !== undefined) {
        // Core's bounded page (#3643), the same one `brain_list` returns over MCP.
        const page = await brain.page({
          type: params.type,
          tag: params.tag,
          status: params.status,
          relevance: params.relevance,
          limit: params.limit,
          pathPrefix: params.path_prefix,
          overview: params.overview,
          cursor: params.cursor,
        });
        return textResult(JSON.stringify(page), { count: page.documents.length });
      }
      const documents = await brain.list(params);
      // Compact, and cut by whole rows to MAX_JSON_CHARS: a byte-clipped JSON
      // document would not parse.
      return textResult(JSON.stringify(fitListing(documents)), {
        count: documents.length,
      });
    },
  } satisfies ToolDefinition;
}

/** `brain_graph`: the wiki-link graph from one document, cut by whole edges. */
export function brainGraphTool(kit: BrainToolKit): ToolDefinition {
  const { brain } = kit;
  return {
    name: "brain_graph",
    label: "Brain link graph",
    description:
      "Traverse the wiki-link graph from a starting document. Returns edges " +
      "(source, target, resolved) showing how documents are connected via [[wiki-links]], " +
      "and nodes (path, title, type, summary, updated) for every document an edge touches. " +
      "A graph too large to return whole keeps its first edges with their nodes and says " +
      "`truncated: true` with `omitted_edges`.",
    parameters: Type.Object({
      path: Type.String({ description: "Starting document path." }),
      depth: Type.Optional(Type.Number({ description: "How many hops to traverse (default 1)." })),
      direction: Type.Optional(
        Type.String({
          description: 'Link direction: "outgoing", "incoming", or "both" (default).',
        })
      ),
    }),
    async execute(
      _id: string,
      params: { path: string; depth?: number; direction?: string }
    ) {
      const direction =
        params.direction === "outgoing" || params.direction === "incoming"
          ? params.direction
          : "both";
      const { edges, nodes } = await brain.graph({ path: params.path, depth: params.depth, direction });
      // Compact, and cut by whole edges to MAX_JSON_CHARS: a byte-clipped
      // JSON document would not parse, and every returned edge keeps its
      // endpoint nodes.
      return textResult(JSON.stringify(fitGraph(edges, nodes)), { count: edges.length });
    },
  } satisfies ToolDefinition;
}

/** `brain_add`: capture new content under the brain-docs lock key. */
export function brainAddTool(kit: BrainToolKit): ToolDefinition {
  const { brain, lock } = kit;
  return {
    name: "brain_add",
    label: "Add to brain",
    description:
      "Capture content into the brain (classifies, writes a markdown file, reindexes). " +
      "Prefer this over write_file for new notes.",
    parameters: Type.Object({
      content: Type.String({ description: "The note content (first line becomes the title)." }),
      type: Type.Optional(Type.String({ description: "Explicit document type." })),
      title: Type.Optional(Type.String({ description: "Explicit title." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags." })),
    }),
    async execute(
      _id: string,
      params: { content: string; type?: string; title?: string; tags?: string[] }
    ) {
      // brain.add writes a markdown file and reindexes — brain-docs key.
      return lock.withKey(BRAIN_LOCK_KEY, async () => {
        const outcome = await brain.add({
          content: params.content,
          type: params.type,
          title: params.title,
          tags: params.tags,
        });
        const warn = outcome.indexed ? "" : ` (warning: reindex failed — ${outcome.indexError})`;
        return textResult(`${outcome.action}: ${outcome.path}${warn}`, outcome);
      });
    },
  } satisfies ToolDefinition;
}

/** `brain_update`: frontmatter and appended content under the brain-docs lock key. */
export function brainUpdateTool(kit: BrainToolKit): ToolDefinition {
  const { brain, lock } = kit;
  return {
    name: PI_BRAIN_UPDATE_TOOL_NAME,
    label: "Update brain document",
    description:
      "Update an existing brain document: set frontmatter fields (summary, status, " +
      "relevance, tags, deadline, next_review) and/or append a markdown section to the " +
      "body. Bumps the `updated` field and reindexes. Setting status to archived also " +
      "demotes a primary or unset relevance to historical, as brain_archive does, " +
      "including a primary passed in the same call. Does not create files — use " +
      "brain_add for that.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative document path." }),
      summary: Type.Optional(Type.String({ description: "New one-line summary." })),
      status: Type.Optional(
        Type.String({ description: "New status: active, archived, or draft." })
      ),
      relevance: Type.Optional(
        Type.String({ description: "New relevance: primary, secondary, or historical." })
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags (replaces existing tags)." })
      ),
      deadline: Type.Optional(
        Type.String({ description: "Deadline date (ISO 8601), or empty string to remove." })
      ),
      next_review: Type.Optional(
        Type.String({ description: "Next review date (ISO 8601), or empty string to remove." })
      ),
      append_content: Type.Optional(
        Type.String({ description: "Markdown appended to the end of the document body." })
      ),
    }),
    async execute(
      _id: string,
      params: {
        path: string;
        summary?: string;
        status?: string;
        relevance?: string;
        tags?: string[];
        deadline?: string;
        next_review?: string;
        append_content?: string;
      }
    ) {
      const status =
        params.status === "active" || params.status === "archived" || params.status === "draft"
          ? params.status
          : undefined;
      if (params.status !== undefined && status === undefined) {
        throw new Error(`Invalid status "${params.status}" — use active, archived, or draft.`);
      }
      const relevance =
        params.relevance === "primary" ||
        params.relevance === "secondary" ||
        params.relevance === "historical"
          ? params.relevance
          : undefined;
      if (params.relevance !== undefined && relevance === undefined) {
        throw new Error(
          `Invalid relevance "${params.relevance}" — use primary, secondary, or historical.`
        );
      }
      // Write + reindex — brain-docs key, like the other document writers.
      return lock.withKey(BRAIN_LOCK_KEY, async () => {
        const outcome = await brain.update({
          path: params.path,
          summary: params.summary,
          status,
          relevance,
          tags: params.tags,
          deadline: params.deadline,
          nextReview: params.next_review,
          appendContent: params.append_content,
        });
        return textResult(JSON.stringify(outcome, null, 2), outcome);
      });
    },
  } satisfies ToolDefinition;
}

/** `brain_archive`: archive one document under the brain-docs lock key. */
export function brainArchiveTool(kit: BrainToolKit): ToolDefinition {
  const { brain, lock } = kit;
  return {
    name: "brain_archive",
    label: "Archive brain document",
    description:
      "Archive a brain document: sets status to archived, sets a primary or unset relevance " +
      "to historical, moves projects/active/ files to projects/archive/, and reindexes. " +
      "Requires user approval (an archived document drops out of search and briefings). " +
      "Use dry_run to preview.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative document path." }),
      dry_run: Type.Optional(Type.Boolean({ description: "Preview without changing anything." })),
    }),
    async execute(_id: string, params: { path: string; dry_run?: boolean }) {
      return lock.withKey(BRAIN_LOCK_KEY, async () => {
        const outcome = await brain.archive(params.path, params.dry_run ?? false);
        return textResult(JSON.stringify(outcome, null, 2), outcome);
      });
    },
  } satisfies ToolDefinition;
}
