/** Static package-owned MCP read definitions. No brain/configuration is loaded here. */
import { z } from "zod";
import { isIsoDate } from "./lib/search-engine.js";
import { SEARCH_SORTS } from "./lib/types.js";
import { DOCUMENT_PAGE_MAX_BYTES } from "./lib/document-page.js";
import { contextCoverageSchema, contextScopeListSchema, DEFAULT_LIST_LIMIT, listLimitSchema, MAX_LIST_LIMIT } from "./lib/ops/read.js";
import { READ_MANY_DESCRIPTION, readManyInputShape } from "./lib/ops/read-many.js";
export const MAX_SEARCH_LIMIT = 50;
export const MAX_GRAPH_DEPTH = 5;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date written YYYY-MM-DD").refine(isIsoDate, "is not a calendar date");
export const BRAIN_READ_DEFINITION_VERSION = 1;
const searchResultSchema = z.object({
  path: z.string(),
  title: z.string(),
  type: z.string(),
  relevance: z.string().nullish(),
  status: z.string().nullish(),
  summary: z.string().nullish(),
  updated: z.string().nullish(),
  deadline: z.string().nullish(),
  tags: z.string().nullish(),
  score: z.number().nullish(),
  snippet: z.string().nullish(),
  supersededBy: z.string().optional(),
});

const listedDocumentSchema = z.object({
  path: z.string(),
  title: z.string(),
  type: z.string(),
  relevance: z.string().nullish(),
  status: z.string().nullish(),
  tags: z.string().nullish(),
  // The overview projection (#3643), present only when `overview` is true.
  summary: z.string().nullish(),
  updated: z.string().optional(),
  deadline: z.string().nullish(),
  indexed_at: z.string().optional(),
  indexed_body_bytes: z.number().int().nullish(),
  clipped: z.array(z.string()).optional(),
});

const graphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  resolved: z.boolean(),
});
const graphNodeSchema = z.object({
  path: z.string(),
  title: z.string(),
  type: z.string(),
  summary: z.string().nullable(),
  updated: z.string().nullable(),
});


export function brainReadDefinitions(typeList = "configured document types") { return {
brain_search: {
      _meta: { "anthropic/alwaysLoad": true },
      description:
        `Search the brain knowledge base using hybrid FTS5 + vector search. Returns documents matching a query with optional filters for type, tag, relevance, and search mode. \`limit\` defaults to 10 and returns at most ${MAX_SEARCH_LIMIT} results; a larger value is capped.`,
      inputSchema: {
        query: z.string().describe("Search query"),
        type: z.string().optional().describe(`Filter by document type (${typeList})`),
        tag: z.string().optional().describe("Filter by tag"),
        relevance: z.string().optional().describe("Filter by relevance (primary, secondary, historical)"),
        mode: z.enum(["fts", "vector", "hybrid"]).default("hybrid").describe("Search mode: fts, vector, or hybrid"),
        rerank: z
          .enum(["none", "heuristic", "jev"])
          .optional()
          .describe(
            "Reranking: jev (relevance judgment; requires reranker.enabled: true), heuristic (local lifecycle factors) or none. Omit for the configured provider when enabled and available, otherwise heuristic."
          ),
        include_archived: z.boolean().default(false).describe("Include archived documents"),
        assets_only: z.boolean().default(false).describe("Only return non-markdown assets (images, PDFs)"),
        limit: z.number().default(10).describe("Max results to return"),
        updated_since: isoDate.optional().describe("Only documents updated on or after this date (YYYY-MM-DD)"),
        updated_before: isoDate.optional().describe("Only documents updated on or before this date (YYYY-MM-DD)"),
        deadline_from: isoDate.optional().describe("Only documents with a deadline on or after this date (YYYY-MM-DD)"),
        deadline_to: isoDate.optional().describe("Only documents with a deadline on or before this date (YYYY-MM-DD)"),
        sort: z.enum(SEARCH_SORTS).optional().describe("Result order: score (the default), updated (newest first) or deadline (earliest first, undated last)"),
        upcoming: z.boolean().default(false).describe("Same as deadline_from today and sort deadline; an explicit deadline_from or sort wins"),
      },
      outputSchema: {
        results: z.array(searchResultSchema),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
brain_context: {
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Assemble a topic briefing. `max_tokens` defaults to 4000; output stays within this budget, estimated at about four characters per token. The identity and current-focus documents come first: whole when they fit, otherwise cut at a paragraph or heading boundary with a pointer to read the full file, and left out when not even that fits. Search hits follow as headers and one-line snippets, included whole or skipped for the next one until fewer than 20 tokens remain. Remaining budget expands placed hits in rank order into their matching source section or lead, capped at 40% of the total budget per hit. Longer sections are cut at whole-block boundaries with a read pointer; unavailable or unusable sections retain their snippets. Documents are not repeated.",
      inputSchema: {
        query: z.string().describe("Topic to assemble context for"),
        max_tokens: z.number().default(4000).describe("Token budget for the assembled context"),
        include_identity: z.boolean().default(true).describe("Include identity section"),
        include_current_focus: z.boolean().default(true).describe("Include current focus section"),
        include: contextScopeListSchema
          .optional()
          .describe(
            'Only draw on these repository-relative paths: an exact file path, or a folder ending in "/" for everything under it. Applies to identity, current focus, search hits and related documents alike'
          ),
        exclude: contextScopeListSchema
          .optional()
          .describe('Never draw on these paths (exact, or a folder ending in "/"); an exclusion wins over include'),
      },
      outputSchema: {
        context: z.string(),
        warnings: z.array(z.string()),
        coverage: contextCoverageSchema.optional(),
      },
      annotations: { readOnlyHint: true },
    },
brain_read: {
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Read a specific document from the brain knowledge base by its relative path. By default returns the whole file, frontmatter included, however long it is. Pass `section` to get one section by its heading (matched on its visible text, ignoring case; the first of two equal headings wins), or `max_tokens` to get the frontmatter and an outline of headings with their token counts instead of a file larger than that. `max_tokens` is the threshold for switching to the outline, not a cap on the output: a large frontmatter or very many headings make the outline larger than it.",
      inputSchema: {
        path: z.string().describe('Relative path to the document (e.g., "me/identity.md")'),
        section: z
          .string()
          .optional()
          .describe("Heading text of one section to return, from its heading to the next heading of the same or higher level"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Threshold, not a cap: when the result would be larger than this, return the frontmatter and an outline instead"),
      },
      annotations: { readOnlyHint: true },
    },
brain_list: {
      _meta: { "anthropic/alwaysLoad": true },
      description:
        `List documents in the brain knowledge base with optional filters for type, tag, status, and relevance. Returns metadata (path, title, type, relevance, status, tags) for matching documents, newest first. \`limit\` is a whole number from 1 to ${MAX_LIST_LIMIT} and defaults to ${DEFAULT_LIST_LIMIT}; any other value is rejected, not capped. ` +
        `Pass \`path_prefix\`, \`overview\` or \`cursor\` for a paged inventory: newest \`updated\` first then path, at most ${DOCUMENT_PAGE_MAX_BYTES} bytes per page, with \`next_cursor\` (null at the end) and \`total\`. \`path_prefix\` matches whole path segments. \`overview\` adds summary, updated (the frontmatter date, not file or project activity), deadline, indexed_at and indexed_body_bytes (UTF-8 bytes of the indexed body, frontmatter excluded; not the file size).`,
      inputSchema: {
        type: z.string().optional().describe("Filter by document type"),
        tag: z.string().optional().describe("Filter by tag"),
        status: z.string().optional().describe("Filter by status (active, archived, draft)"),
        relevance: z.string().optional().describe("Filter by relevance (primary, secondary, historical)"),
        limit: listLimitSchema.default(DEFAULT_LIST_LIMIT).describe("Max results to return"),
        path_prefix: z
          .string()
          .optional()
          .describe("Only documents at or below this root-relative folder or file, on whole path segments (projects/active)"),
        overview: z
          .boolean()
          .optional()
          .describe("Add summary, updated, deadline, indexed_at and indexed_body_bytes to every row"),
        cursor: z.string().optional().describe("next_cursor from the previous page of the same listing"),
      },
      outputSchema: {
        documents: z.array(listedDocumentSchema),
        next_cursor: z.string().nullable().optional(),
        total: z.number().int().optional(),
        truncated: z.literal(true).optional(),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
brain_graph: {
      description:
        `Traverse the wiki-link graph from a starting document. Returns edges (source, target, resolved) showing how documents are connected via [[wiki-links]], and nodes (path, title, type, summary, updated) for every document an edge touches. \`depth\` defaults to 1 hop and is capped at ${MAX_GRAPH_DEPTH}.`,
      inputSchema: {
        path: z.string().describe("Starting document path"),
        depth: z.number().default(1).describe("How many hops to traverse"),
        direction: z.enum(["outgoing", "incoming", "both"]).default("both").describe("Link direction to traverse"),
      },
      outputSchema: {
        edges: z.array(graphEdgeSchema),
        nodes: z.array(graphNodeSchema),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
brain_read_many: { _meta: { "anthropic/alwaysLoad": true }, description: READ_MANY_DESCRIPTION, inputSchema: readManyInputShape, annotations: { readOnlyHint: true } }
}; }
