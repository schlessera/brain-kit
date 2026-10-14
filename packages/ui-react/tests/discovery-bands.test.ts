import { expect, test } from "bun:test";
import { radialLayout } from "../src/lib/graph-helpers.js";

test("DISCOVERY_COMMUNITY_BRANCH_ORDER: assigned topics precede absent topics", () => {
  const nodes = [
    { id: 1, distance: 0 },
    { id: 5, distance: 1, community: 2 },
    { id: 9, distance: 1, community: 0 },
    { id: 3, distance: 1 },
    { id: 7, distance: 1, community: 0 },
  ];
  const positions = radialLayout(nodes);
  const angle = (id: number) => {
    const p = positions.get(id)!;
    return (Math.atan2(p.x, p.y) + 2 * Math.PI) % (2 * Math.PI);
  };
  expect([7, 9, 5, 3].map(angle)).toEqual(
    [7, 9, 5, 3].map(angle).sort((a, b) => a - b)
  );
});

import {
  discoveryLayout,
  DISCOVERY_PACKING,
} from "../src/lib/discovery-layout.js";
type N = Parameters<typeof discoveryLayout>[0][number];
type E = Parameters<typeof discoveryLayout>[1][number];
function fixture(counts = [9, 130, 204, 118, 37, 6, 1]) {
  const nodes: N[] = [{ id: 0, distance: 0, virtual: true }],
    edges: E[] = [];
  let id = 1,
    previous = [0];
  counts.forEach((count, ring) => {
    const current: number[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push({ id, distance: ring + 1, community: i % 3 });
      edges.push({ source: previous[i % previous.length]!, target: id });
      current.push(id++);
    }
    previous = current;
  });
  return { nodes, edges };
}
function invariants(data: ReturnType<typeof fixture>) {
  const result = discoveryLayout(data.nodes, data.edges);
  expect(result.positions.size).toBe(data.nodes.length);
  for (const n of data.nodes) {
    const p = result.positions.get(n.id)!;
    expect(Math.abs(p.radius - (n.distance ?? 0))).toBeLessThanOrEqual(
      0.3000000001
    );
    if ((n.distance ?? 0) === 0) {
      expect([p.x, p.y]).toEqual([0, 0]);
      continue;
    }
    const w = result.wedges.find((w) => w.id === p.branch)!;
    expect(p.angle).toBeGreaterThanOrEqual(w.start - 1e-10);
    expect(p.angle).toBeLessThanOrEqual(w.end + 1e-10);
  }
  for (const w of result.wedges)
    for (const [d, L] of result.lanes) {
      const ps = [...result.positions.values()]
        .filter((p) => p.branch === w.id && Math.round(p.radius) === d)
        .sort((a, b) => a.angle - b.angle);
      for (let i = 1; i < ps.length; i++) {
        expect(ps[i]!.angle - ps[i - 1]!.angle).toBeGreaterThanOrEqual(
          (Math.min(1, result.scale) * DISCOVERY_PACKING.pitch) / (d * L) -
            1e-10
        );
        const a = ps[i - 1]!,
          b = ps[i]!;
        const pa =
          result.positions.get(a.parent!)?.angle ?? (w.start + w.end) / 2;
        const pb =
          result.positions.get(b.parent!)?.angle ?? (w.start + w.end) / 2;
        expect(pa).toBeLessThanOrEqual(pb + 1e-10);
      }
    }
  return result;
}
test("DISCOVERY_G1_G4: dense, sparse and dominant bands preserve membership, bounds and parent order", () => {
  invariants(fixture());
  invariants(fixture([1, 300, 200]));
  invariants(fixture([3, 6, 5]));
});
test("DISCOVERY_G5: all input permutations preserve the exact canonical output", () => {
  const data = fixture();
  const expected = discoveryLayout(data.nodes, data.edges);
  for (let k = 0; k < 6; k++) {
    const nodes = [...data.nodes].sort(
      (a, b) => ((a.id * (k + 13)) % 47) - ((b.id * (k + 13)) % 47)
    );
    const edges = [...data.edges]
      .reverse()
      .slice(k)
      .concat([...data.edges].reverse().slice(0, k));
    expect(discoveryLayout(nodes, edges)).toEqual(expected);
  }
});
test("DISCOVERY_DIRECTED_MIN_PARENT: virtual seeds, cross-branch edges and missing descendants", () => {
  const nodes: N[] = [
    { id: 0, distance: 0, virtual: true },
    { id: 1, distance: 1 },
    { id: 2, distance: 1 },
    { id: 3, distance: 2 },
    { id: 4, distance: 2 },
    { id: 5, distance: 3 },
  ];
  const edges = [
    { source: 0, target: 1 },
    { source: 0, target: 2 },
    { source: 2, target: 3 },
    { source: 1, target: 3 },
    { source: 4, target: 2 },
    { source: 4, target: 5 },
    { source: 3, target: 2 },
  ];
  const r = invariants({ nodes, edges });
  expect(r.positions.get(1)!.parent).toBe(0);
  expect(r.positions.get(3)!.parent).toBe(1);
  expect(r.positions.get(4)!.parent).toBeNull();
  expect(r.positions.get(5)!.branch).toBeNull();
  expect(r.wedges.at(-1)!.id).toBeNull();
  expect(edges).toContainEqual({ source: 2, target: 3 });
  expect(r.positions.get(2)!.branch).toBe(2);
  expect(r.positions.get(3)!.branch).toBe(1);
  expect(
    edges.some(
      (e) =>
        r.positions.get(e.source)!.branch !== r.positions.get(e.target)!.branch
    )
  ).toBe(true);
});
test("DISCOVERY_LANE_THRESHOLD: 41 to 42 repacks an untouched branch inside the same band", () => {
  const data = fixture([2, 41]);
  const before = invariants(data);
  const survivor = data.nodes.find((n) => n.distance === 2)!;
  data.nodes.push({ id: 99, distance: 2 });
  data.edges.push({ source: 2, target: 99 });
  const after = invariants(data);
  expect(before.lanes.get(2)).toBe(1);
  expect(after.lanes.get(2)).toBe(2);
  expect(before.positions.get(survivor.id)!.radius).toBe(2);
  expect(after.positions.get(survivor.id)!.radius).toBe(1.9);
});
test("DISCOVERY_DEMAND: increasing A narrows B and retains geometric guarantees", () => {
  const data = fixture([2, 40]);
  const before = invariants(data);
  // Grow only A until its demand exceeds B's; B's node identities do not change.
  for (let i = 0; i < 120; i++) {
    data.nodes.push({ id: 1000 + i, distance: 3 });
    data.edges.push({ source: 3, target: 1000 + i });
  }
  const after = invariants(data);
  const width = (r: typeof before) => {
    const w = r.wedges.find((w) => w.id === 2)!;
    return w.end - w.start;
  };
  expect(width(after)).toBeLessThan(width(before));
  expect(
    [...before.positions].filter(([, p]) => p.branch === 2).map(([id]) => id)
  ).toEqual(
    [...after.positions].filter(([, p]) => p.branch === 2).map(([id]) => id)
  );
});
test("DISCOVERY_Z_CLIP: five children targeting a wedge edge retain strict separation", () => {
  const data = fixture([2, 2, 5]);
  data.edges = data.edges.filter(
    (e) => !data.nodes.some((n) => n.id === e.target && n.distance === 3)
  );
  for (const n of data.nodes.filter((n) => n.distance === 3))
    data.edges.push({ source: 3, target: n.id });
  data.edges = data.edges.map((e) =>
    e.target === 4 ? { ...e, source: 1 } : e
  );
  // A competing branch compresses this wedge until the predecessor target
  // lies beyond the feasible packed block's edge: clipping theta collapses it.
  for (let i = 0; i < 200; i++) {
    data.nodes.push({ id: 100 + i, distance: 2 });
    data.edges.push({ source: 2, target: 100 + i });
  }
  const r = invariants(data);
  const children = data.nodes
    .filter((n) => n.distance === 3)
    .map((n) => r.positions.get(n.id)!);
  expect(new Set(children.map((p) => p.angle)).size).toBe(5);
});
test("DISCOVERY_SIGNATURE: geometry accepts only scene nodes and directed scene edges", () => {
  expect(discoveryLayout.length).toBe(2);
  expect(
    discoveryLayout
      .toString()
      .match(/^function discoveryLayout\(([^)]*)\)/)?.[1]
      ?.replace(/\s/g, "")
  ).toBe("nodes,edges");
});

test("DISCOVERY_EXACT_WEDGE_ALLOCATION: demand 1+1 then 2+1 gives reviewed K values", () => {
  const nodes: N[] = [
      { id: 0, distance: 0 },
      { id: 1, distance: 1 },
      { id: 2, distance: 1 },
    ],
    edges: E[] = [];
  let id = 3;
  for (const root of [1, 2]) {
    const parent = id;
    for (let i = 0; i < 6; i++) {
      nodes.push({ id, distance: 2 });
      edges.push({ source: root, target: id++ });
    }
    for (let i = 0; i < 10; i++) {
      nodes.push({ id, distance: 3 });
      edges.push({ source: parent, target: id++ });
    }
  }
  const before = invariants({ nodes, edges });
  expect(before.wedges.map((w) => w.demand)).toEqual([1, 1]);
  expect(before.scale).toBeCloseTo(2.984513, 5);
  const parent = 3;
  for (let i = 0; i < 10; i++) {
    nodes.push({ id, distance: 3 });
    edges.push({ source: parent, target: id++ });
  }
  const after = invariants({ nodes, edges });
  expect(after.wedges.map((w) => w.demand)).toEqual([2, 1]);
  expect(after.scale).toBeCloseTo(1.989675, 5);
});

test("DISCOVERY_NULL_COMMUNITIES: null and missing share the unassigned ordering", () => {
  const nodes: N[] = [
    { id: 0, distance: 0 },
    { id: 5, distance: 1, community: 2 },
    { id: 9, distance: 1, community: 0 },
    { id: 3, distance: 1, community: null },
    { id: 7, distance: 1, community: 0 },
    { id: 4, distance: 1 },
    { id: 6, distance: 2 },
  ];
  expect(discoveryLayout(nodes, []).wedges.map((w) => w.id)).toEqual([
    7,
    9,
    5,
    3,
    4,
    null,
  ]);
});
