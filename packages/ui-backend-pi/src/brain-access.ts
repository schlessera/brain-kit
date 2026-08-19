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
import { existsSync } from "fs";

import { readEnvVar } from "./config/env.js";

import {
  initContext,
  openDatabase,
  initVecSupport,
  hybridSearch,
  ingest,
  resolveEmbeddingProvider,
  safeResolve,
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
}

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
        // Vector support needs the query embeddings' dimensions; without an
        // embedding provider we stay FTS-only (hybridSearch degrades + warns).
        if (embeddings) await initVecSupport(db, embeddings.dimensions);
        return await hybridSearch(db, opts, { embeddings });
      } finally {
        db.close();
      }
    },

    async context(query: string, maxTokens = 4000): Promise<string> {
      const c = await ensureContext();
      const db = openRead(c.dbPath);
      try {
        if (embeddings) await initVecSupport(db, embeddings.dimensions);
        const { results, warnings } = await hybridSearch(
          db,
          { query, limit: 10 },
          { embeddings }
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
