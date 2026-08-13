import type { Database } from "bun:sqlite";

import { loadLinkGraph } from "./build.js";
import { bfsDistances } from "./distances.js";
import { buildTermIndex, communityTopTerms } from "./labels.js";
import {
  computeClusterLayout,
  LAYOUT_ITERATIONS_COLD,
  LAYOUT_ITERATIONS_WARM,
  LAYOUT_NODE_CAP,
  type Position,
} from "./layout.js";
import { computeMetrics, LOUVAIN_SEED, PAGERANK_DAMPING } from "./metrics.js";
import { graphRootKey, resolveGraphRoot } from "./root.js";
import type {
  CommunityRecord,
  GraphDirection,
  GraphPrecomputeOptions,
  GraphPrecomputeResult,
} from "./types.js";

/** The only layout mode written in v1. */
export const CLUSTER_LAYOUT_MODE = "clusters";

/**
 * Root distances follow links forward: "what does the entry document lead me
 * to". Walking backwards would make almost everything reachable and the
 * unreachable finding meaningless.
 */
const ROOT_DIRECTION: GraphDirection = "out";

/** Every `index_metadata` key this module owns, cleared and rewritten per run. */
const METADATA_KEYS = [
  "graph_computed_at",
  "graph_algo",
  "graph_root",
  "graph_root_links",
  "graph_node_count",
  "graph_layout_skipped",
];

/** Last run's cluster positions — must be read before the tables are rebuilt. */
function readPreviousLayout(db: Database): Map<number, Position> {
  const positions = new Map<number, Position>();
  const rows = db
    .prepare("SELECT document_id AS id, x, y FROM graph_layouts WHERE mode = ?")
    .all(CLUSTER_LAYOUT_MODE) as { id: number; x: number; y: number }[];
  for (const row of rows) positions.set(row.id, { x: row.x, y: row.y });
  return positions;
}

/**
 * Rebuild every `graph_*` table from `documents` + `links`.
 *
 * Wholesale replacement in one immediate transaction, exactly like the link
 * table the graph is derived from: link resolution depends on corpus-wide
 * state, so anything incremental here goes stale or stays wrong after a
 * resolver fix. At the current corpus size the whole pass costs well under a
 * second.
 */
export function runGraphPrecompute(
  db: Database,
  options: GraphPrecomputeOptions
): GraphPrecomputeResult {
  const started = Date.now();

  const { graph, nodes, edges, brokenLinks } = loadLinkGraph(db);
  const metrics = computeMetrics(graph);

  const termIndex = buildTermIndex(db);
  const communities: CommunityRecord[] = [...metrics.communities.entries()].map(
    ([community, members]) => {
      const topTerms = communityTopTerms(termIndex, members);
      return { community, size: members.length, label: topTerms[0] ?? null, topTerms, members };
    }
  );

  const root = resolveGraphRoot(db, {
    root: options.root,
    taxonomy: options.taxonomy,
    override: options.rootOverride,
  });
  const distances =
    root === null
      ? new Map()
      : root.kind === "document"
        ? bfsDistances(graph, [root.id], ROOT_DIRECTION, 0)
        : bfsDistances(graph, root.seedIds, ROOT_DIRECTION, 1);

  const previous = readPreviousLayout(db);
  const layout = computeClusterLayout(graph, { previous, communities: metrics.communities });

  const computedAt = new Date().toISOString();
  const algo = JSON.stringify({
    pagerankDamping: PAGERANK_DAMPING,
    louvainSeed: LOUVAIN_SEED,
    rootDirection: ROOT_DIRECTION,
    layoutIterations: layout.iterations,
    layoutIterationsCold: LAYOUT_ITERATIONS_COLD,
    layoutIterationsWarm: LAYOUT_ITERATIONS_WARM,
    layoutNodeCap: LAYOUT_NODE_CAP,
  });

  const write = db.transaction(() => {
    db.run("DELETE FROM graph_metrics");
    db.run("DELETE FROM graph_communities");
    db.run("DELETE FROM graph_root_distances");
    db.run("DELETE FROM graph_layouts");

    const insertMetrics = db.prepare(
      `INSERT INTO graph_metrics (document_id, in_degree, out_degree, component, pagerank, community)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const [id, node] of metrics.byNode) {
      insertMetrics.run(
        id,
        node.inDegree,
        node.outDegree,
        node.component,
        node.pagerank,
        node.community
      );
    }

    const insertCommunity = db.prepare(
      "INSERT INTO graph_communities (community, size, label, top_terms) VALUES (?, ?, ?, ?)"
    );
    for (const community of communities) {
      insertCommunity.run(
        community.community,
        community.size,
        community.label,
        JSON.stringify(community.topTerms)
      );
    }

    const insertDistance = db.prepare(
      "INSERT INTO graph_root_distances (document_id, distance, parent_id) VALUES (?, ?, ?)"
    );
    for (const [id, entry] of distances) {
      insertDistance.run(id, entry.distance, entry.parent);
    }

    const insertLayout = db.prepare(
      "INSERT INTO graph_layouts (mode, document_id, x, y) VALUES (?, ?, ?, ?)"
    );
    for (const [id, position] of layout.positions) {
      insertLayout.run(CLUSTER_LAYOUT_MODE, id, position.x, position.y);
    }

    // Clear first: a key left over from a previous run (a root that has since
    // been removed, say) would read as current provenance.
    const deleteMeta = db.prepare("DELETE FROM index_metadata WHERE key = ?");
    for (const key of METADATA_KEYS) deleteMeta.run(key);

    const setMetaValue = db.prepare(
      "INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)"
    );
    setMetaValue.run("graph_computed_at", computedAt);
    setMetaValue.run("graph_algo", algo);
    setMetaValue.run("graph_node_count", String(nodes.size));
    if (root) {
      setMetaValue.run("graph_root", graphRootKey(root));
      setMetaValue.run(
        "graph_root_links",
        JSON.stringify(root.kind === "virtual" ? root.seedIds : [])
      );
    }
    if (layout.skipped) setMetaValue.run("graph_layout_skipped", "1");
  });

  write.immediate();

  return {
    nodes: nodes.size,
    edges: edges.length,
    brokenLinks: brokenLinks.length,
    components: metrics.componentCount,
    communities: communities.length,
    root: root ? graphRootKey(root) : null,
    reachable: distances.size,
    layoutSkipped: layout.skipped,
    durationMs: Date.now() - started,
  };
}
