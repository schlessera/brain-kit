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
import matter from "gray-matter";

import { initContext } from "./lib/context";
import { openDatabase, initVecSupport } from "./lib/db";
import { hybridSearch, filterSearch } from "./lib/search-engine";
import { assembleContext } from "./lib/context-assembler";
import { ingest } from "./lib/ingestion";
import { archiveDocument } from "./lib/archiver";
import { indexAll } from "./lib/indexer";
import { stringifyDocument } from "./lib/frontmatter";
import { safeResolve } from "./lib/safe-path";
import { resolveEmbeddingProvider } from "./lib/registry";
import { EMBEDDING_DIMENSIONS } from "./lib/models";
import type { SearchOptions, DocumentType } from "./lib/types";
import type { EmbeddingProvider } from "./lib/seams";

// Server-side result caps — agents can ask for less, never more.
const MAX_SEARCH_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_GRAPH_DEPTH = 5;

async function main() {
  const brain = await initContext();
  const dims = EMBEDDING_DIMENSIONS;

  // Embeddings resolve from config, but only when a key is present — otherwise
  // vector/hybrid degrade to FTS with a warning (same as keyless CLI).
  let embeddings: EmbeddingProvider | undefined;
  const embConfig = brain.config?.embeddings;
  const embCustom = embConfig && typeof embConfig.provider !== "string";
  const embKeyEnv = embConfig?.apiKeyEnv ?? "GEMINI_API_KEY";
  try {
    if (embCustom) embeddings = resolveEmbeddingProvider(embConfig);
    else if (process.env[embKeyEnv]) embeddings = resolveEmbeddingProvider(embConfig);
  } catch (e) {
    console.error(`brain MCP: embedding provider unavailable — ${(e as Error).message}`);
  }
  const embDims = embeddings?.dimensions ?? dims;

  const db = openDatabase(brain.dbPath, { embeddingDimensions: embDims });
  let vecReady = false;
  const ensureVec = async () => {
    if (!vecReady) vecReady = await initVecSupport(db, embDims);
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

  const typeList = brain.taxonomy.validTypes().join(", ");

  const server = new McpServer({ name: "brain", version: "1.0.0" });

  // ------------------------------------------------------------------------
  // 1. brain_search
  // ------------------------------------------------------------------------
  const searchResultSchema = z.object({
    path: z.string(),
    title: z.string(),
    type: z.string(),
    relevance: z.string().nullish(),
    tags: z.string().nullish(),
    score: z.number().nullish(),
    snippet: z.string().nullish(),
  });

  server.registerTool(
    "brain_search",
    {
      description:
        "Search the brain knowledge base using hybrid FTS5 + vector search. Returns documents matching a query with optional filters for type, tag, relevance, and search mode.",
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
        };

        const { results, warnings } = await hybridSearch(db, opts, { embeddings });
        const stale = indexStalenessWarning();
        if (stale) warnings.push(stale);

        const structured = {
          results: results.map((r) => ({
            path: r.path,
            title: r.title,
            type: r.type,
            relevance: r.relevance,
            tags: r.tags,
            score: r.score,
            snippet: r.snippet,
          })),
          warnings,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
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
        "Assemble a token-limited context block about a topic from the brain, including identity and current focus sections. Useful for getting a comprehensive summary for a given topic.",
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
        const warnings = stale ? [stale] : [];

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
        "Read a specific document from the brain knowledge base by its relative path. Returns the full file contents including frontmatter.",
      inputSchema: {
        path: z.string().describe('Relative path to the document (e.g., "me/identity.md")'),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const fullPath = safeResolve(brain.root, params.path);
        if (!fullPath) return errorResult(new Error("path escapes the brain root directory"));

        const content = readFileSync(fullPath, "utf-8");
        const stale = indexStalenessWarning();
        return { content: textContent(content, stale ? [stale] : []) };
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
        "List documents in the brain knowledge base with optional filters for type, tag, status, and relevance. Returns metadata (path, title, type, relevance, status, tags) for matching documents.",
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
        const warnings = stale ? [stale] : [];

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
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
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

  server.registerTool(
    "brain_graph",
    {
      description:
        "Traverse the wiki-link graph from a starting document. Returns edges (source, target, resolved) showing how documents are connected via [[wiki-links]].",
      inputSchema: {
        path: z.string().describe("Starting document path"),
        depth: z.number().default(1).describe("How many hops to traverse"),
        direction: z.enum(["outgoing", "incoming", "both"]).default("both").describe("Link direction to traverse"),
      },
      outputSchema: {
        edges: z.array(graphEdgeSchema),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const edges: Array<{ source: string; target: string; resolved: boolean }> = [];
        const visited = new Set<string>();
        let frontier = new Set<string>([params.path]);
        const depth = Math.min(Math.max(1, params.depth), MAX_GRAPH_DEPTH);

        for (let hop = 0; hop < depth; hop++) {
          const nextFrontier = new Set<string>();

          for (const currentPath of frontier) {
            if (visited.has(currentPath)) continue;
            visited.add(currentPath);

            if (params.direction === "outgoing" || params.direction === "both") {
              const outgoing = db
                .prepare(
                  `SELECT d.path AS source, l.target, l.target_id
                   FROM links l
                   JOIN documents d ON d.id = l.source_id
                   WHERE d.path = ?`
                )
                .all(currentPath) as Array<{ source: string; target: string; target_id: number | null }>;

              for (const row of outgoing) {
                let targetPath = row.target;
                let resolved = false;
                if (row.target_id) {
                  const targetDoc = db
                    .prepare("SELECT path FROM documents WHERE id = ?")
                    .get(row.target_id) as { path: string } | null;
                  if (targetDoc) {
                    targetPath = targetDoc.path;
                    resolved = true;
                  }
                }
                edges.push({ source: row.source, target: targetPath, resolved });
                if (resolved) nextFrontier.add(targetPath);
              }
            }

            if (params.direction === "incoming" || params.direction === "both") {
              const incoming = db
                .prepare(
                  `SELECT d2.path AS source, d.path AS target
                   FROM links l
                   JOIN documents d ON d.id = l.target_id
                   JOIN documents d2 ON d2.id = l.source_id
                   WHERE d.path = ?`
                )
                .all(currentPath) as Array<{ source: string; target: string }>;

              for (const row of incoming) {
                edges.push({ source: row.source, target: row.target, resolved: true });
                nextFrontier.add(row.source);
              }
            }
          }

          frontier = nextFrontier;
        }

        const seen = new Set<string>();
        const uniqueEdges = edges.filter((e) => {
          const key = `${e.source}->${e.target}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const stale = indexStalenessWarning();
        const warnings = stale ? [stale] : [];
        const structured = { edges: uniqueEdges, warnings };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
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
        "Add new content to the brain knowledge base. Content is classified, given frontmatter, and written to the appropriate directory. Returns the action taken and the file path.",
      inputSchema: {
        content: z.string().describe("Content to add"),
        type: z.string().optional().describe(`Document type (${typeList}). Defaults to auto-classification.`),
        title: z.string().optional().describe("Title for the document"),
        tags: z.string().optional().describe("Comma-separated tags"),
      },
    },
    async (params) => {
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

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
        "Update an existing brain document: set frontmatter fields (summary, status, relevance, tags, deadline, next_review) and/or append a markdown section to the body. Bumps the `updated` field and reindexes. Does not create files — use brain_add for that.",
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
      try {
        const fullPath = safeResolve(brain.root, params.path);
        if (!fullPath) return errorResult(new Error("path escapes the brain root directory"));
        if (!existsSync(fullPath) || !fullPath.endsWith(".md")) {
          return errorResult(new Error(`not an existing markdown document: ${params.path}`));
        }

        const parsed = matter(readFileSync(fullPath, "utf-8"));
        const changes: string[] = [];

        if (params.summary !== undefined) { parsed.data.summary = params.summary; changes.push("summary"); }
        if (params.status !== undefined) { parsed.data.status = params.status; changes.push("status"); }
        if (params.relevance !== undefined) { parsed.data.relevance = params.relevance; changes.push("relevance"); }
        if (params.tags !== undefined) {
          parsed.data.tags = params.tags.split(",").map((t) => t.trim()).filter(Boolean);
          changes.push("tags");
        }
        if (params.deadline !== undefined) {
          if (params.deadline === "") delete parsed.data.deadline;
          else parsed.data.deadline = params.deadline;
          changes.push("deadline");
        }
        if (params.next_review !== undefined) {
          if (params.next_review === "") delete parsed.data.next_review;
          else parsed.data.next_review = params.next_review;
          changes.push("next_review");
        }

        let content = parsed.content;
        if (params.append_content) {
          content = content.replace(/\n*$/, "\n\n") + params.append_content.trim() + "\n";
          changes.push("content");
        }

        if (changes.length === 0) return errorResult(new Error("no changes specified"));

        parsed.data.updated = new Date().toISOString().split("T")[0];
        writeFileSync(fullPath, stringifyDocument(content, parsed.data), "utf-8");
        await indexAll(db, { root: brain.root, taxonomy: brain.taxonomy, force: false, quiet: true });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ path: params.path, updated: parsed.data.updated, changes }, null, 2),
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
        "Archive a brain document: sets status to archived, moves projects/active/ files to projects/archive/, and reindexes. Use dry_run to preview.",
      inputSchema: {
        path: z.string().describe("Relative path to the document"),
        dry_run: z.boolean().default(false).describe("Preview without changing anything"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (params) => {
      try {
        const result = await archiveDocument(brain.root, params.path, {
          dryRun: params.dry_run,
          db,
          reindex: params.dry_run
            ? undefined
            : (d) => indexAll(d, { root: brain.root, taxonomy: brain.taxonomy, force: false, quiet: true }),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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

main().catch((e) => {
  console.error("Fatal error starting brain MCP server:", e);
  process.exit(1);
});
