import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import type { SizeBy } from "../../../lib/graph-helpers.js";

const MIN_RADIUS = 4;
const MAX_RADIUS = 16;
const EXPONENT = 2;

/** Relative importance across the displayed graph, with no link-count bands. */
export function graphNodeSizes(nodes: GraphNodePayload[], sizeBy: SizeBy): Map<number, number> {
  const score = (node: GraphNodePayload): number =>
    sizeBy === "pagerank" ? node.pagerank ?? 0 : node.inDegree + node.outDegree;
  let minimum = Infinity, maximum = -Infinity;
  for (const node of nodes) {
    // The synthetic entry point is emphasized, but does not skew real scores.
    if (node.virtual) continue;
    const value = score(node);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const span = maximum - minimum;
  return new Map(nodes.map(node => {
    if (node.virtual) return [node.id, MAX_RADIUS];
    // Equal scores have equal, modest marks instead of manufacturing a hub.
    const normalized = span > 0 ? (score(node) - minimum) / span : 0;
    const weight = Math.expm1(EXPONENT * normalized) / Math.expm1(EXPONENT);
    return [node.id, MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * weight];
  }));
}
