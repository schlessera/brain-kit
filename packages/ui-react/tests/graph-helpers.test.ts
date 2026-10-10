import { describe, expect, test } from "bun:test";
import { LIGHT_TOKENS, TOKENS } from "@schlessera/brain-ui-kit/internal";
import { graphTheme } from "../src/components/graph/use-graph-theme.js";
import {
  SLOT_COUNT,
  assignFolderColors,
  buildQuery,
  communityColor,
  distanceColor,
  groupCommunities,
  labelSet,
  matchScene,
  mergeSubgraphs,
  mixColors,
  nodeSize,
  radialLayout,
  topLevelDir,
} from "../src/lib/graph-helpers.js";
import type { GraphSubgraphResponse } from "@schlessera/brain-ui-sdk/protocol";

function node(
  id: number,
  overrides: Partial<GraphSubgraphResponse["nodes"][number]> = {}
) {
  return {
    id,
    path: `notes/n${id}.md`,
    title: `Note ${id}`,
    type: "note",
    inDegree: 0,
    outDegree: 0,
    ...overrides,
  };
}

describe("buildQuery", () => {
  test("drops null/undefined/empty and encodes the rest", () => {
    expect(
      buildQuery({ center: "a b/c.md", depth: 2, skip: null, gone: undefined, blank: "" })
    ).toBe("center=a%20b%2Fc.md&depth=2");
  });

  test("empty bag yields empty string", () => {
    expect(buildQuery({ a: null })).toBe("");
  });
});

describe("mergeSubgraphs", () => {
  test("dedupes nodes by id, keeping the richer existing record", () => {
    const base: GraphSubgraphResponse = {
      nodes: [node(1, { community: 3, x: 1, y: 2 }), node(2)],
      edges: [{ source: 1, target: 2 }],
      truncated: false,
    };
    const addition: GraphSubgraphResponse = {
      nodes: [node(1), node(3)],
      edges: [
        { source: 1, target: 2 },
        { source: 1, target: 3 },
      ],
      truncated: false,
    };
    const merged = mergeSubgraphs(base, addition);
    expect(merged.nodes).toHaveLength(3);
    expect(merged.nodes.find((n) => n.id === 1)?.community).toBe(3);
    expect(merged.edges).toHaveLength(2);
  });

  test("truncated is sticky", () => {
    const a: GraphSubgraphResponse = { nodes: [], edges: [], truncated: true };
    const b: GraphSubgraphResponse = { nodes: [], edges: [], truncated: false };
    expect(mergeSubgraphs(a, b).truncated).toBe(true);
  });
});

describe("radialLayout", () => {
  test("root sits at the origin, rings at their distance", () => {
    const positions = radialLayout([
      { id: 0, distance: 0 },
      { id: 1, distance: 1 },
      { id: 2, distance: 1 },
      { id: 3, distance: 2 },
    ]);
    expect(positions.get(0)).toEqual({ x: 0, y: 0 });
    const r1 = positions.get(1)!;
    expect(Math.hypot(r1.x, r1.y)).toBeCloseTo(1);
    const r3 = positions.get(3)!;
    expect(Math.hypot(r3.x, r3.y)).toBeCloseTo(2);
  });

  test("deterministic across calls and input order", () => {
    const a = radialLayout([
      { id: 5, distance: 1 },
      { id: 9, distance: 1 },
    ]);
    const b = radialLayout([
      { id: 9, distance: 1 },
      { id: 5, distance: 1 },
    ]);
    expect([...a.keys()].sort()).toEqual([5, 9]);
    expect([...b.keys()].sort()).toEqual([5, 9]);
    expect(a.get(5)).toEqual(b.get(5));
    expect(a.get(9)).toEqual(b.get(9));
  });
});

describe("nodeSize", () => {
  test("grows with degree but stays within bounds", () => {
    const small = nodeSize(node(1));
    const large = nodeSize(node(2, { inDegree: 45, outDegree: 10 }));
    expect(small).toBeGreaterThanOrEqual(3);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(14);
  });

  test("the virtual root is always maximal", () => {
    expect(nodeSize(node(0, { virtual: true }))).toBe(14);
  });
});

describe("palette", () => {
  // No document here, so the theme resolves from the kit's own tables — the
  // dark set and the paper set — which is also the proof that both reach
  // the canvas as values, not as `light-dark()` strings.
  const dark = graphTheme("dark").palette;
  const paper = graphTheme("light").palette;

  test("the palette is the kit's canvas tokens, per scheme, and nothing is left unresolved", () => {
    expect(dark.slots[0]).toBe(TOKENS["canvas-slot-1"]);
    expect(paper.slots[0]).toBe(LIGHT_TOKENS["canvas-slot-1"]);
    expect(dark.root).toBe(TOKENS["canvas-root"]);
    expect(paper.lens.broken).toBe(LIGHT_TOKENS["canvas-lens-broken"]);
    for (const palette of [dark, paper]) {
      const values = [...palette.slots, ...palette.ramp, palette.root, palette.other, ...Object.values(palette.lens)];
      for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("the first eight communities get distinct slots, in the same order in both themes", () => {
    for (const palette of [dark, paper]) {
      const seen = new Set<string>();
      for (let i = 0; i < SLOT_COUNT; i++) seen.add(communityColor(i, palette));
      expect(seen.size).toBe(8);
      expect(palette.slots).toHaveLength(SLOT_COUNT);
    }
    // Slot order is the CVD mechanism: community 2 is slot 3 on both grounds.
    expect(communityColor(2, dark)).toBe(TOKENS["canvas-slot-3"]);
    expect(communityColor(2, paper)).toBe(LIGHT_TOKENS["canvas-slot-3"]);
  });

  test("the long tail folds into the recessive color", () => {
    expect(communityColor(8, dark)).toBe(dark.other);
    expect(communityColor(120, dark)).toBe(dark.other);
    expect(communityColor(8, paper)).toBe(paper.other);
  });

  test("distance 0 is the root, far distances clamp to the ramp end", () => {
    expect(dark.ramp).toHaveLength(5);
    expect(paper.ramp).toHaveLength(5);
    expect(distanceColor(0, dark)).toBe(dark.root);
    expect(distanceColor(1, dark)).toBe(dark.ramp[0]);
    expect(distanceColor(99, dark)).toBe(dark.ramp[dark.ramp.length - 1]);
    expect(distanceColor(99, paper)).toBe(paper.ramp[paper.ramp.length - 1]);
  });
});

describe("assignFolderColors", () => {
  test("biggest folders get slots, tail gets the recessive color", () => {
    const paths = [
      ...Array.from({ length: 5 }, (_, i) => `career/a${i}.md`),
      ...Array.from({ length: 3 }, (_, i) => `talks/b${i}.md`),
      "one/x.md",
      "two/x.md",
      "three/x.md",
      "four/x.md",
      "five/x.md",
      "six/x.md",
      "seven/x.md",
    ];
    const palette = graphTheme("dark").palette;
    const colors = assignFolderColors(paths, palette);
    expect(colors.get("career")).toBe(palette.slots[0]);
    expect(colors.get("talks")).toBe(palette.slots[1]);
    // Ties rank alphabetically: five, four, one, seven, six, three fill the
    // remaining slots — "two" is the ninth directory and folds to Other.
    expect(colors.get("two")).toBe(palette.other);
  });

  test("topLevelDir extracts the first segment", () => {
    expect(topLevelDir("career/opportunities/x.md")).toBe("career");
    expect(topLevelDir("rootfile.md")).toBe("");
  });
});

describe("groupCommunities", () => {
  test("splits singletons out and sorts by size", () => {
    const groups = groupCommunities([
      { community: 2, size: 1 },
      { community: 0, size: 10 },
      { community: 1, size: 4 },
      { community: 3, size: 1 },
    ]);
    expect(groups.major.map((c) => c.community)).toEqual([0, 1]);
    expect(groups.singletonCount).toBe(2);
  });
});

describe("labelSet", () => {
  const nodes = Array.from({ length: 50 }, (_, i) =>
    node(i, { inDegree: i, outDegree: 0 })
  );

  test("selection, hover, matches and virtual root are always labeled", () => {
    const set = labelSet({
      nodes: [...nodes, node(999, { virtual: true })],
      selectedId: 3,
      hoveredId: 4,
      matchIds: new Set([5]),
      cameraRatio: 1,
    });
    for (const id of [3, 4, 5, 999]) expect(set.has(id)).toBe(true);
  });

  test("zooming in raises the quota, never to everything", () => {
    const out = labelSet({
      nodes,
      selectedId: null,
      hoveredId: null,
      matchIds: new Set(),
      cameraRatio: 2,
    });
    const zoomed = labelSet({
      nodes,
      selectedId: null,
      hoveredId: null,
      matchIds: new Set(),
      cameraRatio: 0.1,
    });
    expect(zoomed.size).toBeGreaterThan(out.size);
    expect(zoomed.size).toBeLessThanOrEqual(60);
  });

  test("quota picks the highest-ranked nodes", () => {
    const set = labelSet({
      nodes,
      selectedId: null,
      hoveredId: null,
      matchIds: new Set(),
      cameraRatio: 4,
    });
    expect(set.has(49)).toBe(true); // highest degree
    expect(set.has(0)).toBe(false); // lowest degree
  });
});

describe("matchScene", () => {
  const nodes = [
    node(1, { title: "Context Engineering", path: "expertise/context-engineering.md" }),
    node(2, { title: "Travel", path: "travel/plans.md" }),
  ];

  test("matches title and path case-insensitively", () => {
    expect(matchScene(nodes, "context")).toEqual(new Set([1]));
    expect(matchScene(nodes, "TRAVEL")).toEqual(new Set([2]));
  });

  test("queries under two characters match nothing", () => {
    expect(matchScene(nodes, "c").size).toBe(0);
    expect(matchScene(nodes, " ").size).toBe(0);
  });
});

describe("mixColors", () => {
  test("t=0 returns the first color, t=1 the second", () => {
    expect(mixColors("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixColors("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  test("t=0.5 blends channel-wise", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColors("#2a2d35", "#2a2d35", 0.5)).toBe("#2a2d35");
  });

  test("clamps t and tolerates a leading-#-less hex", () => {
    expect(mixColors("#102030", "#304050", 2)).toBe("#304050");
    expect(mixColors("102030", "#304050", 0)).toBe("#102030");
  });

  test("unparseable input degrades to the fade target", () => {
    expect(mixColors("oklch(0.5 0.1 200)", "#2a2d35", 0.5)).toBe("#2a2d35");
    expect(mixColors("#12345", "#2a2d35", 0.5)).toBe("#2a2d35");
  });
});
