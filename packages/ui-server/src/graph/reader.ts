/**
 * Read side of the knowledge graph.
 *
 * brain.db is opened read-only per request (the keyterm-builder precedent):
 * WAL makes concurrent readers cheap, and a short-lived handle means a
 * `brain sync` swapping the file underneath us can never leave the server
 * holding a stale page cache. ui-server has no dependency on core, so the
 * schema below is consumed as the documented direct-read contract, not as
 * imported types.
 *
 * Everything derived (metrics, communities, layout, root distances) is
 * precomputed by the CLI. What stays here is per-request work over the raw
 * `links` table: ego extraction and BFS from an arbitrary root, both of which
 * are too interactive to shell out for.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { basename, join } from "path";
import type {
  GraphCommunityPayload,
  GraphEdgePayload,
  GraphMaintenanceResponse,
  GraphMetaResponse,
  GraphNodePayload,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import { getBrainRoot } from "../files/walker.js";

/** brain.db schema that first carries the graph tables. */
export const MIN_SCHEMA_VERSION = 8;

/** Response caps. Over them, the lowest-pagerank nodes/edges are dropped. */
export const MAX_NODES = 5000;
export const MAX_EDGES = 20_000;
/** A neighborhood is meant to stay readable, so it caps well below MAX_NODES. */
export const MAX_NEIGHBORHOOD_NODES = 1500;

export const MAX_NEIGHBORHOOD_DEPTH = 3;
export const MAX_DISCOVERY_DEPTH = 8;

export type GraphDirection = "in" | "out" | "both";
export type GraphUnavailableReason = "schema" | "not_computed";

/** No graph to read: the repo predates schema v8, or nothing has computed one. */
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

export interface GraphReadOptions {
  /** Defaults to the repo the rest of the server reads (BRAIN_PATH). */
  brainPath?: string;
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

export const DEFAULT_STALE_DAYS = 180;

// --- db access -------------------------------------------------------------

function openDb(brainPath?: string): Database {
  const dbPath = join(brainPath ?? getBrainRoot(), "brain.db");
  if (!existsSync(dbPath)) throw new GraphUnavailableError("schema");
  return new Database(dbPath, { readonly: true });
}

function withDb<T>(brainPath: string | undefined, fn: (db: Database) => T): T {
  const db = openDb(brainPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const GRAPH_TABLES = ["graph_metrics", "graph_communities", "graph_root_distances", "graph_layouts"];

/**
 * A db can claim schema 8 in metadata and still lack the tables (a hand-copied
 * file, an interrupted migration), so presence is checked rather than trusted.
 */
function hasGraphTables(db: Database): boolean {
  const rows = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('graph_metrics', 'graph_communities', 'graph_root_distances', 'graph_layouts')`
    )
    .all();
  return rows.length === GRAPH_TABLES.length;
}

function readMetadata(db: Database): Map<string, string> {
  try {
    const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM index_metadata").all();
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    return new Map();
  }
}

function readSchemaVersion(meta: Map<string, string>): number {
  const parsed = Number.parseInt(meta.get("schema_version") ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireComputedGraph(db: Database, meta: Map<string, string>): void {
  if (readSchemaVersion(meta) < MIN_SCHEMA_VERSION || !hasGraphTables(db)) {
    throw new GraphUnavailableError("schema");
  }
  if (!meta.get("graph_computed_at")) throw new GraphUnavailableError("not_computed");
}

// --- node loading ----------------------------------------------------------

interface NodeRow {
  id: number;
  path: string;
  title: string;
  type: string;
  in_degree: number | null;
  out_degree: number | null;
  community: number | null;
  pagerank: number | null;
  x: number | null;
  y: number | null;
}

/** Only markdown notes are graph nodes; other assets carry no wiki links. */
const MARKDOWN_ONLY = "COALESCE(d.asset_type, 'markdown') = 'markdown'";

/**
 * The analytical columns come from tables that do not exist below schema v8,
 * so the select degrades to literals — that is what keeps the neighborhood
 * endpoint working against an older repo.
 */
function nodeSelect(withGraphTables: boolean, extraColumns = ""): string {
  const base = `d.id AS id, d.path AS path, d.title AS title, d.type AS type${extraColumns}`;
  if (!withGraphTables) {
    return `SELECT ${base},
        0 AS in_degree, 0 AS out_degree,
        NULL AS community, NULL AS pagerank, NULL AS x, NULL AS y
      FROM documents d`;
  }
  return `SELECT ${base},
      COALESCE(m.in_degree, 0) AS in_degree, COALESCE(m.out_degree, 0) AS out_degree,
      m.community AS community, m.pagerank AS pagerank, gl.x AS x, gl.y AS y
    FROM documents d
    LEFT JOIN graph_metrics m ON m.document_id = d.id
    LEFT JOIN graph_layouts gl ON gl.document_id = d.id AND gl.mode = 'clusters'`;
}

function toNode(row: NodeRow, distance?: number): GraphNodePayload {
  const node: GraphNodePayload = {
    id: row.id,
    path: row.path,
    title: row.title,
    type: row.type,
    inDegree: row.in_degree ?? 0,
    outDegree: row.out_degree ?? 0,
  };
  if (row.community != null) node.community = row.community;
  if (row.pagerank != null) node.pagerank = row.pagerank;
  if (row.x != null && row.y != null) {
    node.x = row.x;
    node.y = row.y;
  }
  if (distance !== undefined) node.distance = distance;
  return node;
}

/** Chunked so a large id set never runs into SQLite's bound-parameter limit. */
function loadNodesByIds(db: Database, ids: number[], withGraphTables: boolean): NodeRow[] {
  const out: NodeRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query<NodeRow, number[]>(
        `${nodeSelect(withGraphTables)} WHERE ${MARKDOWN_ONLY} AND d.id IN (${placeholders})`
      )
      .all(...chunk);
    out.push(...rows);
  }
  return out;
}

function lookupDocumentId(db: Database, path: string): number {
  const normalized = path.replace(/^\.?\//, "");
  const row = db
    .query<{ id: number }, [string]>(`SELECT d.id AS id FROM documents d WHERE ${MARKDOWN_ONLY} AND d.path = ?`)
    .get(normalized);
  if (!row) throw new GraphNotFoundError(path);
  return row.id;
}

// --- link structure --------------------------------------------------------

interface LinkStructure {
  edges: GraphEdgePayload[];
  out: Map<number, number[]>;
  in: Map<number, number[]>;
}

/**
 * The one definition of an edge, shared by the adjacency load and the meta
 * count so /api/graph/meta agrees with `brain graph stats`: one edge per
 * distinct (source, target) DOCUMENT pair — two wiki links that resolve to the
 * same note are one edge — self-links dropped, and both ends markdown, since
 * non-markdown assets are not graph nodes.
 */
const DISTINCT_EDGES_SQL = `SELECT DISTINCT l.source_id AS source, l.target_id AS target
    FROM links l
    JOIN documents d ON d.id = l.source_id AND ${MARKDOWN_ONLY}
    JOIN documents t ON t.id = l.target_id AND COALESCE(t.asset_type, 'markdown') = 'markdown'
   WHERE l.target_id IS NOT NULL AND l.target_id <> l.source_id`;

/** The whole link table as an edge list plus adjacency maps in both directions. */
function loadLinkStructure(db: Database): LinkStructure {
  const edges = db.query<GraphEdgePayload, []>(DISTINCT_EDGES_SQL).all();

  const out = new Map<number, number[]>();
  const inbound = new Map<number, number[]>();
  for (const edge of edges) {
    push(out, edge.source, edge.target);
    push(inbound, edge.target, edge.source);
  }
  return { edges, out, in: inbound };
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

interface BfsResult {
  distances: Map<number, number>;
  truncated: boolean;
}

/** Breadth-first walk, level by level, stopping at `maxDepth` or `limit` nodes. */
function bfs(
  structure: LinkStructure,
  start: number,
  direction: GraphDirection,
  maxDepth: number,
  limit: number
): BfsResult {
  const distances = new Map<number, number>([[start, 0]]);
  let frontier = [start];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0 && depth < maxDepth && !truncated) {
    depth++;
    const next: number[] = [];
    for (const id of frontier) {
      const neighbors: number[] = [];
      if (direction !== "in") neighbors.push(...(structure.out.get(id) ?? []));
      if (direction !== "out") neighbors.push(...(structure.in.get(id) ?? []));
      for (const neighbor of neighbors) {
        if (distances.has(neighbor)) continue;
        if (distances.size >= limit) {
          truncated = true;
          break;
        }
        distances.set(neighbor, depth);
        next.push(neighbor);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { distances, truncated };
}

// --- caps ------------------------------------------------------------------

/**
 * Trims a subgraph to the response caps, keeping the highest-pagerank nodes
 * (a virtual root always survives — dropping the thing the view is rooted on
 * would be nonsense). Edges are then filtered to the surviving node set, which
 * is also how a whole-corpus edge list is narrowed to the requested subgraph.
 */
function applyCaps(
  nodes: GraphNodePayload[],
  edges: GraphEdgePayload[],
  maxNodes: number
): GraphSubgraphResponse {
  let truncated = false;
  let keptNodes = nodes;

  if (nodes.length > maxNodes) {
    truncated = true;
    keptNodes = [...nodes]
      .sort((a, b) => Number(b.virtual ?? false) - Number(a.virtual ?? false) || (b.pagerank ?? 0) - (a.pagerank ?? 0))
      .slice(0, maxNodes);
  }

  const ids = new Set(keptNodes.map((n) => n.id));
  let keptEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));

  if (keptEdges.length > MAX_EDGES) {
    truncated = true;
    const rank = new Map(keptNodes.map((n) => [n.id, n.pagerank ?? 0]));
    keptEdges = keptEdges
      .map((edge) => ({ edge, weight: Math.min(rank.get(edge.source) ?? 0, rank.get(edge.target) ?? 0) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_EDGES)
      .map((entry) => entry.edge);
  }

  return { nodes: keptNodes, edges: keptEdges, truncated };
}

// --- meta ------------------------------------------------------------------

function countGraph(db: Database): { nodeCount: number; edgeCount: number } {
  try {
    const nodes = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM documents d WHERE ${MARKDOWN_ONLY}`)
      .get();
    const edges = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM (${DISTINCT_EDGES_SQL})`).get();
    return { nodeCount: nodes?.c ?? 0, edgeCount: edges?.c ?? 0 };
  } catch {
    return { nodeCount: 0, edgeCount: 0 };
  }
}

function parseDefaultRoot(meta: Map<string, string>): { path: string; virtual: boolean } | null {
  const raw = meta.get("graph_root");
  if (!raw) return null;
  if (raw.startsWith("virtual:")) return { path: raw.slice("virtual:".length), virtual: true };
  return { path: raw, virtual: false };
}

function parseRootLinks(meta: Map<string, string>): number[] {
  const raw = meta.get("graph_root_links");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isFinite(id)) : [];
  } catch {
    return [];
  }
}

function readCommunities(db: Database): GraphCommunityPayload[] {
  const rows = db
    .query<{ community: number; size: number; label: string | null; top_terms: string | null }, []>(
      "SELECT community, size, label, top_terms FROM graph_communities ORDER BY size DESC, community ASC"
    )
    .all();
  return rows.map((row) => {
    let topTerms: string[] = [];
    try {
      const parsed = row.top_terms ? JSON.parse(row.top_terms) : [];
      if (Array.isArray(parsed)) topTerms = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      topTerms = [];
    }
    return { community: row.community, size: row.size, label: row.label ?? null, topTerms };
  });
}

/**
 * An older CLI indexing a v8 repo leaves the graph tables untouched rather than
 * broken, so freshness is a comparison against the newest index run, not a
 * structural check.
 */
function isStale(db: Database, computedAt: string): boolean {
  const row = db.query<{ newest: string | null }, []>("SELECT MAX(indexed_at) AS newest FROM documents").get();
  if (!row?.newest) return false;
  const computed = Date.parse(computedAt);
  const indexed = Date.parse(row.newest);
  if (Number.isNaN(computed) || Number.isNaN(indexed)) return false;
  return computed < indexed;
}

export function getGraphMeta(opts: GraphReadOptions = {}): GraphMetaResponse {
  let db: Database;
  try {
    db = openDb(opts.brainPath);
  } catch {
    // No brain.db at all — indistinguishable, from the client's side, from a
    // repo whose schema is too old to carry a graph.
    return unavailable("schema", 0, { nodeCount: 0, edgeCount: 0 });
  }
  try {
    const meta = readMetadata(db);
    const schemaVersion = readSchemaVersion(meta);
    const counts = countGraph(db);

    if (schemaVersion < MIN_SCHEMA_VERSION || !hasGraphTables(db)) {
      return unavailable("schema", schemaVersion, counts);
    }
    const computedAt = meta.get("graph_computed_at") ?? null;
    if (!computedAt) return unavailable("not_computed", schemaVersion, counts);

    const response: GraphMetaResponse = {
      available: true,
      schemaVersion,
      computedAt,
      stale: isStale(db, computedAt),
      ...counts,
      communities: readCommunities(db),
      defaultRoot: parseDefaultRoot(meta),
    };
    if (meta.get("graph_layout_skipped") === "1") response.layoutSkipped = true;
    return response;
  } finally {
    db.close();
  }
}

function unavailable(
  reason: GraphUnavailableReason,
  schemaVersion: number,
  counts: { nodeCount: number; edgeCount: number }
): GraphMetaResponse {
  return {
    available: false,
    reason,
    schemaVersion,
    computedAt: null,
    stale: false,
    ...counts,
    communities: [],
    defaultRoot: null,
  };
}

// --- modes -----------------------------------------------------------------

export function getClusters(opts: ClustersOptions = {}): GraphSubgraphResponse {
  return withDb(opts.brainPath, (db) => {
    requireComputedGraph(db, readMetadata(db));

    const filters: string[] = [MARKDOWN_ONLY];
    const params: number[] = [];
    if (opts.community !== undefined) {
      filters.push("m.community = ?");
      params.push(opts.community);
    }
    if (!opts.includeIsolates) {
      filters.push("(COALESCE(m.in_degree, 0) + COALESCE(m.out_degree, 0)) > 0");
    }

    const rows = db
      .query<NodeRow, number[]>(
        `${nodeSelect(true)} WHERE ${filters.join(" AND ")} ORDER BY m.pagerank DESC, d.id ASC`
      )
      .all(...params);

    return applyCaps(
      rows.map((row) => toNode(row)),
      loadLinkStructure(db).edges,
      MAX_NODES
    );
  });
}

/**
 * Deliberately exempt from the schema gate: an ego graph needs nothing but the
 * `links` table, so the local mode stays useful on a repo that has never seen a
 * graph precompute.
 */
export function getNeighborhood(opts: NeighborhoodOptions): GraphSubgraphResponse {
  const depth = clamp(opts.depth ?? 1, 1, MAX_NEIGHBORHOOD_DEPTH);
  const direction = opts.direction ?? "both";

  return withDb(opts.brainPath, (db) => {
    const centerId = lookupDocumentId(db, opts.center);
    const withGraphTables = hasGraphTables(db);
    const structure = loadLinkStructure(db);
    const { distances, truncated } = bfs(structure, centerId, direction, depth, MAX_NEIGHBORHOOD_NODES);

    const rows = loadNodesByIds(db, [...distances.keys()], withGraphTables);
    const nodes = rows.map((row) => toNode(row, distances.get(row.id)));
    const capped = applyCaps(nodes, structure.edges, MAX_NEIGHBORHOOD_NODES);
    return { ...capped, truncated: capped.truncated || truncated };
  });
}

export function getDiscovery(opts: DiscoveryOptions = {}): GraphSubgraphResponse {
  const maxDepth = clamp(opts.maxDepth ?? MAX_DISCOVERY_DEPTH, 1, MAX_DISCOVERY_DEPTH);
  const direction = opts.direction ?? "out";

  return withDb(opts.brainPath, (db) => {
    const meta = readMetadata(db);
    requireComputedGraph(db, meta);
    const structure = loadLinkStructure(db);

    if (opts.root) {
      const rootId = lookupDocumentId(db, opts.root);
      const { distances, truncated } = bfs(structure, rootId, direction, maxDepth, MAX_NODES);
      const rows = loadNodesByIds(db, [...distances.keys()], true);
      const capped = applyCaps(
        rows.map((row) => toNode(row, distances.get(row.id))),
        structure.edges,
        MAX_NODES
      );
      return { ...capped, truncated: capped.truncated || truncated };
    }

    // Default root: the distances were computed at index time, so `direction`
    // does not apply here — the precomputed walk is the one that was run.
    const distanceRows = db
      .query<{ document_id: number; distance: number }, [number]>(
        "SELECT document_id, distance FROM graph_root_distances WHERE distance <= ?"
      )
      .all(maxDepth);
    const distances = new Map(distanceRows.map((row) => [row.document_id, row.distance]));

    const rows = loadNodesByIds(db, [...distances.keys()], true);
    const nodes = rows.map((row) => toNode(row, distances.get(row.id)));

    const root = parseDefaultRoot(meta);
    const edges = [...structure.edges];
    if (root?.virtual) {
      // The entry file is excluded from indexing, so it has no documents row:
      // the node standing in for it is synthesized here, at id 0.
      const rootLinks = parseRootLinks(meta).filter((id) => distances.has(id));
      nodes.unshift({
        id: 0,
        path: root.path,
        title: basename(root.path),
        type: "root",
        inDegree: 0,
        outDegree: rootLinks.length,
        distance: 0,
        virtual: true,
      });
      edges.unshift(...rootLinks.map((id) => ({ source: 0, target: id })));
    }

    return applyCaps(nodes, edges, MAX_NODES);
  });
}

export function getMaintenance(opts: MaintenanceOptions = {}): GraphMaintenanceResponse {
  const staleDays = clamp(opts.staleDays ?? DEFAULT_STALE_DAYS, 1, 3650);

  return withDb(opts.brainPath, (db) => {
    requireComputedGraph(db, readMetadata(db));

    const orphans = db
      .query<NodeRow, [number]>(
        `${nodeSelect(true)} WHERE ${MARKDOWN_ONLY}
           AND COALESCE(m.in_degree, 0) = 0 AND COALESCE(m.out_degree, 0) = 0
         ORDER BY d.updated DESC, d.id ASC LIMIT ?`
      )
      .all(MAX_NODES)
      .map((row) => toNode(row));

    // With no configured root nothing has a distance, and calling the whole
    // corpus unreachable would be noise rather than a finding.
    const rootedCount =
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM graph_root_distances").get()?.c ?? 0;
    const unreachable =
      rootedCount === 0
        ? []
        : db
            .query<NodeRow, [number]>(
              `${nodeSelect(true)}
                 LEFT JOIN graph_root_distances rd ON rd.document_id = d.id
               WHERE ${MARKDOWN_ONLY} AND rd.document_id IS NULL
               ORDER BY m.pagerank DESC, d.id ASC LIMIT ?`
            )
            .all(MAX_NODES)
            .map((row) => toNode(row));

    const brokenLinks = db
      .query<{ sourcePath: string; target: string }, [number]>(
        `SELECT d.path AS sourcePath, l.target AS target
           FROM links l JOIN documents d ON d.id = l.source_id
          WHERE l.target_id IS NULL
          ORDER BY d.path ASC, l.target ASC LIMIT ?`
      )
      .all(MAX_NODES);

    // `documents.updated` is a date, `indexed_at` a timestamp — compare on the
    // date prefix so a mix of both formats still sorts correctly.
    const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString().slice(0, 10);
    const stale = db
      .query<NodeRow & { updated: string }, [string, number]>(
        `${nodeSelect(true, ", d.updated AS updated")}
         WHERE ${MARKDOWN_ONLY} AND substr(d.updated, 1, 10) < ?
         ORDER BY d.updated ASC, d.id ASC LIMIT ?`
      )
      .all(cutoff, MAX_NODES)
      .map((row) => ({ ...toNode(row), updated: row.updated }));

    return { orphans, unreachable, brokenLinks, stale, staleDays };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
