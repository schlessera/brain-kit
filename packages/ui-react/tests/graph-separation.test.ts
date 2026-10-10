import { expect, test } from "bun:test";
import { separateNodes } from "../src/components/graph/lib/separate-nodes.js";

test("separates coincident same-category nodes while retaining the input positions", () => {
  const nodes = Array.from({ length: 36 }, (_, i) => ({ id: String(i), x: i < 18 ? 0 : 0.15, y: 0, size: 6 }));
  const snapshot = structuredClone(nodes);
  const separated = separateNodes(nodes, 700, 600, 3);
  const span = Math.max(
    Math.max(...separated.map(n => n.x)) - Math.min(...separated.map(n => n.x)),
    Math.max(...separated.map(n => n.y)) - Math.min(...separated.map(n => n.y)),
    1,
  );
  let minimumGap = Infinity;
  for (let i = 0; i < separated.length; i++) for (let j = 0; j < i; j++) {
    const a = separated[i]!, b = separated[j]!;
    minimumGap = Math.min(minimumGap, Math.hypot(a.x - b.x, a.y - b.y) * 520 / span - a.size - b.size);
  }
  expect(minimumGap, "actual circumference gap at the fitted viewport").toBeGreaterThan(2.5);
  expect(nodes).toEqual(snapshot);
  expect(separateNodes(nodes, 700, 600, 3)).toEqual(separated);
});

test("a remote two-note branch follows its attachment after the dense layout settles", () => {
  const nodes = [
    { id: "tools", x: 0, y: 0, size: 4 },
    { id: "raft", x: 0.1, y: 0, size: 4 },
    { id: "workshop", x: 0.05, y: 0.1, size: 4 },
    { id: "ask", x: -800, y: -500, size: 4 },
    { id: "reminder", x: -900, y: -550, size: 4 },
  ];
  const links = [
    { source: "tools", target: "raft" }, { source: "raft", target: "workshop" },
    { source: "workshop", target: "tools" },
    { source: "ask", target: "tools" }, { source: "reminder", target: "ask" },
  ];
  const snapshot = structuredClone(nodes);
  const result = separateNodes(nodes, 700, 600, 0.5, links);
  const span = Math.max(
    Math.max(...result.map(n => n.x)) - Math.min(...result.map(n => n.x)),
    Math.max(...result.map(n => n.y)) - Math.min(...result.map(n => n.y)), 1,
  );
  const distance = (a: number, b: number) => Math.hypot(result[a]!.x - result[b]!.x, result[a]!.y - result[b]!.y) * 520 / span;
  expect(distance(3, 0), "auger reminder stays near its attachment").toBeLessThan(30);
  expect(distance(4, 3), "second reminder stays near the first reminder").toBeLessThan(30);
  for (let i = 0; i < result.length; i++) for (let j = 0; j < i; j++) expect(distance(i, j)).toBeGreaterThan(7.9);
  expect(nodes).toEqual(snapshot);
  expect(separateNodes(nodes, 700, 600, 0.5, links)).toEqual(result);
  expect(separateNodes(nodes, 700, 600, 0.5, [...links, { source: "tools", target: "ask" }])).toEqual(result);
});

test("collision-only resizing preserves already settled community centers", () => {
  const nodes = [
    { id: "a", x: -10, y: 0, size: 1, community: 0 },
    { id: "b", x: -10, y: 1, size: 1, community: 0 },
    { id: "c", x: 10, y: 0, size: 1, community: 1 },
    { id: "d", x: 10, y: 1, size: 1, community: 1 },
  ];
  expect(separateNodes(nodes, 700, 600, 0.5, [], false)).toEqual(nodes);
  const settled = separateNodes(nodes, 700, 600);
  expect(settled[2]!.x - settled[0]!.x).toBeLessThan(5);
});

test("linked pairs form tighter groups than equally spaced unrelated nodes", () => {
  const nodes = [
    { id: "a", x: 0, y: 0, size: 6 },
    { id: "b", x: 0.4, y: 0, size: 6 },
    { id: "c", x: 0, y: 0.4, size: 6 },
    { id: "d", x: 0.4, y: 0.4, size: 6 },
  ];
  const links = [{ source: "a", target: "b" }, { source: "c", target: "d" }];
  const snapshot = structuredClone(nodes);
  const separated = separateNodes(nodes, 700, 600, 3, links);
  const distance = (i: number, j: number) => Math.hypot(separated[i]!.x - separated[j]!.x, separated[i]!.y - separated[j]!.y);
  expect(distance(0, 1)).toBeLessThan(distance(0, 2) * 0.65);
  expect(distance(2, 3)).toBeLessThan(distance(1, 3) * 0.65);
  // The fitted viewport must still leave visible separation between marks.
  for (let i = 0; i < nodes.length; i++) for (let j = 0; j < i; j++) {
    expect(distance(i, j) * 520 - 12).toBeGreaterThan(0.9);
  }
  expect(nodes).toEqual(snapshot);
  expect(separateNodes(nodes, 700, 600, 3, links)).toEqual(separated);
  // Reciprocal records express the same neighbor relationship, not two pulls.
  expect(separateNodes(nodes, 700, 600, 3, [...links, { source: "b", target: "a" }])).toEqual(separated);
});
