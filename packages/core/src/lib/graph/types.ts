/**
 * Shared shapes for the derived wiki-link graph.
 *
 * The graph is a cache over `documents` + `links`: nodes are markdown
 * documents, edges are resolved wiki-links. Everything here is recomputed from
 * those two tables, so nothing in this module is authoritative state.
 */

import type { Taxonomy } from "../taxonomy.js";

/** One markdown document as a graph node. */
export interface GraphNodeRecord {
  id: number;
  path: string;
  title: string;
  type: string;
  status: string;
  updated: string;
}

/** A resolved wiki-link, by document id. */
export interface GraphEdgeRecord {
  source: number;
  target: number;
}

/** A wiki-link whose target resolved to nothing (`links.target_id IS NULL`). */
export interface BrokenLinkRecord {
  sourceId: number;
  sourcePath: string;
  target: string;
}

/** Per-node derived metrics, keyed by document id. */
export interface NodeMetrics {
  inDegree: number;
  outDegree: number;
  component: number;
  pagerank: number;
  community: number | null;
}

/** One Louvain community, after stable renumbering. */
export interface CommunityRecord {
  community: number;
  size: number;
  label: string | null;
  topTerms: string[];
  members: number[];
}

/** BFS result for one node: hops from the root and its BFS-tree parent. */
export interface RootDistance {
  distance: number;
  parent: number | null;
}

/** Which way edges are followed when walking the graph. */
export type GraphDirection = "in" | "out" | "both";

/**
 * The resolved default root. `document` = an indexed note (distance 0 on its
 * own row); `virtual` = an index-excluded entry file, which has no documents
 * row and instead seeds its resolved link targets at distance 1.
 */
export type GraphRoot =
  | { kind: "document"; path: string; id: number }
  | { kind: "virtual"; path: string; seedIds: number[] };

export interface GraphPrecomputeOptions {
  /** Brain repo root — needed to read a virtual root's entry file from disk. */
  root: string;
  taxonomy: Taxonomy;
  /** Overrides `graph.root` and the AGENTS.md/CLAUDE.md fallback. */
  rootOverride?: string;
}

export interface GraphPrecomputeResult {
  nodes: number;
  edges: number;
  brokenLinks: number;
  components: number;
  communities: number;
  /** null when no root could be resolved. */
  root: string | null;
  reachable: number;
  layoutSkipped: boolean;
  durationMs: number;
}

/** A node as returned by the read side (`queries.ts`) and the CLI. */
export interface GraphQueryNode {
  id: number;
  path: string;
  title: string;
  type: string;
  inDegree: number;
  outDegree: number;
  community?: number;
  pagerank?: number;
  x?: number;
  y?: number;
  distance?: number;
  /** The synthesized virtual-root node (id 0); it has no documents row. */
  virtual?: boolean;
}

export interface GraphSubgraph {
  nodes: GraphQueryNode[];
  edges: GraphEdgeRecord[];
  truncated: boolean;
}
