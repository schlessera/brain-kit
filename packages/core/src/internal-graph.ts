// Browser-safe graph math, shared with the project website's demo so its graph
// is computed exactly as core's indexer computes one (#1382). First-party and
// lockstep like ./internal, with no compatibility promise. Unlike ./internal,
// this entry imports nothing that needs Node or bun:sqlite at runtime.
export { computeMetrics } from "./lib/graph/metrics.js";
export { computeClusterLayout } from "./lib/graph/layout.js";
export { communityTopTerms, type TermIndex } from "./lib/graph/labels.js";
