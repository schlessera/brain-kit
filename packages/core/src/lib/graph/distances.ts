import type Graph from "graphology";

import type { GraphDirection, RootDistance } from "./types.js";

/** Neighbours of `key` in the requested direction, in insertion order. */
function neighborsOf(graph: Graph, key: string, direction: GraphDirection): string[] {
  if (direction === "out") return graph.outboundNeighbors(key);
  if (direction === "in") return graph.inboundNeighbors(key);
  return graph.neighbors(key);
}

/**
 * Breadth-first hop count from one or more seeds.
 *
 * Seeds start at `seedDistance` with a null parent: an indexed root is a single
 * seed at distance 0, while a virtual root (an entry file with no documents
 * row) seeds its resolved link targets at distance 1 — the ring the root itself
 * would have produced.
 *
 * Frontier order follows the graph's insertion order, so the BFS tree — and
 * therefore every `parent` — is reproducible for a given corpus.
 */
export function bfsDistances(
  graph: Graph,
  seeds: number[],
  direction: GraphDirection = "out",
  seedDistance = 0
): Map<number, RootDistance> {
  const result = new Map<number, RootDistance>();
  let frontier: string[] = [];

  for (const seed of seeds) {
    const key = String(seed);
    if (!graph.hasNode(key) || result.has(seed)) continue;
    result.set(seed, { distance: seedDistance, parent: null });
    frontier.push(key);
  }

  let distance = seedDistance;
  while (frontier.length > 0) {
    distance++;
    const next: string[] = [];
    for (const key of frontier) {
      const parent = Number(key);
      for (const neighbor of neighborsOf(graph, key, direction)) {
        const id = Number(neighbor);
        if (result.has(id)) continue;
        result.set(id, { distance, parent });
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  return result;
}
