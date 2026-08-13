import forceAtlas2 from "graphology-layout-forceatlas2";
import type Graph from "graphology";

import { seededRng } from "./metrics.js";

/**
 * Above this many nodes ForceAtlas2 takes minutes, which is not a cost an
 * index run may impose. Layout is skipped instead and the UI falls back to a
 * per-community packing it can compute itself.
 */
export const LAYOUT_NODE_CAP = 20_000;

/** Iterations from scratch — enough for the clusters to separate visibly. */
export const LAYOUT_ITERATIONS_COLD = 400;
/** Iterations when most nodes already have last run's position to relax from. */
export const LAYOUT_ITERATIONS_WARM = 75;
/** Below this share of reusable positions a warm start is not worth trusting. */
const WARM_START_COVERAGE = 0.5;

const LAYOUT_SEED = 0x1a7e;
/** Radius of the deterministic ring new nodes are seeded on. */
const SEED_RADIUS = 100;
/** How far a node may be nudged off its community's centroid. */
const CENTROID_JITTER = 10;

export interface Position {
  x: number;
  y: number;
}

export interface ClusterLayoutOptions {
  /** Last run's positions, read before the tables are rebuilt. */
  previous?: Map<number, Position>;
  /** community id → member document ids, used to place new nodes sensibly. */
  communities?: Map<number, number[]>;
}

export interface ClusterLayoutResult {
  positions: Map<number, Position>;
  /** True when the graph was over LAYOUT_NODE_CAP and no layout was run. */
  skipped: boolean;
  iterations: number;
}

/**
 * ForceAtlas2 positions for the clusters view.
 *
 * Warm-starting matters for more than speed: a fresh random layout rotates and
 * reflects the whole picture on every index run, so a reader loses the spatial
 * memory they had built up. Nodes that survived from the previous run keep
 * their coordinates, and new nodes enter near their community's centroid
 * rather than from the far edge.
 */
export function computeClusterLayout(
  graph: Graph,
  options: ClusterLayoutOptions = {}
): ClusterLayoutResult {
  const positions = new Map<number, Position>();
  if (graph.order === 0) return { positions, skipped: false, iterations: 0 };
  if (graph.order > LAYOUT_NODE_CAP) return { positions, skipped: true, iterations: 0 };

  const previous = options.previous ?? new Map<number, Position>();
  const rng = seededRng(LAYOUT_SEED);

  // Community centroids from the positions that survived, so a new note lands
  // among its neighbours instead of in the middle of the canvas.
  const centroids = new Map<number, Position>();
  const communityOf = new Map<number, number>();
  for (const [community, members] of options.communities ?? []) {
    let sumX = 0;
    let sumY = 0;
    let known = 0;
    for (const id of members) {
      communityOf.set(id, community);
      const prior = previous.get(id);
      if (!prior) continue;
      sumX += prior.x;
      sumY += prior.y;
      known++;
    }
    if (known > 0) centroids.set(community, { x: sumX / known, y: sumY / known });
  }

  let reused = 0;
  let index = 0;
  graph.forEachNode((key) => {
    const id = Number(key);
    const prior = previous.get(id);
    if (prior) {
      graph.setNodeAttribute(key, "x", prior.x);
      graph.setNodeAttribute(key, "y", prior.y);
      reused++;
    } else {
      const centroid = centroids.get(communityOf.get(id) ?? -1);
      if (centroid) {
        graph.setNodeAttribute(key, "x", centroid.x + (rng() - 0.5) * CENTROID_JITTER);
        graph.setNodeAttribute(key, "y", centroid.y + (rng() - 0.5) * CENTROID_JITTER);
      } else {
        // Deterministic ring: a random scatter would rotate the whole layout
        // between runs even when nothing about the corpus changed.
        const angle = (index / graph.order) * Math.PI * 2;
        graph.setNodeAttribute(key, "x", Math.cos(angle) * SEED_RADIUS);
        graph.setNodeAttribute(key, "y", Math.sin(angle) * SEED_RADIUS);
      }
    }
    index++;
  });

  const warm = reused >= graph.order * WARM_START_COVERAGE;
  const iterations = warm ? LAYOUT_ITERATIONS_WARM : LAYOUT_ITERATIONS_COLD;

  forceAtlas2.assign(graph, {
    iterations,
    settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true },
  });

  graph.forEachNode((key, attributes) => {
    positions.set(Number(key), { x: attributes.x as number, y: attributes.y as number });
  });

  return { positions, skipped: false, iterations };
}
