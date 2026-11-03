/**
 * The supported `./queries` graph modes: the UI profile of the shared graph
 * reader (`GraphReader`, `../lib/graph/reader.ts`). This adapter owns the
 * result shapes, node materialization and typed failures; the reader's header
 * lists every way this profile differs from the `brain graph` CLI.
 */
import type { Database } from "bun:sqlite";
import { basename } from "path";
import type { Node, Community, GraphMeta, Subgraph, Maintenance, Direction } from "./types.js";
import { QueryFailure } from "./snapshot.js";
import { GraphReader, UI_GRAPH_PROFILE, VIRTUAL_ROOT_ID, parseGraphRootKey } from "../lib/graph/reader.js";
/** Every supported graph read selects the UI profile here, and only here. */
function reader(db: Database): GraphReader {
  return new GraphReader(db, UI_GRAPH_PROFILE);
}
function requireComputedGraph(meta: Map<string, string>): void {
  if (!meta.get("graph_computed_at"))
    throw new QueryFailure("not_computed");
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
const MARKDOWN_ONLY = UI_GRAPH_PROFILE.nodeScope("d");
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
function toNode(row: NodeRow, distance?: number): Node {
  const node: Node = {
    id: row.id,
    path: row.path,
    title: row.title,
    type: row.type,
    inDegree: row.in_degree ?? 0,
    outDegree: row.out_degree ?? 0,
  };
  if (row.community != null)
    node.community = row.community;
  if (row.pagerank != null)
    node.pagerank = row.pagerank;
  if (row.x != null && row.y != null) {
    node.x = row.x;
    node.y = row.y;
  }
  if (distance !== undefined)
    node.distance = distance;
  return node;
}
/** Chunked so a large id set never runs into SQLite's bound-parameter limit. */
function loadNodesByIds(db: Database, ids: number[], withGraphTables: boolean): NodeRow[] {
  const out: NodeRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query<NodeRow, number[]>(`${nodeSelect(withGraphTables)} WHERE ${MARKDOWN_ONLY} AND d.id IN (${placeholders})`)
      .all(...chunk);
    out.push(...rows);
  }
  return out;
}
function lookupDocumentId(graph: GraphReader, path: string): number {
  const id = graph.lookup(path);
  if (id === null)
    throw new QueryFailure("not_found");
  return id;
}
// --- meta ------------------------------------------------------------------
function countGraph(db: Database): {
  nodeCount: number;
  edgeCount: number;
} {
  const edges = db.query<{
    c: number;
  }, []>(`SELECT COUNT(*) AS c FROM (${reader(db).edgeSql})`).get();
  return { nodeCount: countMarkdownDocs(db), edgeCount: edges?.c ?? 0 };
}
/**
 * Whether the precompute resolved a root at all.
 *
 * The key is deleted and rewritten each run, so its ABSENCE is the only signal
 * that there is no root — an empty `graph_root_distances` does not mean the
 * same thing. A named root whose links all failed to resolve is written with
 * zero distance rows, and in that state every note really is unreachable.
 */
function hasResolvedRoot(meta: Map<string, string>): boolean {
  return Boolean(meta.get("graph_root"));
}
function countMarkdownDocs(db: Database): number {
  return (db.query<{
    c: number;
  }, []>(`SELECT COUNT(*) AS c FROM documents d WHERE ${MARKDOWN_ONLY}`).get()?.c ?? 0);
}
function readCommunities(db: Database): Community[] {
  const rows = db
    .query<{
    community: number;
    size: number;
    label: string | null;
    top_terms: string | null;
  }, []>("SELECT community, size, label, top_terms FROM graph_communities ORDER BY size DESC, community ASC")
    .all();
  return rows.map((row) => {
    let topTerms: string[] = [];
    try {
      const parsed = row.top_terms ? JSON.parse(row.top_terms) : [];
      if (Array.isArray(parsed))
        topTerms = parsed.filter((t): t is string => typeof t === "string");
    }
    catch {
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
  const row = db.query<{
    newest: string | null;
  }, []>("SELECT MAX(indexed_at) AS newest FROM documents").get();
  if (!row?.newest)
    return false;
  const computed = Date.parse(computedAt);
  const indexed = Date.parse(row.newest);
  if (Number.isNaN(computed) || Number.isNaN(indexed))
    return false;
  return computed < indexed;
}
export function graphMeta(db: Database, meta: Map<string, string>, schemaVersion: number): GraphMeta {
  const counts = countGraph(db);
  if (schemaVersion < 8) {
    return unavailable("schema", schemaVersion, counts);
  }
  const computedAt = meta.get("graph_computed_at") ?? null;
  if (!computedAt)
    return unavailable("not_computed", schemaVersion, counts);
  const response: GraphMeta = {
    available: true,
    schemaVersion,
    computedAt,
    stale: isStale(db, computedAt),
    ...counts,
    communities: readCommunities(db),
    defaultRoot: parseGraphRootKey(meta.get("graph_root")),
  };
  if (meta.get("graph_layout_skipped") === "1")
    response.layoutSkipped = true;
  return response;
}
function unavailable(reason: "schema" | "not_computed", schemaVersion: number, counts: {
  nodeCount: number;
  edgeCount: number;
}): GraphMeta {
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
export function graphClusters(db: Database, meta: Map<string, string>, opts: {
  community?: number;
  includeIsolates?: boolean;
}): Subgraph {
  requireComputedGraph(meta);
  const graph = reader(db);
  const filters: string[] = [MARKDOWN_ONLY];
  const params: number[] = [];
  if (opts.community !== undefined) {
    filters.push("m.community = ?");
    params.push(opts.community);
  }
  if (!graph.includeIsolates(opts.includeIsolates)) {
    filters.push("(COALESCE(m.in_degree, 0) + COALESCE(m.out_degree, 0)) > 0");
  }
  const rows = db
    .query<NodeRow, number[]>(`${nodeSelect(true)} WHERE ${filters.join(" AND ")} ORDER BY m.pagerank DESC, d.id ASC`)
    .all(...params);
  return graph.scene(rows.map((row) => toNode(row)), graph.links().edges, graph.profile.sceneNodes);
}
/**
 * Deliberately exempt from the schema gate: an ego graph needs nothing but the
 * `links` table, so the local mode stays useful on a repo that has never seen a
 * graph precompute.
 */
export function graphNeighborhood(db: Database, schemaVersion: number, opts: {
  center: string;
  depth?: number;
  direction?: Direction;
}): Subgraph {
  const graph = reader(db);
  const centerId = lookupDocumentId(graph, opts.center);
  const withGraphTables = schemaVersion >= 8;
  const { distances, truncated } = graph.neighborhood(centerId, opts.depth, opts.direction);
  const rows = loadNodesByIds(db, [...distances.keys()], withGraphTables);
  const nodes = rows.map((row) => toNode(row, distances.get(row.id)));
  return graph.scene(nodes, graph.links().edges, graph.profile.neighborhoodNodes, truncated);
}
export function graphDiscovery(db: Database, meta: Map<string, string>, opts: {
  root?: string;
  direction?: "out" | "both";
  maxDepth?: number;
}): Subgraph {
  const graph = reader(db);
  const maxDepth = graph.discoveryDepth(opts.maxDepth);
  requireComputedGraph(meta);
  const structure = graph.links();
  const total = countMarkdownDocs(db);
  if (opts.root) {
    const rootId = lookupDocumentId(graph, opts.root);
    const { distances, truncated } = graph.discovery(rootId, maxDepth, opts.direction);
    const rows = loadNodesByIds(db, [...distances.keys()], true);
    const capped = graph.scene(rows.map((row) => toNode(row, distances.get(row.id))), structure.edges, graph.profile.sceneNodes, truncated);
    // Reach is a property of the graph, not of the scene, so it is measured
    // by a second walk with no depth window. A BFS can neither exceed the
    // node count in levels nor in nodes, so `total` bounds both exactly.
    const reachable = graph.walk(rootId, opts.direction ?? "out", total, total).distances.size;
    return {
      ...capped,
      reachableCount: reachable,
      unreachableCount: Math.max(0, total - reachable),
    };
  }
  // Default root: the distances were computed at index time, so `direction`
  // does not apply here — the precomputed walk is the one that was run.
  const distances = graph.rootDistances(maxDepth);
  const rows = loadNodesByIds(db, [...distances.keys()], true);
  const nodes = rows.map((row) => toNode(row, distances.get(row.id)));
  const root = parseGraphRootKey(meta.get("graph_root"));
  const edges = [...structure.edges];
  if (root?.virtual) {
    // The entry file is excluded from indexing, so it has no documents row:
    // the node standing in for it is synthesized here, at id 0.
    const rootLinks = graph.rootLinks(meta.get("graph_root_links")).filter((id) => distances.has(id));
    nodes.unshift({
      id: VIRTUAL_ROOT_ID,
      path: root.path,
      title: basename(root.path),
      type: "root",
      inDegree: 0,
      outDegree: rootLinks.length,
      distance: 0,
      virtual: true,
    });
    edges.unshift(...rootLinks.map((id) => ({ source: VIRTUAL_ROOT_ID, target: id })));
  }
  const response: Subgraph = graph.scene(nodes, edges, graph.profile.sceneNodes);
  if (hasResolvedRoot(meta)) {
    // Every distance row is one reached DOCUMENT — a virtual root is none, so
    // this needs no adjustment for the synthesized node. Counted over the
    // whole table, not the depth-limited scene above.
    const reachable = db.query<{
      c: number;
    }, []>("SELECT COUNT(*) AS c FROM graph_root_distances").get()?.c ?? 0;
    response.reachableCount = reachable;
    response.unreachableCount = Math.max(0, total - reachable);
  }
  return response;
}
export function graphMaintenance(db: Database, meta: Map<string, string>, opts: {
  staleDays?: number;
  now?: string;
}): Maintenance {
  const graph = reader(db);
  const staleDays = graph.staleDays(opts.staleDays);
  const limit = graph.profile.findingLimit;
  requireComputedGraph(meta);
  const orphans = db
    .query<NodeRow, [
    number
  ]>(`${nodeSelect(true)} WHERE ${MARKDOWN_ONLY}
     AND COALESCE(m.in_degree, 0) = 0 AND COALESCE(m.out_degree, 0) = 0
     ORDER BY d.updated DESC, d.id ASC LIMIT ?`)
    .all(limit)
    .map((row) => toNode(row));
  // Keyed on whether a root was RESOLVED, not on whether any note has a
  // distance: a named root that reached nothing leaves the distances empty,
  // and then the whole corpus genuinely is unreachable. Only the absence of a
  // root makes the finding meaningless.
  const unreachable = !hasResolvedRoot(meta)
    ? []
    : db
      .query<NodeRow, [
      number
    ]>(`${nodeSelect(true)}
         LEFT JOIN graph_root_distances rd ON rd.document_id = d.id
       WHERE ${MARKDOWN_ONLY} AND rd.document_id IS NULL
       ORDER BY m.pagerank DESC, d.id ASC LIMIT ?`)
      .all(limit)
      .map((row) => toNode(row));
  const brokenLinks = graph.brokenLinks();
  // `documents.updated` is a date, `indexed_at` a timestamp — compare on the
  // date prefix so a mix of both formats still sorts correctly.
  const cutoff = new Date((opts.now === undefined ? Date.now() : Date.parse(opts.now)) - staleDays * 86400000).toISOString().slice(0, 10);
  const stale = db
    .query<NodeRow & {
    updated: string;
  }, [
    string,
    number
  ]>(`${nodeSelect(true, ", d.updated AS updated")}
     WHERE ${MARKDOWN_ONLY} AND substr(d.updated, 1, 10) < ?
     ORDER BY d.updated ASC, d.id ASC LIMIT ?`)
    .all(cutoff, limit)
    .map((row) => ({ ...toNode(row), updated: row.updated }));
  return { orphans, unreachable, brokenLinks, stale, staleDays };
}
