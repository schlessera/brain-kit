/**
 * The `brain graph` CLI's graph modes: the CLI profile of the shared graph
 * reader (`GraphReader`, `./reader.ts`). This adapter owns the `--json`
 * shapes and node materialization; the reader's header lists every way this
 * profile differs from the supported `./queries` API. Both read the same
 * tables, which docs/integration-contract.md governs.
 */

import type { Database } from "bun:sqlite";

import { CLI_GRAPH_PROFILE, GraphReader, VIRTUAL_ROOT_ID, parseGraphRootKey, type Walk } from "./reader.js";
import type {
  GraphDirection,
  GraphEdgeRecord,
  GraphQueryNode,
  GraphSubgraph,
} from "./types.js";

export {
  DEFAULT_STALE_DAYS,
  MAX_DISCOVERY_DEPTH,
  MAX_NEIGHBORHOOD_DEPTH as MAX_EGO_DEPTH,
  VIRTUAL_ROOT_ID,
} from "./reader.js";

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
 * The CLI's nodes, in document id order, over the reader's link structure.
 * Degrees and walks come straight from `links` — no derived table involved —
 * so the ego, explicit-root discovery and orphan modes keep working before the
 * first precompute.
 */
interface CliGraph {
  reader: GraphReader;
  docs: Map<number, DocumentRow>;
  out: Map<number, number[]>;
  in: Map<number, number[]>;
  edges: GraphEdgeRecord[];
}

/** Every CLI graph read selects the CLI profile here, and only here. */
function cliReader(db: Database): GraphReader {
  return new GraphReader(db, CLI_GRAPH_PROFILE);
}

function openGraph(db: Database): CliGraph {
  const reader = cliReader(db);
  const docs = new Map<number, DocumentRow>();
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.path AS path, d.title AS title, d.type AS type, d.updated AS updated
       FROM documents d WHERE ${reader.scope} ORDER BY d.id`
    )
    .all() as DocumentRow[];
  for (const row of rows) docs.set(row.id, row);
  const links = reader.links();
  return { reader, docs, out: links.out, in: links.in, edges: links.edges };
}

function loadMetrics(graph: CliGraph): Map<number, MetricsRow> {
  const metrics = new Map<number, MetricsRow>();
  for (const row of graph.reader.derived<MetricsRow>("SELECT * FROM graph_metrics")) {
    metrics.set(row.document_id, row);
  }
  return metrics;
}

function loadLayout(graph: CliGraph, mode = "clusters"): Map<number, { x: number; y: number }> {
  const layout = new Map<number, { x: number; y: number }>();
  const rows = graph.reader.derived<{ id: number; x: number; y: number }>(
    "SELECT document_id AS id, x, y FROM graph_layouts WHERE mode = ?",
    [mode]
  );
  for (const row of rows) layout.set(row.id, { x: row.x, y: row.y });
  return layout;
}

/** Assemble one node, taking degrees from adjacency and the rest from metrics. */
function toNode(
  doc: DocumentRow,
  graph: CliGraph,
  metrics?: MetricsRow,
  extra: Partial<GraphQueryNode> = {}
): GraphQueryNode {
  const node: GraphQueryNode = {
    id: doc.id,
    path: doc.path,
    title: doc.title,
    type: doc.type,
    inDegree: metrics?.in_degree ?? (graph.in.get(doc.id) ?? []).length,
    outDegree: metrics?.out_degree ?? (graph.out.get(doc.id) ?? []).length,
  };
  if (metrics) {
    if (metrics.community !== null) node.community = metrics.community;
    node.pagerank = metrics.pagerank;
  }
  return { ...node, ...extra };
}

function degree(graph: CliGraph, id: number): number {
  return (graph.out.get(id) ?? []).length + (graph.in.get(id) ?? []).length;
}

const EMPTY: () => GraphSubgraph = () => ({ nodes: [], edges: [], truncated: false });

/** Nodes for every reached id, in walk order, with edges among them. */
function walkScene(graph: CliGraph, walk: Walk, cap: number): GraphSubgraph {
  const metrics = loadMetrics(graph);
  const nodes = [...walk.distances.entries()].map(([id, distance]) =>
    toNode(graph.docs.get(id)!, graph, metrics.get(id), { distance })
  );
  return graph.reader.scene(nodes, graph.edges, cap, walk.truncated);
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
  const graph = openGraph(db);
  const metrics = loadMetrics(graph);
  const layout = loadLayout(graph);
  const includeIsolates = graph.reader.includeIsolates(options.includeIsolates);

  const nodes: GraphQueryNode[] = [];
  for (const doc of graph.docs.values()) {
    const nodeMetrics = metrics.get(doc.id);
    if (options.community !== undefined && nodeMetrics?.community !== options.community) continue;
    if (!includeIsolates && degree(graph, doc.id) === 0) continue;

    const position = layout.get(doc.id);
    nodes.push(toNode(doc, graph, nodeMetrics, position ? { x: position.x, y: position.y } : {}));
  }

  return graph.reader.scene(nodes, graph.edges, graph.reader.profile.sceneNodes);
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
  const graph = openGraph(db);
  const centerId = graph.reader.lookup(options.center);
  if (centerId === null) return EMPTY();

  const walk = graph.reader.neighborhood(centerId, options.depth, options.direction);
  return walkScene(graph, walk, graph.reader.profile.neighborhoodNodes);
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
  const graph = openGraph(db);
  const maxDepth = graph.reader.discoveryDepth(options.maxDepth);

  if (options.root) {
    const rootId = graph.reader.lookup(options.root);
    if (rootId === null) return EMPTY();

    const walk = graph.reader.discovery(rootId, maxDepth, options.direction);
    return walkScene(graph, walk, graph.reader.profile.sceneNodes);
  }

  const metrics = loadMetrics(graph);
  const root = parseGraphRootKey(getGraphMetaValue(db, "graph_root"));
  const nodes: GraphQueryNode[] = [];
  const ids = new Set<number>();
  for (const [id, distance] of graph.reader.rootDistances()) {
    const doc = graph.docs.get(id);
    if (!doc || distance > maxDepth) continue;
    nodes.push(toNode(doc, graph, metrics.get(id), { distance }));
    ids.add(id);
  }

  // A virtual root is drawn from its recorded seed list, after the edges
  // between documents; an indexed root is already one of the nodes above at
  // distance 0.
  const edges = [...graph.edges];
  if (root?.virtual) {
    nodes.unshift({
      id: VIRTUAL_ROOT_ID,
      path: root.path,
      title: root.path,
      type: "index",
      inDegree: 0,
      outDegree: 0,
      distance: 0,
      virtual: true,
    });
    for (const seedId of graph.reader.rootLinks(getGraphMetaValue(db, "graph_root_links"))) {
      if (ids.has(seedId)) edges.push({ source: VIRTUAL_ROOT_ID, target: seedId });
    }
  }

  return graph.reader.scene(nodes, edges, graph.reader.profile.sceneNodes);
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
  const graph = openGraph(db);
  const metrics = loadMetrics(graph);
  const staleDays = graph.reader.staleDays(options.staleDays);
  const root = getGraphMetaValue(db, "graph_root");

  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString().split("T")[0];

  const orphans: GraphQueryNode[] = [];
  const stale: (GraphQueryNode & { updated: string })[] = [];
  for (const doc of graph.docs.values()) {
    if (degree(graph, doc.id) === 0) orphans.push(toNode(doc, graph, metrics.get(doc.id)));
    if (doc.updated < cutoff) {
      stale.push({ ...toNode(doc, graph, metrics.get(doc.id)), updated: doc.updated });
    }
  }

  const unreachable: GraphQueryNode[] = [];
  if (root) {
    const reachable = graph.reader.rootDistances();
    for (const doc of graph.docs.values()) {
      if (!reachable.has(doc.id)) unreachable.push(toNode(doc, graph, metrics.get(doc.id)));
    }
  }

  const brokenLinks = graph.reader.brokenLinks();

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
  const reader = cliReader(db);
  const communities = reader.derived<{
    community: number;
    size: number;
    label: string | null;
    topTerms: string | null;
  }>(
    "SELECT community, size, label, top_terms AS topTerms FROM graph_communities ORDER BY size DESC, community ASC"
  ).map((row) => ({
    community: row.community,
    size: row.size,
    label: row.label,
    topTerms: parseJsonArray(row.topTerms),
  }));

  const count = (sql: string): number => reader.derived<{ n: number }>(sql)[0]?.n ?? 0;

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
    edges: count(`SELECT COUNT(*) AS n FROM (${reader.edgeSql})`),
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

function getGraphMetaValue(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}
