/**
 * The read operations behind the core MCP tools (`brain_search`,
 * `brain_context`, `brain_read`, `brain_list`, and `brain_list`'s paged form). Each takes resolved
 * dependencies and already-validated input and returns the result object;
 * the MCP server keeps the schemas, the caps, the shared warnings and the
 * mapping to MCP content (#1349).
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { z } from "zod";

import type { BrainContext } from "../context.js";
import { assembleContext, emptyContextCoverage, type ContextCoverage } from "../context-assembler.js";
import { MAX_SCOPE_ENTRIES, MAX_SCOPE_ENTRY_LENGTH } from "../context-scope.js";
import { readDocumentPart } from "../document-parts.js";
import {
  finishDocumentPage,
  selectDocumentPage,
  type DocumentPage,
  type DocumentPageInput,
} from "../document-page.js";
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
  /** The embedding provider whose key the host withheld from this agent worker (#1666). */
  withheldEmbeddings?: { provider: string; key: string };
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
    ...(deps.withheldEmbeddings ? { withheldEmbeddings: deps.withheldEmbeddings } : {}),
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

/**
 * One of `brain_context`'s scope lists as its input schema: at most
 * {@link MAX_SCOPE_ENTRIES} paths of 1 to {@link MAX_SCOPE_ENTRY_LENGTH}
 * characters. The entry rules (`scopeEntryError`) run in the assembler, so
 * every surface refuses the same entries with the same message.
 */
export const contextScopeListSchema = z.array(z.string().min(1).max(MAX_SCOPE_ENTRY_LENGTH)).max(MAX_SCOPE_ENTRIES);

/** A scoped briefing's coverage, as `brain_context` declares it in its output schema. */
export const contextCoverageSchema = z.object({
  exhaustive: z.literal(false),
  include: z.array(z.string()).nullable(),
  exclude: z.array(z.string()),
  excerpts: z.array(
    z.object({
      path: z.string(),
      lane: z.enum(["identity", "focus", "search", "related"]),
      form: z.enum(["whole", "cut", "section", "snippet", "summary"]),
    })
  ),
  omitted: z.array(z.object({ path: z.string(), reason: z.enum(["budget", "unavailable", "not_ranked", "excluded"]) })),
  omittedMore: z.number().int().min(0),
  budgetExhausted: z.boolean(),
}) satisfies z.ZodType<ContextCoverage>;

export interface ContextInput {
  query: string;
  maxTokens: number;
  includeIdentity: boolean;
  includeCurrentFocus: boolean;
  /** Paths the briefing may draw on (#3644); absent or empty, every path not excluded. */
  include?: readonly string[];
  /** Paths the briefing never draws on; an exclusion wins over an inclusion. */
  exclude?: readonly string[];
}

/**
 * A topic briefing within a token budget. `warnings` reports a degraded lane
 * or a reranker that did not run. `coverage` is present only when the input
 * carries a path scope: what the briefing holds and what it left out.
 */
export async function contextBriefing(
  deps: ReadDeps & { brain: BrainContext },
  input: ContextInput
): Promise<{ context: string; warnings: string[]; coverage?: ContextCoverage }> {
  const warnings: string[] = [];
  const scoped = (input.include?.length ?? 0) > 0 || (input.exclude?.length ?? 0) > 0;
  const coverage = scoped ? emptyContextCoverage() : undefined;
  const context = await assembleContext(deps.db, deps.brain, {
    query: input.query,
    maxTokens: input.maxTokens,
    includeIdentity: input.includeIdentity,
    includeCurrentFocus: input.includeCurrentFocus,
    embeddings: deps.embeddings,
    rerank: rerankSetup(deps.brain.config?.reranker),
    warnings,
    ...(scoped ? { scope: { include: input.include, exclude: input.exclude }, coverage } : {}),
  });
  return coverage ? { context, warnings, coverage } : { context, warnings };
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

/** `brain list --overview/--path-prefix/--cursor` and the matching `brain_list` inputs (#3643). */
export type PageInput = DocumentPageInput;

/**
 * One bounded page of the paged listing: the selection, cursor and output
 * bound shared with the `pageIndexDocuments` query. `warnings` are the
 * caller's own (config, staleness) and count against the bound. Throws
 * {@link DocumentPageError} for a bad prefix or cursor.
 */
export function pageDocuments(
  deps: { db: Database; root: string },
  input: PageInput,
  warnings: string[] = []
): DocumentPage {
  return finishDocumentPage(deps.root, selectDocumentPage(deps.db, input), { warnings });
}
