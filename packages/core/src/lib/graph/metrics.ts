import { connectedComponents } from "graphology-components";
import louvain from "graphology-communities-louvain";
import pagerank from "graphology-metrics/centrality/pagerank";
import type Graph from "graphology";

import type { NodeMetrics } from "./types.js";

/** Damping recorded in `index_metadata.graph_algo` so a reader can tell runs apart. */
export const PAGERANK_DAMPING = 0.85;
/** Fixed Louvain seed — determinism across runs matters more than a good shuffle. */
export const LOUVAIN_SEED = 0x5eed;

/**
 * Deterministic PRNG (mulberry32). Louvain shuffles its node order; seeding it
 * is the difference between "same corpus, same communities" and a palette that
 * churns on every index run.
 */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GraphMetrics {
  /** Keyed by document id. */
  byNode: Map<number, NodeMetrics>;
  /** community id → member document ids, ascending. */
  communities: Map<number, number[]>;
  componentCount: number;
}

/**
 * Renumber group ids so they are stable across corpus edits: largest group
 * first, ties broken by the lowest member document id. Raw Louvain/component
 * ids depend on traversal order, so a single new note can renumber everything
 * and repaint the whole graph.
 */
function renumberByStableOrder(groups: Map<unknown, number[]>): Map<number, number[]> {
  const ordered = [...groups.values()]
    .map((members) => [...members].sort((a, b) => a - b))
    .sort((a, b) => b.length - a.length || a[0] - b[0]);

  const renumbered = new Map<number, number[]>();
  ordered.forEach((members, index) => renumbered.set(index, members));
  return renumbered;
}

/**
 * Degrees, weakly-connected components, PageRank and Louvain communities for
 * the whole link graph. Components and communities are renumbered for
 * cross-run stability; PageRank and Louvain are deterministic given the graph's
 * insertion order (see build.ts) and the seeded rng.
 */
export function computeMetrics(graph: Graph): GraphMetrics {
  const byNode = new Map<number, NodeMetrics>();
  if (graph.order === 0) {
    return { byNode, communities: new Map(), componentCount: 0 };
  }

  // connectedComponents treats directed edges as undirected, i.e. weakly
  // connected components — which is what "is this note reachable at all" means
  // for a reader who does not care about link direction.
  const rawComponents = new Map<number, number[]>();
  connectedComponents(graph).forEach((members, index) => {
    rawComponents.set(
      index,
      members.map((key) => Number(key))
    );
  });
  const components = renumberByStableOrder(rawComponents);
  const componentOf = new Map<number, number>();
  for (const [component, members] of components) {
    for (const id of members) componentOf.set(id, component);
  }

  // getEdgeWeight: null — a wiki-link is a wiki-link; there is no weight
  // attribute to read and every edge counts the same.
  const ranks = pagerank(graph, { alpha: PAGERANK_DAMPING, getEdgeWeight: null });

  const rawCommunities = new Map<number, number[]>();
  const assignment = louvain(graph, { rng: seededRng(LOUVAIN_SEED) });
  for (const [key, community] of Object.entries(assignment)) {
    const members = rawCommunities.get(community) ?? [];
    members.push(Number(key));
    rawCommunities.set(community, members);
  }
  const communities = renumberByStableOrder(rawCommunities);
  const communityOf = new Map<number, number>();
  for (const [community, members] of communities) {
    for (const id of members) communityOf.set(id, community);
  }

  graph.forEachNode((key) => {
    const id = Number(key);
    byNode.set(id, {
      inDegree: graph.inDegree(key),
      outDegree: graph.outDegree(key),
      component: componentOf.get(id) ?? 0,
      pagerank: ranks[key] ?? 0,
      community: communityOf.get(id) ?? null,
    });
  });

  return { byNode, communities, componentCount: components.size };
}
