/**
 * Derived wiki-link graph: precompute (write side) and queries (read side)
 * over the `graph_*` tables introduced in schema v8.
 */

export { loadLinkGraph } from "./build.js";
export type { LoadedLinkGraph } from "./build.js";
export { bfsDistances } from "./distances.js";
export { buildTermIndex, communityTopTerms } from "./labels.js";
export type { TermIndex } from "./labels.js";
export { computeClusterLayout, LAYOUT_NODE_CAP } from "./layout.js";
export type { ClusterLayoutOptions, ClusterLayoutResult, Position } from "./layout.js";
export { computeMetrics, seededRng } from "./metrics.js";
export type { GraphMetrics } from "./metrics.js";
export { runGraphPrecompute, CLUSTER_LAYOUT_MODE } from "./precompute.js";
export {
  getClusterGraph,
  getDiscoveryGraph,
  getEgoGraph,
  getGraphStats,
  getMaintenanceFindings,
  DEFAULT_STALE_DAYS,
  MAX_DISCOVERY_DEPTH,
  MAX_EGO_DEPTH,
  VIRTUAL_ROOT_ID,
} from "./queries.js";
export type {
  ClusterGraphOptions,
  DiscoveryGraphOptions,
  EgoGraphOptions,
  GraphStats,
  MaintenanceFindings,
  MaintenanceOptions,
} from "./queries.js";
export { resolveGraphRoot, graphRootKey, DEFAULT_ROOT_CANDIDATES } from "./root.js";
export type { ResolveGraphRootOptions } from "./root.js";
export type {
  BrokenLinkRecord,
  CommunityRecord,
  GraphDirection,
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphPrecomputeOptions,
  GraphPrecomputeResult,
  GraphQueryNode,
  GraphRoot,
  GraphSubgraph,
  NodeMetrics,
  RootDistance,
} from "./types.js";
