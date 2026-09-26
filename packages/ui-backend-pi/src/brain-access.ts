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


import {
  archiveDocument,
  assembleContext,
  estimateTokens,
  filterSearch,
  hybridSearch,
  indexAll,
  ingest,
  initContext,
  loadVecSupport,
  openDatabase,
  relevanceOnArchive,
  resolveEmbeddingProvider,
  safeResolve,
  updateDocument,
  type ArchiveResult,
  type BrainContext,
  type EmbeddingProvider,
  type FrontmatterValue,
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
  /** Wiki-link graph traversal from a document, with the documents it touches — mirrors brain_graph. */
  graph(opts: GraphOptions): Promise<GraphResult>;
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

/** A document an edge touches: every source, and every resolved target. */
export interface GraphNode {
  path: string;
  title: string;
  type: string;
  summary: string | null;
  updated: string | null;
}

export interface GraphResult {
  edges: GraphEdge[];
  /** Sorted by path. An unresolved target is link text, never a node. */
  nodes: GraphNode[];
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
        // Identity / current-focus are intentionally NOT included here: the pi
        // session already loads AGENTS.md / CLAUDE.md (and the Layer-1 contract)
        // into its system context via the resource loader, so repeating them in
        // every brain_context call would only burn budget. Everything else is
        // core's assembler, so pi's hits read exactly like `brain context`'s.
        const warnings: string[] = [];
        const block = await assembleContext(db, c, {
          query,
          maxTokens,
          includeIdentity: false,
          includeCurrentFocus: false,
          embeddings,
          warnings,
        });
        // Warnings lead the block, in whatever budget the block left over.
        let budget = maxTokens - (block ? estimateTokens(block) : 0);
        const lines: string[] = [];
        for (const w of warnings) {
          const line = `> ${w.replace(/\s+/g, " ")}`;
          const cost = estimateTokens(`${line}\n\n`);
          if (cost > budget) break;
          lines.push(line);
          budget -= cost;
        }
        return [...lines, ...(block ? [block] : [])].join("\n\n");
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

    async graph(opts: GraphOptions): Promise<GraphResult> {
      const c = await ensureContext();
      const db = openRead(c.dbPath);
      try {
        // One read transaction: the edges and their nodes come from one
        // snapshot even while another process reindexes.
        return db.transaction((): GraphResult => {
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
          const unique = edges.filter((e) => {
            const key = `${e.source}->${e.target}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          const touched = new Set<string>();
          for (const e of unique) {
            touched.add(e.source);
            if (e.resolved) touched.add(e.target);
          }
          const nodes = db
            .prepare(
              `SELECT path, title, type, summary, updated FROM documents
               WHERE path IN (SELECT value FROM json_each(?))
               ORDER BY path`
            )
            .all(JSON.stringify([...touched])) as GraphNode[];
          return { edges: unique, nodes };
        })();
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

      const raw = readFileSync(fullPath, "utf-8");
      const updates: Record<string, FrontmatterValue> = {};
      const changes: string[] = [];

      if (input.summary !== undefined) {
        updates.summary = input.summary;
        changes.push("summary");
      }
      if (input.status !== undefined) {
        updates.status = input.status;
        changes.push("status");
      }
      if (input.relevance !== undefined) {
        updates.relevance = input.relevance;
        changes.push("relevance");
      }
      if (input.tags !== undefined) {
        updates.tags = input.tags;
        changes.push("tags");
      }
      if (input.deadline !== undefined) {
        updates.deadline = input.deadline === "" ? null : input.deadline;
        changes.push("deadline");
      }
      if (input.nextReview !== undefined) {
        updates.next_review = input.nextReview === "" ? null : input.nextReview;
        changes.push("next_review");
      }
      if (input.appendContent) changes.push("content");
      // Archiving by a status edit applies brain_archive's relevance rule
      // (#450) to the effective relevance, including one set in this call.
      if (input.status === "archived") {
        const relevance = relevanceOnArchive(raw, input.relevance);
        if (relevance) {
          updates.relevance = relevance;
          if (!changes.includes("relevance")) changes.push("relevance");
        }
      }

      if (changes.length === 0) throw new Error("No changes specified.");

      const updated = new Date().toISOString().split("T")[0];
      updates.updated = updated;
      // Only these keys change; the rest of the frontmatter keeps its bytes (#449).
      writeFileSync(fullPath, updateDocument(raw, updates, input.appendContent || undefined), "utf-8");

      const db = openDatabase(c.dbPath);
      try {
        await indexAll(db, { root: c.root, taxonomy: c.taxonomy, force: false, quiet: true });
      } finally {
        db.close();
      }
      return { path: input.path, updated, changes };
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
