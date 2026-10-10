import { expect, test } from "bun:test";
import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { graphNodeSizes } from "../src/components/graph/lib/node-size-scale.js";

const node = (id: number, degree: number, pagerank?: number): GraphNodePayload => ({
  id, path: `notes/ithaca-${id}.md`, title: `Ithaca ${id}`, type: "note",
  inDegree: degree, outDegree: 0, pagerank,
});

test("uses the graph's full score extent and an exponential curve", () => {
  const nodes = [node(1, 0), node(2, 50), node(3, 100)];
  const sizes = graphNodeSizes(nodes, "degree");
  expect(sizes.size).toBe(3);
  expect(sizes.get(1)).toBe(4);
  expect(sizes.get(3)).toBe(16);
  expect(sizes.get(2)).toBeCloseTo(7.2273, 4);
  // The same score changes size when a stronger node joins the entire set.
  const expanded = graphNodeSizes([...nodes, node(4, 200)], "degree");
  expect(expanded.get(4)).toBe(16);
  expect(expanded.get(2)).toBeCloseTo(5.2184, 4);
});

test("normalizes raw PageRank scores instead of arbitrary numeric bands", () => {
  const sizes = graphNodeSizes([node(1, 20, 0.002), node(2, 20, 0.004), node(3, 20, 0.006)], "pagerank");
  expect(sizes.get(1)).toBe(4);
  expect(sizes.get(2)).toBeCloseTo(7.2273, 4);
  expect(sizes.get(3)).toBe(16);
});

test("equal scores and empty sets do not create invalid radii", () => {
  expect([...graphNodeSizes([node(1, 8), node(2, 8)], "degree").values()]).toEqual([4, 4]);
  expect(graphNodeSizes([], "degree").size).toBe(0);
});

test("the virtual entry point stays prominent without altering real-node normalization", () => {
  const nodes = [node(1, 2), node(2, 30)];
  const sizes = graphNodeSizes([...nodes, { ...node(-1, 999), virtual: true }], "degree");
  expect(sizes.get(-1)).toBe(16);
  expect(sizes.get(1)).toBe(4);
  expect(sizes.get(2)).toBe(16);
});
