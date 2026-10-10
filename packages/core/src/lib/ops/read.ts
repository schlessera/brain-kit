/**
 * The read operations behind the core MCP tools (`brain_search`,
 * `brain_context`, `brain_read`, `brain_list`). Each takes resolved
 * dependencies and already-validated input and returns the result object;
 * the MCP server keeps the schemas, the caps, the shared warnings and the
 * mapping to MCP content (#1349).
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { z } from "zod";

import type { BrainContext } from "../context.js";
import { assembleContext } from "../context-assembler.js";
import { readDocumentPart } from "../document-parts.js";
import { rerankSetup } from "../registry.js";
import { safeResolve } from "../safe-path.js";
import { filterSearch, hybridSearch } from "../search-engine.js";
import type { EmbeddingProvider } from "../seams.js";
import type { SearchOptions, SearchResult, SearchSort } from "../types.js";

/** What a read operation needs from the running brain. */
export interface ReadDeps {
  db: Database;
  brain: Pick<BrainContext, "root" | "config" | "taxonomy">;
  embeddings?: EmbeddingProvider;
}

export interface SearchInput {
  query: string;
  mode: NonNullable<SearchOptions["mode"]>;
  /** A reranker name; omitted selects the configured one, as `rerankSetup` decides. */
  rerank?: string;
  type?: string;
  tag?: string;
  relevance?: string;
  includeArchived: boolean;
  assetsOnly: boolean;
  /** Already within the caller's bounds. */
  limit: number;
  updatedSince?: string;
  updatedBefore?: string;
  deadlineFrom?: string;
  deadlineTo?: string;
  sort?: SearchSort;
  /** Same as deadlineFrom today and sort deadline; an explicit deadlineFrom or sort wins. */
  upcoming: boolean;
}

/** One search hit as the tools return it. */
export type SearchedDocument = Pick<
  SearchResult,
  "path" | "title" | "type" | "relevance" | "status" | "summary" | "updated" | "tags" | "score" | "snippet" | "supersededBy"
> & { deadline: string | null };

/** Hybrid search. `warnings` holds the reranker selection's warning first, then the search's own. */
export async function searchDocuments(
  deps: ReadDeps,
  input: SearchInput
): Promise<{ results: SearchedDocument[]; warnings: string[] }> {
  const setup = rerankSetup(deps.brain.config?.reranker, input.rerank);
  const opts: SearchOptions = {
    query: input.query,
    mode: input.mode,
    rerank: setup.rerank,
    type: input.type,
    tag: input.tag,
    relevance: input.relevance,
    includeArchived: input.includeArchived,
    assetsOnly: input.assetsOnly,
    limit: input.limit,
    updatedSince: input.updatedSince,
    updatedBefore: input.updatedBefore,
    deadlineFrom: input.deadlineFrom ?? (input.upcoming ? new Date().toISOString().slice(0, 10) : undefined),
    deadlineTo: input.deadlineTo,
    sort: input.sort ?? (input.upcoming ? "deadline" : undefined),
  };

  const { results, warnings } = await hybridSearch(deps.db, opts, {
    embeddings: deps.embeddings,
    taxonomy: deps.brain.taxonomy,
    ...setup.deps,
  });
  if (setup.warning) warnings.unshift(setup.warning);

  return {
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
}

export interface ContextInput {
  query: string;
  maxTokens: number;
  includeIdentity: boolean;
  includeCurrentFocus: boolean;
}

/** A topic briefing within a token budget. `warnings` reports a degraded lane or a reranker that did not run. */
export async function contextBriefing(
  deps: ReadDeps & { brain: BrainContext },
  input: ContextInput
): Promise<{ context: string; warnings: string[] }> {
  const warnings: string[] = [];
  const context = await assembleContext(deps.db, deps.brain, {
    query: input.query,
    maxTokens: input.maxTokens,
    includeIdentity: input.includeIdentity,
    includeCurrentFocus: input.includeCurrentFocus,
    embeddings: deps.embeddings,
    rerank: rerankSetup(deps.brain.config?.reranker),
    warnings,
  });
  return { context, warnings };
}

export interface ReadInput {
  path: string;
  section?: string;
  maxTokens?: number;
}

/** One document, one of its sections, or its outline. Throws when the path leaves the root. */
export function readDocument(root: string, input: ReadInput): string {
  const fullPath = safeResolve(root, input.path);
  if (!fullPath) throw new Error("path escapes the brain root directory");
  return readDocumentPart(readFileSync(fullPath, "utf-8"), {
    section: input.section,
    maxTokens: input.maxTokens,
    sectionHint: 'section: "<heading>"',
  });
}

/** `brain list` and `brain_list` return this many documents when no limit is given. */
export const DEFAULT_LIST_LIMIT = 20;
/** The largest `limit` `brain list` and `brain_list` accept. */
export const MAX_LIST_LIMIT = 100;

/**
 * The one list-limit rule both surfaces apply (#1351): a whole number from 1
 * to {@link MAX_LIST_LIMIT}. Anything else is rejected, never clamped.
 * `brain_list` uses it as its input schema; `brain list` runs its parsed
 * `--limit` through it.
 */
export const listLimitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT);

export interface ListInput {
  type?: string;
  tag?: string;
  status?: string;
  relevance?: string;
  /** Already validated against {@link listLimitSchema} by the caller; applied as given. */
  limit: number;
}

/** One listed document as the tools return it. */
export type ListedDocument = Pick<SearchResult, "path" | "title" | "type" | "relevance" | "status" | "tags">;

/** Documents matching the filters, newest first. Archived ones only when `status` asks for them. */
export function listDocuments(db: Database, input: ListInput): { documents: ListedDocument[] } {
  const results = filterSearch(db, {
    type: input.type,
    tag: input.tag,
    status: input.status,
    relevance: input.relevance,
    includeArchived: input.status === "archived",
    limit: input.limit,
  });
  return {
    documents: results.map((r) => ({
      path: r.path,
      title: r.title,
      type: r.type,
      relevance: r.relevance,
      status: r.status,
      tags: r.tags,
    })),
  };
}
