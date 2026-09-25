/**
 * In-process bridge to @schlessera/brain: the pi backend calls hybridSearch /
 * ingest directly against the brain repo rather than shelling out to the
 * `brain` CLI or going over MCP. One BrainAccess is created per backend
 * instance (bound to a single brain repo at `brainPath`).
 *
 * Read paths (search, context) open the database read-only per call, mirroring
 * the CLI's read commands. The write path (add) opens it read-write and lets
 * ingest() reindex internally. Embeddings are resolved from the brain's config
 * when an API key is present; absent, search degrades to FTS-only (the same
 * keyless behaviour the CLI has with no configured key).
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "fs";

import { readEnvVar } from "./config/env.js";

import matter from "gray-matter";

import {
  archiveDocument,
  filterSearch,
  hybridSearch,
  indexAll,
  ingest,
  initContext,
  loadVecSupport,
  openDatabase,
  resolveEmbeddingProvider,
  safeResolve,
  stringifyDocument,
  type ArchiveResult,
  type BrainContext,
  type EmbeddingProvider,
  type SearchOptions,
  type SearchResponse,
  type IngestInput,
  type IngestOutcome,
} from "@schlessera/brain";

export interface BrainAccess {
  readonly root: string;
  /** Absolute path of the brain database file. */
  readonly dbPath: string;
  /** Resolve a repo-relative path, refusing anything that escapes the repo. */
  resolveInRepo(relPath: string): string | null;
  search(opts: SearchOptions): Promise<SearchResponse>;
  /** A token-limited, retrieval-focused context block for a query (markdown). */
  context(query: string, maxTokens?: number): Promise<string>;
  add(input: IngestInput): Promise<IngestOutcome>;
  /** Metadata-filtered listing (no query) — mirrors the brain_list MCP tool. */
  list(opts: ListOptions): Promise<ListedDocument[]>;
  /** Wiki-link graph traversal from a document — mirrors brain_graph. */
  graph(opts: GraphOptions): Promise<GraphEdge[]>;
  /** Frontmatter/body update on an existing document — mirrors brain_update. */
  update(input: UpdateInput): Promise<UpdateOutcome>;
  /** Archive a document (status + move + reindex) — mirrors brain_archive. */
  archive(relPath: string, dryRun?: boolean): Promise<ArchiveResult>;
}

export interface ListOptions {
  type?: string;
  tag?: string;
  status?: string;
  relevance?: string;
  limit?: number;
}

export interface ListedDocument {
  path: string;
  title: string;
  type: string;
  relevance: string | null;
  status: string | null;
  tags: string | null;
}

export interface GraphOptions {
  path: string;
  depth?: number;
  direction?: "outgoing" | "incoming" | "both";
}

export interface GraphEdge {
  source: string;
  target: string;
  resolved: boolean;
}

export interface UpdateInput {
  path: string;
  summary?: string;
  status?: "active" | "archived" | "draft";
  relevance?: "primary" | "secondary" | "historical";
  /** Replaces the existing tag list. */
  tags?: string[];
  /** Empty string removes the field. */
  deadline?: string;
  /** Empty string removes the field. */
  nextReview?: string;
  /** Markdown appended to the end of the document body. */
  appendContent?: string;
}

export interface UpdateOutcome {
  path: string;
  updated: string;
  changes: string[];
}

const MAX_LIST_LIMIT = 100;
const MAX_GRAPH_DEPTH = 4;

/** ~4 chars per token, matching core's context-assembler estimate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createBrainAccess(brainPath: string): BrainAccess {
  let ctx: BrainContext | undefined;
  let embeddings: EmbeddingProvider | undefined;
  let resolved = false;

  async function ensureContext(): Promise<BrainContext> {
    if (ctx) return ctx;
    // KNOWN LIMIT, and the one place the exec wrapper does not reach.
    //
    // `initContext` `await import`s the repository's `brain.config.ts`, which
    // is executable TypeScript owned by the brain, evaluated IN THIS PROCESS.
    // Every other subprocess in the three packages can be routed through
    // BRAIN_UI_EXEC_WRAPPER and run as somebody else; this one cannot, because
    // it is not a subprocess at all. A host that drops privileges for the
    // agent's children still evaluates this file as the server user.
    //
    // What it costs: the wrapper bounds what the agent's TOOLS can do, not
    // what the brain's own config can do. Anyone who can write
    // `brain.config.ts` in the repository already has the server's privileges,
    // wrapper or not.
    //
    // Why it is still here: closing it means every BrainAccess read —
    // search, list, graph, context assembly — going out through the CLI as a
    // subprocess, which is a different design for this package rather than a
    // patch to it. Tracked separately; see the exec-wrapper section of the
    // README.
    ctx = await initContext({ root: brainPath });
    if (!resolved) {
      embeddings = resolveEmbeddings(ctx);
      resolved = true;
    }
    return ctx;
  }

  function openRead(dbPath: string): Database {
    if (!existsSync(dbPath)) {
      throw new Error("Brain database not found — run `brain index` first.");
    }
    const db = openDatabase(dbPath, { readonly: true });
    return db;
  }

  return {
    get root() {
      return brainPath;
    },
    get dbPath() {
      return ctx?.dbPath ?? `${brainPath}/brain.db`;
    },

    resolveInRepo(relPath: string): string | null {
      return safeResolve(brainPath, relPath);
    },

    async search(opts: SearchOptions): Promise<SearchResponse> {
      const c = await ensureContext();
      const db = openRead(c.dbPath);
      try {
        // Read path: load the extension so stored vectors are queryable on
        // this connection. Without an embedding provider we stay FTS-only
        // (hybridSearch degrades + warns).
        await loadVecSupport(db);
        return await hybridSearch(db, opts, { embeddings, taxonomy: c.taxonomy });
      } finally {
        db.close();
      }
    },

    async context(query: string, maxTokens = 4000): Promise<string> {
      const c = await ensureContext();
      const db = openRead(c.dbPath);
      try {
        await loadVecSupport(db);
        const { results, warnings } = await hybridSearch(
          db,
          { query, limit: 10 },
          { embeddings, taxonomy: c.taxonomy }
        );
        // Identity / current-focus are intentionally NOT prepended here: the pi
        // session already loads AGENTS.md / CLAUDE.md (and the Layer-1 contract)
        // into its system context via the resource loader, so repeating them in
        // every brain_context call would only burn budget. This wrapper is the
        // retrieval half of core's assembleContext.
        let budget = maxTokens;
        const parts: string[] = [];
        for (const w of warnings) {
          const line = `> ${w}`;
          const cost = estimateTokens(line);
          if (budget - cost < 0) break;
          parts.push(line);
          budget -= cost;
        }
        for (const r of results) {
          const section = `\n### ${r.title} (${r.path})\n${r.snippet}`;
          const cost = estimateTokens(section);
          if (budget - cost < 0) break;
          parts.push(section);
          budget -= cost;
        }
        return parts.join("\n\n");
      } finally {
        db.close();
      }
    },

    async add(input: IngestInput): Promise<IngestOutcome> {
      const c = await ensureContext();
      // Writable handle; ingest() reindexes internally (incremental, no
      // embeddings) via its injected reindex → indexAll hook.
      const db = openDatabase(c.dbPath);
      try {
        return await ingest(input, db, { root: c.root, taxonomy: c.taxonomy });
      } finally {
        db.close();
      }
    },

    async list(opts: ListOptions): Promise<ListedDocument[]> {
      const c = await ensureContext();
      const db = openRead(c.dbPath);
      try {
        const results = filterSearch(db, {
          type: opts.type,
          tag: opts.tag,
          status: opts.status,
          relevance: opts.relevance,
          includeArchived: opts.status === "archived",
          limit: Math.min(Math.max(1, opts.limit ?? 20), MAX_LIST_LIMIT),
        });
        return results.map((r) => ({
          path: r.path,
          title: r.title,
          type: r.type,
          relevance: r.relevance ?? null,
          status: r.status ?? null,
          tags: r.tags ?? null,
        }));
      } finally {
        db.close();
      }
    },

    async graph(opts: GraphOptions): Promise<GraphEdge[]> {
      const c = await ensureContext();
      const db = openRead(c.dbPath);
      try {
        const edges: GraphEdge[] = [];
        const visited = new Set<string>();
        let frontier = new Set<string>([opts.path]);
        const depth = Math.min(Math.max(1, opts.depth ?? 1), MAX_GRAPH_DEPTH);
        const direction = opts.direction ?? "both";

        for (let hop = 0; hop < depth; hop++) {
          const nextFrontier = new Set<string>();
          for (const currentPath of frontier) {
            if (visited.has(currentPath)) continue;
            visited.add(currentPath);

            if (direction === "outgoing" || direction === "both") {
              const outgoing = db
                .prepare(
                  `SELECT d.path AS source, l.target, l.target_id
                   FROM links l
                   JOIN documents d ON d.id = l.source_id
                   WHERE d.path = ?`
                )
                .all(currentPath) as Array<{
                source: string;
                target: string;
                target_id: number | null;
              }>;
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

            if (direction === "incoming" || direction === "both") {
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
        return edges.filter((e) => {
          const key = `${e.source}->${e.target}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } finally {
        db.close();
      }
    },

    async update(input: UpdateInput): Promise<UpdateOutcome> {
      const c = await ensureContext();
      const fullPath = safeResolve(c.root, input.path);
      if (!fullPath) throw new Error("Path escapes the brain root directory.");
      if (!existsSync(fullPath) || !fullPath.endsWith(".md")) {
        throw new Error(`Not an existing markdown document: ${input.path}`);
      }

      const parsed = matter(readFileSync(fullPath, "utf-8"));
      const changes: string[] = [];

      if (input.summary !== undefined) {
        parsed.data.summary = input.summary;
        changes.push("summary");
      }
      if (input.status !== undefined) {
        parsed.data.status = input.status;
        changes.push("status");
      }
      if (input.relevance !== undefined) {
        parsed.data.relevance = input.relevance;
        changes.push("relevance");
      }
      if (input.tags !== undefined) {
        parsed.data.tags = input.tags;
        changes.push("tags");
      }
      if (input.deadline !== undefined) {
        if (input.deadline === "") delete parsed.data.deadline;
        else parsed.data.deadline = input.deadline;
        changes.push("deadline");
      }
      if (input.nextReview !== undefined) {
        if (input.nextReview === "") delete parsed.data.next_review;
        else parsed.data.next_review = input.nextReview;
        changes.push("next_review");
      }

      let content = parsed.content;
      if (input.appendContent) {
        content = content.replace(/\n*$/, "\n\n") + input.appendContent.trim() + "\n";
        changes.push("content");
      }

      if (changes.length === 0) throw new Error("No changes specified.");

      parsed.data.updated = new Date().toISOString().split("T")[0];
      writeFileSync(fullPath, stringifyDocument(content, parsed.data), "utf-8");

      const db = openDatabase(c.dbPath);
      try {
        await indexAll(db, { root: c.root, taxonomy: c.taxonomy, force: false, quiet: true });
      } finally {
        db.close();
      }
      return { path: input.path, updated: parsed.data.updated as string, changes };
    },

    async archive(relPath: string, dryRun = false): Promise<ArchiveResult> {
      const c = await ensureContext();
      const db = openDatabase(c.dbPath);
      try {
        return await archiveDocument(c.root, relPath, {
          dryRun,
          db,
          reindex: dryRun
            ? undefined
            : (d) => indexAll(d, { root: c.root, taxonomy: c.taxonomy, force: false, quiet: true }),
        });
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Resolve the brain's configured embedding provider, but only when its API key
 * is present in the environment. Any resolution error (bad built-in name,
 * missing key) degrades to undefined → FTS-only search, never a throw.
 */
function resolveEmbeddings(ctx: BrainContext): EmbeddingProvider | undefined {
  const embCfg = ctx.config?.embeddings;
  try {
    if (embCfg && typeof embCfg.provider !== "string") {
      // Custom provider value — used as-is, no key gating.
      return resolveEmbeddingProvider(embCfg);
    }
    const keyEnv = embCfg?.apiKeyEnv ?? "GEMINI_API_KEY";
    if (readEnvVar(keyEnv)) return resolveEmbeddingProvider(embCfg);
  } catch {
    /* degrade to FTS-only */
  }
  return undefined;
}
