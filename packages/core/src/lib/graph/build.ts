import type { Database } from "bun:sqlite";
import Graph from "graphology";

import type { BrokenLinkRecord, GraphEdgeRecord, GraphNodeRecord } from "./types.js";

/**
 * The in-memory graph plus everything the precompute needs that the graph
 * itself does not carry.
 */
export interface LoadedLinkGraph {
  /** Directed, simple. Node keys are `String(document.id)`. */
  graph: Graph;
  nodes: Map<number, GraphNodeRecord>;
  edges: GraphEdgeRecord[];
  brokenLinks: BrokenLinkRecord[];
}

/**
 * Load the resolved wiki-link graph out of `documents` + `links`.
 *
 * Only markdown documents are nodes — binary assets are indexed as documents
 * but carry no wiki-links, so they would show up as a field of isolates that
 * drowns the actual note graph.
 *
 * Node insertion order is document-id order, and so is edge insertion order.
 * Both Louvain and the layout iterate the graph in insertion order, so this is
 * what makes their output reproducible across runs of the same corpus.
 */
export function loadLinkGraph(db: Database): LoadedLinkGraph {
  const rows = db
    .prepare(
      `SELECT id, path, title, type, status, updated
       FROM documents
       WHERE asset_type = 'markdown'
       ORDER BY id`
    )
    .all() as GraphNodeRecord[];

  const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
  const nodes = new Map<number, GraphNodeRecord>();

  for (const row of rows) {
    nodes.set(row.id, row);
    graph.addNode(String(row.id), { path: row.path });
  }

  const linkRows = db
    .prepare(
      `SELECT l.source_id AS sourceId, l.target_id AS targetId, l.target AS target, d.path AS sourcePath
       FROM links l
       JOIN documents d ON d.id = l.source_id
       WHERE d.asset_type = 'markdown'
       ORDER BY l.source_id, l.target`
    )
    .all() as { sourceId: number; targetId: number | null; target: string; sourcePath: string }[];

  const edges: GraphEdgeRecord[] = [];
  const brokenLinks: BrokenLinkRecord[] = [];

  for (const link of linkRows) {
    if (link.targetId === null) {
      brokenLinks.push({
        sourceId: link.sourceId,
        sourcePath: link.sourcePath,
        target: link.target,
      });
      continue;
    }
    // A link can point at an asset document, and a note can link to itself;
    // neither is an edge in the note graph.
    if (!nodes.has(link.targetId) || link.targetId === link.sourceId) continue;

    const source = String(link.sourceId);
    const target = String(link.targetId);
    if (graph.hasEdge(source, target)) continue;

    graph.addDirectedEdge(source, target);
    edges.push({ source: link.sourceId, target: link.targetId });
  }

  return { graph, nodes, edges, brokenLinks };
}
