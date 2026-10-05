/**
 * Read side of the knowledge graph.
 *
 * Core owns every content-index read: its supported query entry opens the
 * index read-only per call, checks the layout each feature needs, pins one
 * snapshot and closes again (docs/content-index-queries.md). Nothing here
 * runs SQL or holds a native handle; this module only adapts core's results
 * and typed failures onto the HTTP payloads and errors the routes already
 * serve. The neighborhood BFS and every cap/default run in-process inside
 * core — no subprocess per click.
 */

import type {
  GraphMaintenanceResponse,
  GraphMetaResponse,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import type { GraphQueries, QueryCode, QueryResult } from "../core-queries.js";

export const MAX_NEIGHBORHOOD_DEPTH = 3;
export const MAX_DISCOVERY_DEPTH = 8;
export const DEFAULT_STALE_DAYS = 180;

export type GraphDirection = "in" | "out" | "both";
export type GraphUnavailableReason = "schema" | "not_computed";

/** No graph to read: the index is absent or predates the graph, or nothing computed one. */
export class GraphUnavailableError extends Error {
  constructor(readonly reason: GraphUnavailableReason) {
    super(`graph_unavailable: ${reason}`);
    this.name = "GraphUnavailableError";
  }
}

/** A center/root path that matches no indexed markdown document. */
export class GraphNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`not_found: ${path}`);
    this.name = "GraphNotFoundError";
  }
}

/** The index refused a read because another connection held its lock. */
export class GraphBusyError extends Error {
  constructor() {
    super("index_busy");
    this.name = "GraphBusyError";
  }
}

/**
 * The index could not be read for a reason that is not a described state:
 * corrupt, unreadable, or structurally unlike what it claims. Carries only
 * core's sanitized code.
 */
export class GraphIndexError extends Error {
  constructor(readonly code: QueryCode) {
    super(`graph_index_failure: ${code}`);
    this.name = "GraphIndexError";
  }
}

export interface GraphReadOptions {
  /** The brain repo to read — injected by the route layer from ServerConfig. */
  brainPath: string;
}

export interface ClustersOptions extends GraphReadOptions {
  community?: number;
  includeIsolates?: boolean;
}

export interface NeighborhoodOptions extends GraphReadOptions {
  center: string;
  depth?: number;
  direction?: GraphDirection;
}

export interface DiscoveryOptions extends GraphReadOptions {
  /** Omitted → the precomputed default root, virtual node included. */
  root?: string;
  direction?: "out" | "both";
  maxDepth?: number;
}

export interface MaintenanceOptions extends GraphReadOptions {
  staleDays?: number;
}

/**
 * Map a failed subgraph read onto the errors the routes render. A missing,
 * incompatible or corrupt index is the same "schema" unavailability the
 * client already degrades on — the server's own reader treated an unreadable
 * or structurally incomplete file that way too, because to a client none of
 * them has a graph to offer. `pathInput` names the path a not_found or
 * invalid_input refers to: a path core refuses as malformed matches no
 * indexed document either, so it keeps the 404 such a path always produced.
 */
function unwrap<T>(result: QueryResult<T>, pathInput?: string): T {
  if (result.ok) return result.value;
  const { code } = result.error;
  switch (code) {
    case "missing_index":
    case "incompatible_index":
    case "corrupt_index":
      throw new GraphUnavailableError("schema");
    case "not_computed":
      throw new GraphUnavailableError("not_computed");
    case "busy_index":
      throw new GraphBusyError();
    case "not_found":
    case "invalid_input":
      if (pathInput !== undefined) throw new GraphNotFoundError(pathInput);
      throw new GraphIndexError(code);
    default:
      throw new GraphIndexError(code);
  }
}

function unavailableMeta(): GraphMetaResponse {
  return {
    available: false,
    reason: "schema",
    schemaVersion: 0,
    computedAt: null,
    stale: false,
    nodeCount: 0,
    edgeCount: 0,
    communities: [],
    defaultRoot: null,
  };
}

/**
 * Meta always describes a state. An index that cannot be read at all —
 * absent, of an unsupported version, or not the layout it claims — is,
 * from the client's side, a repo with no graph to offer: "schema", version
 * 0, nothing counted. Only a lock wait is surfaced as a temporary failure.
 */
export function getGraphMeta(queries: GraphQueries, opts: GraphReadOptions): GraphMetaResponse {
  const result = queries.readGraphMeta({ brainPath: opts.brainPath });
  if (result.ok) return result.value;
  if (result.error.code === "busy_index") throw new GraphBusyError();
  return unavailableMeta();
}

export function getClusters(queries: GraphQueries, opts: ClustersOptions): GraphSubgraphResponse {
  return unwrap(
    queries.readGraphClusters({
      brainPath: opts.brainPath,
      ...(opts.community !== undefined ? { community: opts.community } : {}),
      includeIsolates: opts.includeIsolates ?? false,
    })
  );
}

/**
 * Works on an index that has never seen a graph precompute: an ego graph
 * needs only the raw links, so core serves it without analytics.
 */
export function getNeighborhood(queries: GraphQueries, opts: NeighborhoodOptions): GraphSubgraphResponse {
  return unwrap(
    queries.readGraphNeighborhood({
      brainPath: opts.brainPath,
      center: opts.center,
      depth: opts.depth ?? 1,
      direction: opts.direction ?? "both",
    }),
    opts.center
  );
}

export function getDiscovery(queries: GraphQueries, opts: DiscoveryOptions): GraphSubgraphResponse {
  return unwrap(
    queries.readGraphDiscovery({
      brainPath: opts.brainPath,
      ...(opts.root ? { root: opts.root } : {}),
      direction: opts.direction ?? "out",
      maxDepth: opts.maxDepth ?? MAX_DISCOVERY_DEPTH,
    }),
    opts.root || undefined
  );
}

export function getMaintenance(queries: GraphQueries, opts: MaintenanceOptions): GraphMaintenanceResponse {
  return unwrap(
    queries.readGraphMaintenance({
      brainPath: opts.brainPath,
      staleDays: opts.staleDays ?? DEFAULT_STALE_DAYS,
    })
  );
}
