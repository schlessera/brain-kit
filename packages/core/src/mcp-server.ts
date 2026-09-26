#!/usr/bin/env bun
/**
 * brain MCP server (stdio). Ports scripts/mcp-server.ts verbatim in tool shape:
 * the same 8 `brain_*` tools with identical names, input schemas, annotations,
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
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { Glob } from "bun";

import { readEnvVar } from "./config/env.js";
import { initContext } from "./lib/context.js";
import type { BrainContext } from "./lib/context.js";
import { openDatabase, loadVecSupport } from "./lib/db.js";
import { hybridSearch, filterSearch, isIsoDate } from "./lib/search-engine.js";
import { assembleContext } from "./lib/context-assembler.js";
import { walkLinks } from "./lib/link-walk.js";
import { readDocumentPart } from "./lib/document-parts.js";
import { ingest } from "./lib/ingestion.js";
import { archiveDocument, relevanceOnArchive } from "./lib/archiver.js";
import { indexAll } from "./lib/indexer.js";
import { updateDocument } from "./lib/frontmatter-edit.js";
import type { FrontmatterValue } from "./lib/frontmatter-edit.js";
import { safeResolve } from "./lib/safe-path.js";
import { resolveEmbeddingProvider } from "./lib/registry.js";
import { EMBEDDING_DIMENSIONS } from "./lib/models.js";
import { SEARCH_SORTS, type SearchOptions, type DocumentType } from "./lib/types.js";
import type { EmbeddingProvider } from "./lib/seams.js";
import { packageVersion } from "./package-version.js";

// Server-side result caps — agents can ask for less, never more.
export const MAX_SEARCH_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
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
    `rebuilt from the markdown files.`
  );
}

export async function startMcpServer(
  brainContext?: BrainContext,
  configError?: string
): Promise<void> {
  const brain = brainContext ?? await initContext();
  const dims = EMBEDDING_DIMENSIONS;
  const configWarning = configError
    ? `brain.config is invalid; using degraded core defaults: ${configError.split("\n")[0]}`
    : null;

  // Embeddings resolve from config, but only when a key is present — otherwise
  // vector/hybrid degrade to FTS with a warning (same as keyless CLI).
  let embeddings: EmbeddingProvider | undefined;
  const embConfig = brain.config?.embeddings;
  const embCustom = embConfig && typeof embConfig.provider !== "string";
  const embKeyEnv = embConfig?.apiKeyEnv ?? "GEMINI_API_KEY";
  try {
    if (embCustom) embeddings = resolveEmbeddingProvider(embConfig);
    else if (readEnvVar(embKeyEnv)) embeddings = resolveEmbeddingProvider(embConfig);
  } catch (e) {
    console.error(`brain MCP: embedding provider unavailable — ${(e as Error).message}`);
  }
  const embDims = embeddings?.dimensions ?? dims;

  const db = openDatabase(brain.dbPath, { embeddingDimensions: embDims });
  // Every search/context tool here is read-only. Loading the extension makes
  // stored vectors queryable on this connection; it must not migrate the
  // vector schema, which drops every vector and costs a paid re-embedding run.
  // The write tools (create/update/archive) reindex through indexAll, which
  // prepares the vector store itself when it is about to embed.
  let vecReady = false;
  const ensureVec = async () => {
    if (!vecReady) vecReady = (await loadVecSupport(db)).ok;
  };

  // ------------------------------------------------------------------------
  // Index staleness — read tools warn when markdown files on disk are newer
  // than their indexed_at (or missing from the index). Cached briefly.
  // ------------------------------------------------------------------------
  const STALENESS_TTL_MS = 10_000;
  let staleCache: { at: number; warning: string | null } = { at: 0, warning: null };

  const indexStalenessWarning = (): string | null => {
    const now = Date.now();
    if (now - staleCache.at < STALENESS_TTL_MS) return staleCache.warning;

    let warning: string | null = null;
    try {
      const rows = db
        .prepare("SELECT path, indexed_at FROM documents WHERE asset_type = 'markdown'")
        .all() as { path: string; indexed_at: string }[];
      const indexedMap = new Map(rows.map((r) => [r.path, Date.parse(r.indexed_at)]));

      let staleCount = 0;
      const seen = new Set<string>();
      const glob = new Glob("**/*.md");
      for (const path of glob.scanSync({ cwd: brain.root })) {
        if (brain.taxonomy.isExcludedPath(path)) continue;
        seen.add(path);
        const indexedAt = indexedMap.get(path);
        try {
          if (indexedAt === undefined || statSync(resolve(brain.root, path)).mtimeMs > indexedAt) {
            staleCount++;
          }
        } catch {
          // File vanished mid-scan — the deleted check below covers it.
        }
      }
      for (const path of indexedMap.keys()) if (!seen.has(path)) staleCount++;

      if (staleCount > 0) {
        warning = `index is stale (${staleCount} file(s) newer than index); run \`brain index\``;
      }
    } catch {
      // Never let the staleness probe break a read.
    }

    staleCache = { at: now, warning };
    return warning;
  };

  const textContent = (text: string, warnings: string[]) => {
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text }];
    if (warnings.length > 0) {
      content.push({ type: "text", text: warnings.map((w) => `warning: ${w}`).join("\n") });
    }
    return content;
  };

  const errorResult = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
  });
  const toolWarnings = (...warnings: Array<string | null>) => [
    ...(configWarning ? [configWarning] : []),
    ...warnings.filter((warning): warning is string => warning !== null),
  ];
  const degradedWriteError = () =>
    configError
      ? errorResult(
          new Error(
            `brain.config is invalid; write tools are disabled until it is fixed: ${configError.split("\n")[0]}`
          )
        )
      : null;

  const typeList = brain.taxonomy.validTypes().join(", ");

  const server = new McpServer(
    { name: "brain", version: packageVersion() },
    { instructions: serverInstructions(brain.config?.profile?.name) }
  );

  // ------------------------------------------------------------------------
  // 1. brain_search
  // ------------------------------------------------------------------------
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

  server.registerTool(
    "brain_search",
    {
      description:
        `Search the brain knowledge base using hybrid FTS5 + vector search. Returns documents matching a query with optional filters for type, tag, relevance, and search mode. \`limit\` defaults to 10 and returns at most ${MAX_SEARCH_LIMIT} results; a larger value is capped.`,
      inputSchema: {
        query: z.string().describe("Search query"),
        type: z.string().optional().describe(`Filter by document type (${typeList})`),
        tag: z.string().optional().describe("Filter by tag"),
        relevance: z.string().optional().describe("Filter by relevance (primary, secondary, historical)"),
        mode: z.enum(["fts", "vector", "hybrid"]).default("hybrid").describe("Search mode: fts, vector, or hybrid"),
        rerank: z.enum(["none", "heuristic"]).default("heuristic").describe("Reranking mode: none or heuristic"),
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
        if (params.mode !== "fts") await ensureVec();

        const opts: SearchOptions = {
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
          deadlineFrom: params.deadline_from ?? (params.upcoming ? new Date().toISOString().slice(0, 10) : undefined),
          deadlineTo: params.deadline_to,
          sort: params.sort ?? (params.upcoming ? "deadline" : undefined),
        };

        const { results, warnings } = await hybridSearch(db, opts, { embeddings, taxonomy: brain.taxonomy });
        const stale = indexStalenessWarning();
        if (stale) warnings.push(stale);
        if (configWarning) warnings.unshift(configWarning);

        const structured = {
          results: results.map((r) => ({
            path: r.path,
            title: r.title,
            type: r.type,
            relevance: r.relevance,
            status: r.status,
            summary: r.summary,
            updated: r.updated,
            deadline: r.deadline ?? null,
            tags: r.tags,
            score: r.score,
            snippet: r.snippet,
            ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
          })),
          warnings,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 2. brain_context
  // ------------------------------------------------------------------------
  server.registerTool(
    "brain_context",
    {
      description:
        "Assemble a token-limited context block about a topic from the brain, including identity and current focus sections. Useful for getting a comprehensive summary for a given topic. `max_tokens` defaults to 4000, estimated at about four characters per token, and the block never exceeds it. The identity and current-focus documents come first: whole when they fit, otherwise cut at a paragraph or heading boundary with a pointer to read the full file, and left out when not even that fits. Search results follow, each a header (path, updated date, status, summary) and a one-line snippet, included whole or skipped for the next one until fewer than 20 tokens remain; a document already shown is not repeated.",
      inputSchema: {
        query: z.string().describe("Topic to assemble context for"),
        max_tokens: z.number().default(4000).describe("Token budget for the assembled context"),
        include_identity: z.boolean().default(true).describe("Include identity section"),
        include_current_focus: z.boolean().default(true).describe("Include current focus section"),
      },
      outputSchema: {
        context: z.string(),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        await ensureVec();

        const context = await assembleContext(db, brain, {
          query: params.query,
          maxTokens: params.max_tokens,
          includeIdentity: params.include_identity,
          includeCurrentFocus: params.include_current_focus,
          embeddings,
        });

        const stale = indexStalenessWarning();
        const warnings = toolWarnings(stale);

        return {
          content: textContent(context, warnings),
          structuredContent: { context, warnings },
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 3. brain_read
  // ------------------------------------------------------------------------
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
        const fullPath = safeResolve(brain.root, params.path);
        if (!fullPath) return errorResult(new Error("path escapes the brain root directory"));

        const content = readDocumentPart(readFileSync(fullPath, "utf-8"), {
          section: params.section,
          maxTokens: params.max_tokens,
          sectionHint: 'section: "<heading>"',
        });
        const stale = indexStalenessWarning();
        return { content: textContent(content, toolWarnings(stale)) };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 4. brain_list
  // ------------------------------------------------------------------------
  const listedDocumentSchema = z.object({
    path: z.string(),
    title: z.string(),
    type: z.string(),
    relevance: z.string().nullish(),
    status: z.string().nullish(),
    tags: z.string().nullish(),
  });

  server.registerTool(
    "brain_list",
    {
      description:
        `List documents in the brain knowledge base with optional filters for type, tag, status, and relevance. Returns metadata (path, title, type, relevance, status, tags) for matching documents, newest first. \`limit\` defaults to 20 and returns at most ${MAX_LIST_LIMIT} documents; a larger value is capped.`,
      inputSchema: {
        type: z.string().optional().describe("Filter by document type"),
        tag: z.string().optional().describe("Filter by tag"),
        status: z.string().optional().describe("Filter by status (active, archived, draft)"),
        relevance: z.string().optional().describe("Filter by relevance (primary, secondary, historical)"),
        limit: z.number().default(20).describe("Max results to return"),
      },
      outputSchema: {
        documents: z.array(listedDocumentSchema),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const opts: SearchOptions = {
          type: params.type,
          tag: params.tag,
          status: params.status,
          relevance: params.relevance,
          includeArchived: params.status === "archived",
          limit: Math.min(Math.max(1, params.limit), MAX_LIST_LIMIT),
        };

        const results = filterSearch(db, opts);
        const stale = indexStalenessWarning();
        const warnings = toolWarnings(stale);

        const structured = {
          documents: results.map((r) => ({
            path: r.path,
            title: r.title,
            type: r.type,
            relevance: r.relevance,
            status: r.status,
            tags: r.tags,
          })),
          warnings,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 5. brain_graph
  // ------------------------------------------------------------------------
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
        const { edges, nodes } = walkLinks(db, { path: params.path, depth, direction: params.direction });

        const stale = indexStalenessWarning();
        const warnings = toolWarnings(stale);
        const structured = { edges, nodes, warnings };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 6. brain_add
  // ------------------------------------------------------------------------
  server.registerTool(
    "brain_add",
    {
      description:
        "Add new content to the brain knowledge base. Content is classified, given frontmatter, and written to the appropriate directory. Returns the action taken and the file path. Classification is rule-based, with no model call: content titled exactly like an existing document of an append-match type is appended to it, otherwise the brain's classifier hints pick the type, otherwise it lands in the inbox type. Pass `type` to choose it yourself.",
      inputSchema: {
        content: z.string().describe("Content to add"),
        type: z.string().optional().describe(`Document type (${typeList}). Defaults to auto-classification.`),
        title: z.string().optional().describe("Title for the document"),
        tags: z.string().optional().describe("Comma-separated tags"),
      },
    },
    async (params) => {
      const degraded = degradedWriteError();
      if (degraded) return degraded;
      try {
        const tagList = params.tags
          ? params.tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined;

        const result = await ingest(
          {
            content: params.content,
            type: params.type as DocumentType | undefined,
            title: params.title,
            tags: tagList,
          },
          db,
          { root: brain.root, taxonomy: brain.taxonomy }
        );

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 7. brain_update
  // ------------------------------------------------------------------------
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
      const degraded = degradedWriteError();
      if (degraded) return degraded;
      try {
        const fullPath = safeResolve(brain.root, params.path);
        if (!fullPath) return errorResult(new Error("path escapes the brain root directory"));
        if (!existsSync(fullPath) || !fullPath.endsWith(".md")) {
          return errorResult(new Error(`not an existing markdown document: ${params.path}`));
        }

        const raw = readFileSync(fullPath, "utf-8");
        const updates: Record<string, FrontmatterValue> = {};
        const changes: string[] = [];

        if (params.summary !== undefined) { updates.summary = params.summary; changes.push("summary"); }
        if (params.status !== undefined) { updates.status = params.status; changes.push("status"); }
        if (params.relevance !== undefined) { updates.relevance = params.relevance; changes.push("relevance"); }
        if (params.tags !== undefined) {
          updates.tags = params.tags.split(",").map((t) => t.trim()).filter(Boolean);
          changes.push("tags");
        }
        if (params.deadline !== undefined) {
          updates.deadline = params.deadline === "" ? null : params.deadline;
          changes.push("deadline");
        }
        if (params.next_review !== undefined) {
          updates.next_review = params.next_review === "" ? null : params.next_review;
          changes.push("next_review");
        }
        if (params.append_content) changes.push("content");

        // Archiving by a status edit applies brain_archive's relevance rule
        // (#450) to the effective relevance, including one set in this call.
        if (params.status === "archived") {
          const relevance = relevanceOnArchive(raw, params.relevance);
          if (relevance) {
            updates.relevance = relevance;
            if (!changes.includes("relevance")) changes.push("relevance");
          }
        }

        if (changes.length === 0) return errorResult(new Error("no changes specified"));

        const updated = new Date().toISOString().split("T")[0];
        updates.updated = updated;
        // Only these keys change; the rest of the frontmatter keeps its bytes (#449).
        writeFileSync(fullPath, updateDocument(raw, updates, params.append_content || undefined), "utf-8");
        await indexAll(db, { root: brain.root, taxonomy: brain.taxonomy, force: false, quiet: true });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ path: params.path, updated, changes }),
          }],
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------------
  // 8. brain_archive
  // ------------------------------------------------------------------------
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
      const degraded = degradedWriteError();
      if (degraded) return degraded;
      try {
        const result = await archiveDocument(brain.root, params.path, {
          dryRun: params.dry_run,
          db,
          reindex: params.dry_run
            ? undefined
            : (d) => indexAll(d, { root: brain.root, taxonomy: brain.taxonomy, force: false, quiet: true }),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // Note: brain_process was removed intentionally in the reference too — it
  // spawned a nested agent with write tools from within the server. Note
  // processing goes through the /process-notes skill (or `brain process`).

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
