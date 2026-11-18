#!/usr/bin/env bun
/**
 * brain MCP server (stdio). Ports scripts/mcp-server.ts verbatim in tool shape:
 * the same 8 `brain_*` tools (plus the six `brain_compute_*` tools, #3107) with identical names, input schemas, annotations,
 * and structuredContent shapes (the integration contract). What changed is the
 * wiring beneath: initContext() supplies root/taxonomy/config instead of the
 * module-level ROOT/DB_PATH, providers resolve from brain.config (embeddings
 * degrade to FTS keyless), and the type-filter descriptions are generated from
 * the effective taxonomy rather than a hardcoded personal type list.
 *
 * NOTE: communicates over stdio — never write logs to stdout. Use
 * console.error/console.warn (stderr) only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { initContext } from "./lib/context.js";
import type { BrainContext } from "./lib/context.js";
import { openDatabase, loadVecSupport } from "./lib/db.js";
import { isIsoDate } from "./lib/search-engine.js";
import { walkLinks } from "./lib/link-walk.js";
import { resolveProviders } from "./lib/registry.js";
import type { EmbeddingProvider } from "./lib/seams.js";
import { EMBEDDING_DIMENSIONS } from "./lib/models.js";
import { SEARCH_SORTS } from "./lib/types.js";
import { packageVersion } from "./package-version.js";
import { registerModuleTools } from "./lib/module-mcp-tools.js";
import { APIFY_DESCRIPTIONS, APIFY_INPUT_SCHEMAS, APIFY_OPERATIONS, APIFY_TOOL_NAMES } from "@schlessera/brain-common/internal/apify-operations";
import { createStandaloneApify, type StandaloneApify } from "./lib/apify/standalone.js";
import { indexStaleness } from "./lib/ops/staleness.js";
import { DOCUMENT_PAGE_MAX_BYTES } from "./lib/document-page.js";
import { coverageNote } from "./lib/context-assembler.js";
import {
  contextBriefing,
  contextCoverageSchema,
  contextScopeListSchema,
  DEFAULT_LIST_LIMIT,
  listDocuments,
  listLimitSchema,
  MAX_LIST_LIMIT,
  pageDocuments,
  readDocument,
  searchDocuments,
} from "./lib/ops/read.js";
import { READ_MANY_DESCRIPTION, readMany, readManyInputShape } from "./lib/ops/read-many.js";
import { addDocument, archiveWithReindex, splitTags, updateDocumentFields } from "./lib/ops/write.js";
import {
  COMPUTE_TOOL_NAMES,
  computeHealthInput,
  computeJobInput,
  computeRequestInput,
  createComputeDriver,
  createComputeOps,
  localPrincipal,
  type ComputeDriver,
  type ComputeEnvelope,
  type ComputeOps,
} from "./lib/ops/compute.js";

// Server-side result caps — agents can ask for less, never more. Search and
// graph clamp a larger value; `brain_list` rejects one (`listLimitSchema`).
export const MAX_SEARCH_LIMIT = 50;
export { MAX_LIST_LIMIT };
export const MAX_GRAPH_DEPTH = 5;

/** A date input: a real calendar date written `YYYY-MM-DD`. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date written YYYY-MM-DD")
  .refine(isIsoDate, "is not a calendar date");

/** Longest owner name, in characters, that goes into the instructions. */
const MAX_OWNER_NAME = 80;

/**
 * `profile.name` as data for the instructions: control, format and separator
 * characters and every whitespace run become one space, the result is capped
 * at MAX_OWNER_NAME characters, and it is quoted, so a config value cannot
 * add lines or instructions of its own. Null when nothing is left.
 */
function ownerName(profileName?: string): string | null {
  const flat = (profileName ?? "").replace(/[\s\p{Cc}\p{Cf}\p{Z}]+/gu, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  const capped = chars.length > MAX_OWNER_NAME ? `${chars.slice(0, MAX_OWNER_NAME).join("").trimEnd()}…` : flat;
  return JSON.stringify(capped);
}

/**
 * The server's `instructions`, which clients put into the agent's context:
 * what the brain is for and which tool answers which need. Names the owner
 * from `profile.name` when the config sets it, as quoted data.
 */
export function serverInstructions(profileName?: string): string {
  const name = ownerName(profileName);
  const owner = name ? `its owner, whom the config names ${name}` : "the person it belongs to";
  return (
    `This brain is the source of truth for facts about ${owner}: identity, current focus, ` +
    `projects, notes and their history. Check it before answering from memory, and prefer ` +
    `these tools to grepping its files. Use brain_search to find documents on a topic and ` +
    `brain_context for a briefing on one within a token budget. Use brain_read to read one ` +
    `document and brain_graph to follow its wiki-links. Record new information with brain_add ` +
    `and change a document with brain_update. Never edit brain.db: it is a disposable index ` +
    `rebuilt from the markdown files. The brain_apify_* tools reach Apify's paid remote ` +
    `extractors under the brain's governance policy; they are not web search, and discovering ` +
    `or inspecting an Actor never runs it.`
  );
}

/** How long one staleness probe answers for every read tool. */
const STALENESS_TTL_MS = 10_000;

/**
 * The read tools' staleness warning: markdown files on disk newer than their
 * indexed_at, missing from the index, or deleted from disk. Cached briefly,
 * and never allowed to break a read.
 */
function stalenessWarning(db: Database, brain: BrainContext): () => string | null {
  let cache: { at: number; warning: string | null } = { at: 0, warning: null };
  return () => {
    const now = Date.now();
    if (now - cache.at < STALENESS_TTL_MS) return cache.warning;
    let warning: string | null = null;
    try {
      const { stale } = indexStaleness(db, brain.root, brain.taxonomy);
      if (stale > 0) warning = `index is stale (${stale} file(s) newer than index); run \`brain index\``;
    } catch {
      // Never let the staleness probe break a read.
    }
    cache = { at: now, warning };
    return warning;
  };
}

/** Everything the core tool wrappers share, resolved once per server. */
interface CoreTools {
  brain: BrainContext;
  db: Database;
  embeddings?: EmbeddingProvider;
  /** The embedding provider whose key the host withheld from this agent worker (#1666). */
  withheldEmbeddings?: { provider: string; key: string };
  /** Load the vector extension on first use. */
  ensureVec: () => Promise<void>;
  stale: () => string | null;
  /** The invalid-config warning, when the server runs on degraded defaults. */
  configWarning: string | null;
  /** The config warning, module-load warnings, then these. */
  toolWarnings: (...warnings: Array<string | null>) => string[];
  /** The refusal every write tool returns while the config is invalid. */
  degradedWriteError: () => ReturnType<typeof errorResult> | null;
  /** The effective taxonomy's types, for the type-filter descriptions. */
  typeList: string;
}

const textContent = (text: string, warnings: string[]) => {
  const content: Array<{ type: "text"; text: string }> = [{ type: "text", text }];
  if (warnings.length > 0) {
    content.push({ type: "text", text: warnings.map((w) => `warning: ${w}`).join("\n") });
  }
  return content;
};

/** A structured result with its compact JSON text copy. */
const structuredResult = <T extends Record<string, unknown>>(structured: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(structured) }],
  structuredContent: structured,
});

/** A write tool's result: JSON text only. */
const jsonText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

const errorResult = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
  isError: true,
});

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

/** brain_search, brain_context, brain_read, brain_list and brain_graph, in that order. */
function registerReadTools(server: McpServer, t: CoreTools): void {
  server.registerTool(
    "brain_search",
    {
      description:
        `Search the brain knowledge base using hybrid FTS5 + vector search. Returns documents matching a query with optional filters for type, tag, relevance, and search mode. \`limit\` defaults to 10 and returns at most ${MAX_SEARCH_LIMIT} results; a larger value is capped.`,
      inputSchema: {
        query: z.string().describe("Search query"),
        type: z.string().optional().describe(`Filter by document type (${t.typeList})`),
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
    async (params) => {
      try {
        if (params.mode !== "fts") await t.ensureVec();
        const { results, warnings } = await searchDocuments(t, {
          query: params.query,
          mode: params.mode,
          rerank: params.rerank,
          type: params.type,
          tag: params.tag,
          relevance: params.relevance,
          includeArchived: params.include_archived,
          assetsOnly: params.assets_only,
          limit: Math.min(Math.max(1, params.limit), MAX_SEARCH_LIMIT),
          updatedSince: params.updated_since,
          updatedBefore: params.updated_before,
          deadlineFrom: params.deadline_from,
          deadlineTo: params.deadline_to,
          sort: params.sort,
          upcoming: params.upcoming,
        });
        // Module-load warnings are not part of this tool's answer.
        const stale = t.stale();
        return structuredResult({
          results,
          warnings: [...(t.configWarning ? [t.configWarning] : []), ...warnings, ...(stale ? [stale] : [])],
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "brain_context",
    {
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
    async (params) => {
      try {
        await t.ensureVec();
        const briefing = await contextBriefing(t, {
          query: params.query,
          maxTokens: params.max_tokens,
          includeIdentity: params.include_identity,
          includeCurrentFocus: params.include_current_focus,
          include: params.include,
          exclude: params.exclude,
        });
        // A degraded lane or a reranker that did not run is part of the answer.
        const warnings = t.toolWarnings(...briefing.warnings, t.stale());
        // A scoped briefing says what it covers, as a last block and in structuredContent.
        if (briefing.coverage) {
          return {
            content: [...textContent(briefing.context, warnings), { type: "text" as const, text: coverageNote(briefing.coverage) }],
            structuredContent: { context: briefing.context, warnings, coverage: briefing.coverage },
          };
        }
        return {
          content: textContent(briefing.context, warnings),
          structuredContent: { context: briefing.context, warnings },
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "brain_read",
    {
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
    async (params) => {
      try {
        const content = readDocument(t.brain.root, { path: params.path, section: params.section, maxTokens: params.max_tokens });
        return { content: textContent(content, t.toolWarnings(t.stale())) };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "brain_list",
    {
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
    async (params) => {
      try {
        // Any discovery input selects the paged, byte-bounded response; a
        // call without one keeps the legacy listing byte for byte.
        if (params.path_prefix !== undefined || params.overview !== undefined || params.cursor !== undefined) {
          const page = pageDocuments(
            { db: t.db, root: t.brain.root },
            {
              type: params.type,
              tag: params.tag,
              status: params.status,
              relevance: params.relevance,
              limit: params.limit,
              pathPrefix: params.path_prefix,
              overview: params.overview,
              cursor: params.cursor,
            },
            t.toolWarnings(t.stale())
          );
          return structuredResult({ ...page });
        }
        const { documents } = listDocuments(t.db, {
          type: params.type,
          tag: params.tag,
          status: params.status,
          relevance: params.relevance,
          limit: params.limit,
        });
        return structuredResult({ documents, warnings: t.toolWarnings(t.stale()) });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "brain_graph",
    {
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
    async (params) => {
      try {
        const depth = Math.min(Math.max(1, params.depth), MAX_GRAPH_DEPTH);
        const { edges, nodes } = walkLinks(t.db, { path: params.path, depth, direction: params.direction });
        return structuredResult({ edges, nodes, warnings: t.toolWarnings(t.stale()) });
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

/**
 * `brain_read_many` (#3642): the bounded multi-read, registered after the
 * five single read tools. Its result is the JSON envelope once, as text, with
 * no `structuredContent`: a second copy would double the wire size the caps
 * bound (docs/decisions/bounded-multi-read.md). The read tools' warnings ride
 * in the envelope, once per call.
 */
function registerReadManyTool(server: McpServer, t: CoreTools): void {
  server.registerTool(
    "brain_read_many",
    { description: READ_MANY_DESCRIPTION, inputSchema: readManyInputShape, annotations: { readOnlyHint: true } },
    async (params, extra) => {
      try {
        return jsonText(await readMany(t.brain.root, params, { signal: extra.signal, warnings: t.toolWarnings(t.stale()) }));
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

/** brain_add, brain_update and brain_archive, in that order. Each refuses while the config is invalid. */
function registerWriteTools(server: McpServer, t: CoreTools): void {
  const deps = { db: t.db, root: t.brain.root, taxonomy: t.brain.taxonomy };

  server.registerTool(
    "brain_add",
    {
      description:
        "Add new content to the brain knowledge base. Content is classified, given frontmatter, and written to the appropriate directory. Returns the action taken and the file path. Classification is rule-based, with no model call: content titled exactly like an existing document of an append-match type is appended to it, otherwise the brain's classifier hints pick the type, otherwise it lands in the inbox type. Pass `type` to choose it yourself.",
      inputSchema: {
        content: z.string().describe("Content to add"),
        type: z.string().optional().describe(`Document type (${t.typeList}). Defaults to auto-classification.`),
        title: z.string().optional().describe("Title for the document"),
        tags: z.string().optional().describe("Comma-separated tags"),
      },
    },
    async (params) => {
      const degraded = t.degradedWriteError();
      if (degraded) return degraded;
      try {
        const tags = params.tags ? splitTags(params.tags) : undefined;
        return jsonText(await addDocument(deps, { content: params.content, type: params.type, title: params.title, tags }));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "brain_update",
    {
      description:
        "Update an existing brain document: set frontmatter fields (summary, status, relevance, tags, deadline, next_review) and/or append a markdown section to the body. Bumps the `updated` field and reindexes. Setting status to archived also demotes a primary or unset relevance to historical, as brain_archive does, including a primary passed in the same call. Does not create files — use brain_add for that.",
      inputSchema: {
        path: z.string().describe('Relative path to the document (e.g., "context/current-focus.md")'),
        summary: z.string().optional().describe("New one-line summary"),
        status: z.enum(["active", "archived", "draft"]).optional().describe("New status"),
        relevance: z.enum(["primary", "secondary", "historical"]).optional().describe("New relevance"),
        tags: z.string().optional().describe("Comma-separated tags (replaces existing tags)"),
        deadline: z.string().optional().describe("Deadline date (ISO 8601), or empty string to remove"),
        next_review: z.string().optional().describe("Next review date (ISO 8601), or empty string to remove"),
        append_content: z.string().optional().describe("Markdown content appended to the end of the document body"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (params) => {
      const degraded = t.degradedWriteError();
      if (degraded) return degraded;
      try {
        return jsonText(await updateDocumentFields(deps, {
          path: params.path,
          summary: params.summary,
          status: params.status,
          relevance: params.relevance,
          tags: params.tags === undefined ? undefined : splitTags(params.tags),
          deadline: params.deadline,
          nextReview: params.next_review,
          appendContent: params.append_content,
        }));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "brain_archive",
    {
      description:
        "Archive a brain document: sets status to archived, sets a primary or unset relevance to historical, moves projects/active/ files to projects/archive/, and reindexes. Use dry_run to preview.",
      inputSchema: {
        path: z.string().describe("Relative path to the document"),
        dry_run: z.boolean().default(false).describe("Preview without changing anything"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (params) => {
      const degraded = t.degradedWriteError();
      if (degraded) return degraded;
      try {
        return jsonText(await archiveWithReindex(deps, { path: params.path, dryRun: params.dry_run }));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // Note: brain_process was removed intentionally in the reference too — it
  // spawned a nested agent with write tools from within the server. Note
  // processing goes through the /process-notes skill (or `brain process`).
}

/**
 * A compute envelope as a tool result: the envelope as structuredContent and
 * its compact JSON text. A refusal is a tool error carrying the same
 * envelope, so an agent sees the stable code.
 */
const computeResult = (envelope: ComputeEnvelope) => ({
  content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
  structuredContent: envelope as unknown as Record<string, unknown>,
  ...(envelope.ok ? {} : { isError: true }),
});

/**
 * The six `brain_compute_*` tools, always registered in this order with
 * fixed descriptions, whatever the config says: the tool roster an agent
 * session starts with never depends on whether compute is configured, and a
 * disabled or unconfigured provider refuses at call time
 * (docs/decisions/provider-history.md). Every handler calls the shared
 * operation set; none reads job state itself. The caller is this process's
 * principal; no input names one.
 */
export function registerComputeTools(server: McpServer, ops: ComputeOps, driver: ComputeDriver): void {
  const [health, plan, run, status, cancel, collect] = COMPUTE_TOOL_NAMES;
  // A refusal is an envelope; anything thrown is a host failure (an
  // unreadable state directory, a misconfigured host) whose message can name
  // local paths. The agent gets the usual tool error with a fixed text and
  // the details stay in the server's stderr log.
  const guarded = (name: string) => async (call: () => Promise<ComputeEnvelope>) => {
    try {
      return computeResult(await call());
    } catch (e) {
      console.error(`brain MCP: ${name} failed:`, e);
      return errorResult(new Error(`${name} failed inside the brain MCP server; its log has the details`));
    }
  };

  server.registerTool(
    health,
    {
      description:
        "List the configured external compute instances, their capabilities and readiness. Allocates nothing and costs nothing. Use before planning a job; with no compute configuration it reports enabled: false.",
      inputSchema: computeHealthInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => guarded(health)(() => ops.health(input))
  );

  server.registerTool(
    plan,
    {
      description:
        "Check a job against admission without any effect: the lease it would hold, the exact source files and their hash, the artifacts, the cost estimate (null when unknown) and free slots, or the refusal it would get. Nothing is uploaded or allocated.",
      inputSchema: computeRequestInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => guarded(plan)(() => ops.plan(input))
  );

  server.registerTool(
    run,
    {
      description:
        "Start a command on a named external compute instance and return its opaque job id once it has started; the job keeps running after this call. Uploads only the declared source files and may cost money. Prefer local execution for cheap work. Follow with brain_compute_status, then brain_compute_collect, or brain_compute_cancel.",
      inputSchema: computeRequestInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) =>
      guarded(run)(async () => {
        const envelope = await ops.run(input);
        if (envelope.ok && envelope.job.terminal === null) driver.track(envelope.job.id);
        return envelope;
      })
  );

  server.registerTool(
    status,
    {
      description:
        "Advance and report one of your compute jobs: state, exit status, cleanup fact (released, retained, release_failed, none or unknown) and cost, where an unknown cost is null, never zero.",
      inputSchema: computeJobInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => guarded(status)(() => ops.status(input))
  );

  server.registerTool(
    cancel,
    {
      description:
        "Cancel one of your compute jobs: stops its command and releases its sandbox, and reports whether release was confirmed. Cost already incurred remains.",
      inputSchema: computeJobInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => guarded(cancel)(() => ops.cancel(input))
  );

  server.registerTool(
    collect,
    {
      description:
        "Return one of your compute jobs with its bounded stdout and stderr (at most 64 KiB each) and its artifacts as files in the host's compute state directory with their sha256. Artifacts are not brain content.",
      inputSchema: computeJobInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => guarded(collect)(() => ops.collect(input))
  );
}

/** Read-only Apify operations: no Actor starts or approval revocations; platform overhead can apply. */
const APIFY_READ_ONLY = new Set(["discover", "inspect", "prepare", "status", "results", "availability", "approvals"]);

/**
 * brain_apify_discover … brain_apify_abort (#3162): fixed names and strict
 * schemas, shared with `brain apify` and both chat backends. Each calls the
 * same standalone operation `brain apify` calls, under this process's own
 * policy, token and shared ledger; nothing here can ask anyone, so a run
 * needs a remembered Actor approval. Discovered Actor schemas are returned as
 * data: choosing an Actor never adds or removes a tool.
 */
export function registerApifyTools(server: McpServer, apify: () => StandaloneApify): void {
  for (const operation of APIFY_OPERATIONS) {
    server.registerTool(APIFY_TOOL_NAMES[operation], {
      description: APIFY_DESCRIPTIONS[operation],
      inputSchema: APIFY_INPUT_SCHEMAS[operation],
      annotations: APIFY_READ_ONLY.has(operation)
        ? { readOnlyHint: true, openWorldHint: true }
        : { readOnlyHint: false, destructiveHint: operation === "abort", idempotentHint: false, openWorldHint: true },
    }, async (input: unknown, extra: { signal: AbortSignal }) => {
      try {
        const envelope = await apify().call(operation, input, { signal: extra.signal });
        return { ...(envelope.ok ? {} : { isError: true }), content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown> };
      } catch (e) {
        return errorResult(e);
      }
    });
  }
}

export async function startMcpServer(
  brainContext?: BrainContext,
  configError?: string
): Promise<void> {
  const brain = brainContext ?? await initContext();
  const configWarning = configError
    ? `brain.config is invalid; using degraded core defaults: ${configError.split("\n")[0]}`
    : null;
  const moduleWarnings: string[] = [];

  // Without a usable embedding provider vector/hybrid degrade to FTS with a
  // warning, as in the CLI; the registry decides availability for both.
  const { embeddings, warnings, withheld } = resolveProviders(brain.config);
  if (warnings.embeddings) console.error(`brain MCP: ${warnings.embeddings}`);

  const db = openDatabase(brain.dbPath, { embeddingDimensions: embeddings?.dimensions ?? EMBEDDING_DIMENSIONS });
  // Every search/context tool here is read-only. Loading the extension makes
  // stored vectors queryable on this connection; it must not migrate the
  // vector schema, which drops every vector and costs a paid re-embedding run.
  // The write tools (create/update/archive) reindex through indexAll, which
  // prepares the vector store itself when it is about to embed.
  let vecReady = false;
  const ensureVec = async () => {
    if (!vecReady) vecReady = (await loadVecSupport(db)).ok;
  };

  const tools: CoreTools = {
    brain,
    db,
    embeddings,
    ...(withheld?.embeddings ? { withheldEmbeddings: withheld.embeddings } : {}),
    ensureVec,
    stale: stalenessWarning(db, brain),
    configWarning,
    toolWarnings: (...warnings) => [
      ...(configWarning ? [configWarning] : []),
      ...moduleWarnings,
      ...warnings.filter((warning): warning is string => warning !== null),
    ],
    degradedWriteError: () =>
      configError
        ? errorResult(
            new Error(
              `brain.config is invalid; write tools are disabled until it is fixed: ${configError.split("\n")[0]}`
            )
          )
        : null,
    typeList: brain.taxonomy.validTypes().join(", "),
  };

  const server = new McpServer(
    { name: "brain", version: packageVersion() },
    { instructions: serverInstructions(brain.config?.profile?.name) }
  );
  registerReadTools(server, tools);
  registerReadManyTool(server, tools);
  registerWriteTools(server, tools);
  const computeOps = createComputeOps({ root: brain.root, config: brain.config, caller: { kind: "mcp", principal: localPrincipal() } });
  const computeDriver = createComputeDriver(computeOps);
  registerComputeTools(server, computeOps, computeDriver);
  // Jobs this server started are advanced while it lives; leases bound them after.
  server.server.onclose = () => computeDriver.stop();
  let apify: StandaloneApify | undefined;
  registerApifyTools(server, () => apify ??= createStandaloneApify({ root: brain.root }));

  // Core's names are registered first. Module tools are fixed for this
  // process and registered before connect, so no list-changed event is sent.
  const owners = new Map<string, string | null>([
    "brain_search", "brain_context", "brain_read", "brain_list", "brain_graph", "brain_read_many",
    "brain_add", "brain_update", "brain_archive", ...COMPUTE_TOOL_NAMES,
    ...APIFY_OPERATIONS.map(operation => APIFY_TOOL_NAMES[operation]),
  ].map((name) => [name, null]));
  moduleWarnings.push(...await registerModuleTools(server, brain.modules, brain.root, brain.taxonomy, owners));

  await ensureVec();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  startMcpServer().catch((e) => {
    console.error("Fatal error starting brain MCP server:", e);
    process.exit(1);
  });
}
