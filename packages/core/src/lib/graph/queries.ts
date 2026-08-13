/**
 * Read side of the graph, used by the `brain graph` CLI.
 *
 * ui-server has its own reader over the same tables (it deliberately does not
 * depend on core). Both are governed by docs/integration-contract.md — change
 * the table shapes and both must move.
 */

import type { Database } from "bun:sqlite";

import type {
  GraphDirection,
  GraphEdgeRecord,
  GraphQueryNode,
  GraphSubgraph,
} from "./types.js";

/** Depth beyond this stops being a neighbourhood and becomes the whole vault. */
export const MAX_EGO_DEPTH = 3;
/** Discovery rings past this are noise at any realistic corpus size. */
export const MAX_DISCOVERY_DEPTH = 8;
/** Default staleness horizon, matching the core taxonomy default. */
export const DEFAULT_STALE_DAYS = 180;
/** The synthesized virtual-root node; no document carries id 0. */
export const VIRTUAL_ROOT_ID = 0;

interface DocumentRow {
  id: number;
  path: string;
  title: string;
  type: string;
  updated: string;
}

interface MetricsRow {
  document_id: number;
  in_degree: number;
  out_degree: number;
  component: number;
  pagerank: number;
  community: number | null;
}

/**
 * Nodes, both adjacency directions and degrees, straight from `links` — no
 * derived table involved. Every mode that walks the graph per request (ego,
 * arbitrary-root discovery, orphan detection) runs off this, so those modes
 * keep working before the first precompute.
 */
interface Adjacency {
  docs: Map<number, DocumentRow>;
  idByPath: Map<string, number>;
  out: Map<number, number[]>;
  in: Map<number, number[]>;
  edges: GraphEdgeRecord[];
}

function loadAdjacency(db: Database): Adjacency {
  const docs = new Map<number, DocumentRow>();
  const idByPath = new Map<string, number>();
  const rows = db
    .prepare(
      `SELECT id, path, title, type, updated
       FROM documents WHERE asset_type = 'markdown' ORDER BY id`
    )
    .all() as DocumentRow[];
  for (const row of rows) {
    docs.set(row.id, row);
    idByPath.set(row.path, row.id);
  }

  const out = new Map<number, number[]>();
  const inbound = new Map<number, number[]>();
  const edges: GraphEdgeRecord[] = [];
  const seen = new Set<string>();

  const linkRows = db
    .prepare(
      `SELECT source_id AS source, target_id AS target
       FROM links WHERE target_id IS NOT NULL ORDER BY source_id, target_id`
    )
    .all() as { source: number; target: number }[];

  for (const link of linkRows) {
    if (!docs.has(link.source) || !docs.has(link.target)) continue;
    if (link.source === link.target) continue;
    const key = `${link.source}>${link.target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({ source: link.source, target: link.target });

    const outbound = out.get(link.source);
    if (outbound) outbound.push(link.target);
    else out.set(link.source, [link.target]);

    const incoming = inbound.get(link.target);
    if (incoming) incoming.push(link.source);
    else inbound.set(link.target, [link.source]);
  }

  return { docs, idByPath, out, in: inbound, edges };
}

function neighbors(adjacency: Adjacency, id: number, direction: GraphDirection): number[] {
  if (direction === "out") return adjacency.out.get(id) ?? [];
  if (direction === "in") return adjacency.in.get(id) ?? [];
  return [...(adjacency.out.get(id) ?? []), ...(adjacency.in.get(id) ?? [])];
}

/**
 * A read-only connection never runs migrations, so these tables are simply
 * absent on a pre-v8 database. Missing derived data degrades every mode to the
 * links-only view rather than failing the command.
 */
function queryOrEmpty<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } catch {
    return [];
  }
}

function loadMetrics(db: Database): Map<number, MetricsRow> {
  const metrics = new Map<number, MetricsRow>();
  for (const row of queryOrEmpty<MetricsRow>(db, "SELECT * FROM graph_metrics")) {
    metrics.set(row.document_id, row);
  }
  return metrics;
}

function loadLayout(db: Database, mode = "clusters"): Map<number, { x: number; y: number }> {
  const layout = new Map<number, { x: number; y: number }>();
  const rows = queryOrEmpty<{ id: number; x: number; y: number }>(
    db,
    "SELECT document_id AS id, x, y FROM graph_layouts WHERE mode = ?",
    [mode]
  );
  for (const row of rows) layout.set(row.id, { x: row.x, y: row.y });
  return layout;
}

/** Assemble one node, taking degrees from adjacency and the rest from metrics. */
function toNode(
  doc: DocumentRow,
  adjacency: Adjacency,
  metrics?: MetricsRow,
  extra: Partial<GraphQueryNode> = {}
): GraphQueryNode {
  const node: GraphQueryNode = {
    id: doc.id,
    path: doc.path,
    title: doc.title,
    type: doc.type,
    inDegree: metrics?.in_degree ?? (adjacency.in.get(doc.id) ?? []).length,
    outDegree: metrics?.out_degree ?? (adjacency.out.get(doc.id) ?? []).length,
  };
  if (metrics) {
    if (metrics.community !== null) node.community = metrics.community;
    node.pagerank = metrics.pagerank;
  }
  return { ...node, ...extra };
}

/** Edges with both endpoints inside `ids`. */
function inducedEdges(adjacency: Adjacency, ids: Set<number>): GraphEdgeRecord[] {
  return adjacency.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
}

export interface ClusterGraphOptions {
  /** Restrict to one community. */
  community?: number;
  /** Include nodes with no links at all (default: yes). */
  includeIsolates?: boolean;
}

/**
 * The whole vault with its precomputed communities and layout. Empty until the
 * first v8 index run — the caller reports that, this returns no rows.
 */
export function getClusterGraph(db: Database, options: ClusterGraphOptions = {}): GraphSubgraph {
  const adjacency = loadAdjacency(db);
  const metrics = loadMetrics(db);
  const layout = loadLayout(db);
  const includeIsolates = options.includeIsolates ?? true;

  const nodes: GraphQueryNode[] = [];
  const ids = new Set<number>();
  for (const doc of adjacency.docs.values()) {
    const nodeMetrics = metrics.get(doc.id);
    if (options.community !== undefined && nodeMetrics?.community !== options.community) continue;

    const degree =
      (adjacency.out.get(doc.id) ?? []).length + (adjacency.in.get(doc.id) ?? []).length;
    if (!includeIsolates && degree === 0) continue;

    const position = layout.get(doc.id);
    nodes.push(toNode(doc, adjacency, nodeMetrics, position ? { x: position.x, y: position.y } : {}));
    ids.add(doc.id);
  }

  return { nodes, edges: inducedEdges(adjacency, ids), truncated: false };
}

export interface EgoGraphOptions {
  /** Document path at the centre. */
  center: string;
  depth?: number;
  direction?: GraphDirection;
}

/**
 * The neighbourhood around one note. Runs entirely off `links`, so it is the
 * one mode that works against a database that has never been precomputed.
 */
export function getEgoGraph(db: Database, options: EgoGraphOptions): GraphSubgraph {
  const adjacency = loadAdjacency(db);
  const metrics = loadMetrics(db);
  const depth = Math.min(Math.max(options.depth ?? 1, 1), MAX_EGO_DEPTH);
  const direction = options.direction ?? "both";

  const centerId = adjacency.idByPath.get(options.center);
  if (centerId === undefined) return { nodes: [], edges: [], truncated: false };

  const distances = new Map<number, number>([[centerId, 0]]);
  let frontier = [centerId];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const neighbor of neighbors(adjacency, id, direction)) {
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, hop);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  const ids = new Set(distances.keys());
  const nodes = [...distances.entries()].map(([id, distance]) =>
    toNode(adjacency.docs.get(id)!, adjacency, metrics.get(id), { distance })
  );

  return { nodes, edges: inducedEdges(adjacency, ids), truncated: false };
}

export interface DiscoveryGraphOptions {
  /** Document path to start from; omitted → the precomputed default root. */
  root?: string;
  direction?: GraphDirection;
  maxDepth?: number;
}

/**
 * Rings outward from a root. With an explicit root this is a per-request BFS;
 * without one it replays the precomputed `graph_root_distances`, which is the
 * only place a virtual root exists — it has no documents row, so a node with
 * id 0 is synthesized for it here.
 */
export function getDiscoveryGraph(
  db: Database,
  options: DiscoveryGraphOptions = {}
): GraphSubgraph {
  const adjacency = loadAdjacency(db);
  const metrics = loadMetrics(db);
  const direction = options.direction ?? "out";
  const maxDepth = Math.min(Math.max(options.maxDepth ?? MAX_DISCOVERY_DEPTH, 1), MAX_DISCOVERY_DEPTH);

  if (options.root) {
    const rootId = adjacency.idByPath.get(options.root);
    if (rootId === undefined) return { nodes: [], edges: [], truncated: false };

    const distances = new Map<number, number>([[rootId, 0]]);
    let frontier = [rootId];
    for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const neighbor of neighbors(adjacency, id, direction)) {
          if (distances.has(neighbor)) continue;
          distances.set(neighbor, hop);
          next.push(neighbor);
        }
      }
      frontier = next;
    }

    const ids = new Set(distances.keys());
    const nodes = [...distances.entries()].map(([id, distance]) =>
      toNode(adjacency.docs.get(id)!, adjacency, metrics.get(id), { distance })
    );
    return { nodes, edges: inducedEdges(adjacency, ids), truncated: false };
  }

  const rootKey = getGraphMetaValue(db, "graph_root");
  const rows = queryOrEmpty<{ id: number; distance: number; parentId: number | null }>(
    db,
    "SELECT document_id AS id, distance, parent_id AS parentId FROM graph_root_distances"
  );

  const nodes: GraphQueryNode[] = [];
  const ids = new Set<number>();
  for (const row of rows) {
    const doc = adjacency.docs.get(row.id);
    if (!doc || row.distance > maxDepth) continue;
    nodes.push(toNode(doc, adjacency, metrics.get(row.id), { distance: row.distance }));
    ids.add(row.id);
  }

  const edges = inducedEdges(adjacency, ids);

  // A virtual root is drawn from its recorded seed list; an indexed root is
  // already one of the nodes above at distance 0.
  if (rootKey?.startsWith("virtual:")) {
    const path = rootKey.slice("virtual:".length);
    nodes.unshift({
      id: VIRTUAL_ROOT_ID,
      path,
      title: path,
      type: "index",
      inDegree: 0,
      outDegree: 0,
      distance: 0,
      virtual: true,
    });
    for (const seedId of readRootLinks(db)) {
      if (ids.has(seedId)) edges.push({ source: VIRTUAL_ROOT_ID, target: seedId });
    }
  }

  return { nodes, edges, truncated: false };
}

export interface MaintenanceOptions {
  staleDays?: number;
}

export interface MaintenanceFindings {
  staleDays: number;
  /** null when no root is configured — `unreachable` is then not meaningful. */
  root: string | null;
  orphans: GraphQueryNode[];
  unreachable: GraphQueryNode[];
  brokenLinks: { sourcePath: string; target: string }[];
  stale: (GraphQueryNode & { updated: string })[];
}

/**
 * The four things worth fixing about a link graph.
 *
 * Orphans are literally degree-zero here, with no per-type exemption: the
 * graph view shows them as isolates whatever the taxonomy says about them, and
 * `brain audit` remains the place where exemptions apply.
 */
export function getMaintenanceFindings(
  db: Database,
  options: MaintenanceOptions = {}
): MaintenanceFindings {
  const adjacency = loadAdjacency(db);
  const metrics = loadMetrics(db);
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const root = getGraphMetaValue(db, "graph_root");

  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString().split("T")[0];

  const orphans: GraphQueryNode[] = [];
  const stale: (GraphQueryNode & { updated: string })[] = [];
  for (const doc of adjacency.docs.values()) {
    const degree =
      (adjacency.out.get(doc.id) ?? []).length + (adjacency.in.get(doc.id) ?? []).length;
    if (degree === 0) orphans.push(toNode(doc, adjacency, metrics.get(doc.id)));
    if (doc.updated < cutoff) {
      stale.push({ ...toNode(doc, adjacency, metrics.get(doc.id)), updated: doc.updated });
    }
  }

  const unreachable: GraphQueryNode[] = [];
  if (root) {
    const reachable = new Set(
      queryOrEmpty<{ id: number }>(db, "SELECT document_id AS id FROM graph_root_distances").map(
        (row) => row.id
      )
    );
    for (const doc of adjacency.docs.values()) {
      if (!reachable.has(doc.id)) unreachable.push(toNode(doc, adjacency, metrics.get(doc.id)));
    }
  }

  const brokenLinks = db
    .prepare(
      `SELECT d.path AS sourcePath, l.target AS target
       FROM links l JOIN documents d ON d.id = l.source_id
       WHERE l.target_id IS NULL
       ORDER BY d.path, l.target`
    )
    .all() as { sourcePath: string; target: string }[];

  return { staleDays, root, orphans, unreachable, brokenLinks, stale };
}

export interface GraphStats {
  computedAt: string | null;
  root: string | null;
  nodes: number;
  edges: number;
  brokenLinks: number;
  components: number;
  reachable: number;
  layoutSkipped: boolean;
  algo: unknown;
  communities: { community: number; size: number; label: string | null; topTerms: string[] }[];
}

/** Everything `brain graph stats` reports, straight out of the derived tables. */
export function getGraphStats(db: Database): GraphStats {
  const communities = queryOrEmpty<{
    community: number;
    size: number;
    label: string | null;
    topTerms: string | null;
  }>(
    db,
    "SELECT community, size, label, top_terms AS topTerms FROM graph_communities ORDER BY size DESC, community ASC"
  ).map((row) => ({
    community: row.community,
    size: row.size,
    label: row.label,
    topTerms: parseJsonArray(row.topTerms),
  }));

  const count = (sql: string): number => queryOrEmpty<{ n: number }>(db, sql)[0]?.n ?? 0;

  const algoRaw = getGraphMetaValue(db, "graph_algo");
  let algo: unknown = null;
  if (algoRaw) {
    try {
      algo = JSON.parse(algoRaw);
    } catch {
      algo = null;
    }
  }

  return {
    computedAt: getGraphMetaValue(db, "graph_computed_at"),
    root: getGraphMetaValue(db, "graph_root"),
    nodes: count("SELECT COUNT(*) AS n FROM graph_metrics"),
    // Counted the way the graph counts them — deduped, self-links dropped, and
    // links into binary assets excluded — so this agrees with `graph compute`.
    edges: count(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT l.source_id, l.target_id FROM links l
         JOIN documents s ON s.id = l.source_id AND s.asset_type = 'markdown'
         JOIN documents t ON t.id = l.target_id AND t.asset_type = 'markdown'
         WHERE l.source_id <> l.target_id)`
    ),
    brokenLinks: count("SELECT COUNT(*) AS n FROM links WHERE target_id IS NULL"),
    components: count("SELECT COUNT(DISTINCT component) AS n FROM graph_metrics"),
    reachable: count("SELECT COUNT(*) AS n FROM graph_root_distances"),
    layoutSkipped: getGraphMetaValue(db, "graph_layout_skipped") === "1",
    algo,
    communities,
  };
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function readRootLinks(db: Database): number[] {
  const raw = getGraphMetaValue(db, "graph_root_links");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function getGraphMetaValue(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}
