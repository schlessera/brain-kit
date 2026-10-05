/**
 * Root-bound content-index queries handed to module hygiene checks (#699).
 * Core binds the brain root once; callers pass the standalone options without
 * `brainPath`, and nothing they pass or mutate later can redirect a query.
 */
import { resolve } from "path";
import * as standalone from "./index.js";
import type { GraphMeta, LinkWalk, ListedDocument, DocumentCandidate, Maintenance, QueryResult, Subgraph, VoiceVocabulary } from "./types.js";

type Bound<F extends (opts: never) => unknown> = Omit<Parameters<F>[0], "brainPath">;

/**
 * The nine supported query operations, bound to one brain root. Options and
 * results are those of `@schlessera/brain/queries` without `brainPath`.
 * @experimental Until 1.0; follows the shared integration contract.
 */
export interface ContentIndexQueries {
  readGraphMeta(): QueryResult<GraphMeta>;
  readGraphClusters(opts?: Bound<typeof standalone.readGraphClusters>): QueryResult<Subgraph>;
  readGraphNeighborhood(opts: Bound<typeof standalone.readGraphNeighborhood>): QueryResult<Subgraph>;
  readGraphDiscovery(opts?: Bound<typeof standalone.readGraphDiscovery>): QueryResult<Subgraph>;
  readGraphMaintenance(opts?: Bound<typeof standalone.readGraphMaintenance>): QueryResult<Maintenance>;
  readLinkWalk(opts: Bound<typeof standalone.readLinkWalk>): QueryResult<LinkWalk>;
  readVoiceVocabulary(opts: Bound<typeof standalone.readVoiceVocabulary>): QueryResult<VoiceVocabulary>;
  listIndexDocuments(opts?: Bound<typeof standalone.listIndexDocuments>): QueryResult<ListedDocument[]>;
  findIndexDocuments(opts?: Bound<typeof standalone.findIndexDocuments>): QueryResult<DocumentCandidate[]>;
}

const INVALID = { ok: false, error: { code: "invalid_input", retryable: false } } as const;

/**
 * Core-internal: build the frozen root-bound query object. The root is
 * resolved once, so a later working-directory change or `ctx.root` mutation
 * cannot move it. Options are copied before the bound root is applied, so a
 * caller-supplied `brainPath` (or a getter for one) never reaches a query.
 */
export function bindContentIndexQueries(root: string): ContentIndexQueries {
  // An unusable root stays unusable: the standalone validation then answers
  // `invalid_input` instead of `resolve("")` silently meaning the cwd.
  const brainPath = typeof root === "string" && root.trim() !== "" && !/[\x00-\x1f]/.test(root) ? resolve(root) : "";
  function call<O, T>(fn: (opts: O) => QueryResult<T>, opts: unknown): QueryResult<T> {
    let copy: Record<string, unknown>;
    try {
      copy = { ...(opts === undefined ? {} : (opts as object)) } as Record<string, unknown>;
    } catch {
      return INVALID;
    }
    return fn({ ...copy, brainPath } as O);
  }
  return Object.freeze({
    readGraphMeta: () => standalone.readGraphMeta({ brainPath }),
    readGraphClusters: (opts?: unknown) => call(standalone.readGraphClusters, opts),
    readGraphNeighborhood: (opts: unknown) => call(standalone.readGraphNeighborhood, opts),
    readGraphDiscovery: (opts?: unknown) => call(standalone.readGraphDiscovery, opts),
    readGraphMaintenance: (opts?: unknown) => call(standalone.readGraphMaintenance, opts),
    readLinkWalk: (opts: unknown) => call(standalone.readLinkWalk, opts),
    readVoiceVocabulary: (opts: unknown) => call(standalone.readVoiceVocabulary, opts),
    listIndexDocuments: (opts?: unknown) => call(standalone.listIndexDocuments, opts),
    findIndexDocuments: (opts?: unknown) => call(standalone.findIndexDocuments, opts),
  }) as ContentIndexQueries;
}
