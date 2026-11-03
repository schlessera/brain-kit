/**
 * Adaptive ports and lanes (#3534): one fan-out section between a planner and
 * a gate, laid out like the diagram that motivated the change. Declared-order
 * ports crossed eight times; adaptive routing has none, and every route and
 * label keeps the image margin and the section padding.
 */
import { expect, test } from "bun:test";
import { buildDiagram, diagramGroupBounds, DIAGRAM_MARGIN, type DiagramConnector, type DiagramGroup, type DiagramTree } from "../src/geometry.js";
import { checkDiagram } from "../src/check.js";
import { parseDocument } from "yaml";

const box = (id: string, label: string, at: [number, number], size: [number, number] = [152, 64]) => ({ id, label, at, size });
const voyage = {
  schema_version: 1, type: "architecture", title: "Leaving Ogygia", desc: "Calypso's oracle and ledger feed the plan; four preparations run side by side before Odysseus departs on 2026-07-12.", size: "fit",
  nodes: [box("oracle", "Oracle", [16, 16], [152, 56]), box("ledger", "Ledger", [264, 16], [152, 56]), box("plan", "Plan voyage", [132, 152], [176, 64]),
    box("food", "Stow food", [16, 272]), box("hull", "Repair hull", [264, 272]), box("stars", "Chart stars", [16, 424]), box("crew", "Train crew", [264, 424]),
    box("depart", "Depart Ogygia", [132, 568], [176, 64])],
  edges: [{ from: "hull", to: "depart" }, { from: "food", to: "depart" }, { from: "oracle", to: "plan" }, { from: "ledger", to: "plan", kind: "async" },
    { from: "plan", to: "food" }, { from: "plan", to: "hull" }, { from: "plan", to: "stars" }, { from: "plan", to: "crew" }, { from: "crew", to: "depart" }, { from: "stars", to: "depart" }],
  groups: [{ id: "prep", label: "PARALLEL PREPARATIONS", members: ["food", "hull", "stars", "crew"] }],
};
const routes = (tree: DiagramTree) => tree.elements.filter((item): item is DiagramConnector => item.kind === "connector");

test("a fan-out through a section routes with no crossings, its outer flows mirrored", () => {
  expect(checkDiagram(JSON.stringify(voyage)).errors).toEqual([]);
  const tree = buildDiagram(voyage as never), all = routes(tree);
  expect(all.reduce((n, route) => n + route.bridges.length, 0), "ADAPTIVE_NO_CROSSINGS").toBe(0);
  // Plan to the far row goes around the section on both sides, at equal distance.
  const stars = all.find(route => route.to.node === "stars")!, crew = all.find(route => route.to.node === "crew")!;
  const outer = (route: DiagramConnector, side: "left" | "right") => side === "left" ? Math.min(...route.points.map(p => p.x)) : Math.max(...route.points.map(p => p.x));
  const section = diagramGroupBounds(tree.elements.find((item): item is DiagramGroup => item.kind === "group")!);
  expect(section.x - outer(stars, "left"), "LEFT_OUTER_LANE").toBeGreaterThan(0);
  expect(outer(crew, "right") - (section.x + section.width), "RIGHT_OUTER_LANE").toBeGreaterThan(0);
});

test("routes keep the section's padding wherever they run alongside its outline", () => {
  const tree = buildDiagram(voyage as never), group = tree.elements.find((item): item is DiagramGroup => item.kind === "group")!;
  for (const route of routes(tree)) for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]!, b = route.points[i]!, vertical = Math.abs(a.x - b.x) < 1e-7;
    const [lo, hi] = vertical ? [Math.min(a.y, b.y), Math.max(a.y, b.y)] : [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const span = vertical ? [group.y, group.y + group.height] : [group.x, group.x + group.width];
    if (Math.min(hi, span[1]!) - Math.max(lo, span[0]!) <= 16) continue;
    for (const edge of vertical ? [group.x, group.x + group.width] : [group.y, group.y + group.height])
      expect(Math.abs((vertical ? a.x : a.y) - edge), `SECTION_PADDING ${route.id} segment ${i}`).toBeGreaterThanOrEqual(16);
  }
});

test("a fitted image keeps one uniform margin around everything painted", async () => {
  const sources = [JSON.stringify(voyage), ...["architecture", "dependency", "flowchart", "state-machine", "tree", "er"].map(name => Bun.file(new URL(`../skills/diagram/references/examples/${name}.diagram.yaml`, import.meta.url)))];
  for (const source of sources) {
    const tree = buildDiagram(parseDocument(typeof source === "string" ? source : await source.text()).toJS());
    const painted = tree.elements.flatMap(item => item.kind === "connector" ? item.points.map(p => ({ x: p.x, y: p.y, width: 0, height: 0 })) : item.kind === "group" ? [diagramGroupBounds(item)] : "width" in item ? [item as { x: number; y: number; width: number; height: number }] : []);
    const left = Math.min(...painted.map(b => b.x)), top = Math.min(...painted.map(b => b.y)), right = Math.max(...painted.map(b => b.x + b.width)), bottom = Math.max(...painted.map(b => b.y + b.height));
    const { x, y, width, height } = tree.viewBox;
    expect(left - x, `FIT_MARGIN_LEFT ${tree.title}`).toBeCloseTo(DIAGRAM_MARGIN, 6);
    expect(top - y, `FIT_MARGIN_TOP ${tree.title}`).toBeCloseTo(DIAGRAM_MARGIN, 6);
    for (const [name, gap] of [["RIGHT", x + width - right], ["BOTTOM", y + height - bottom]] as const) {
      expect(gap, `FIT_MARGIN_${name} ${tree.title}`).toBeGreaterThanOrEqual(DIAGRAM_MARGIN - 1e-6);
      expect(gap, `FIT_MARGIN_${name} ${tree.title}`).toBeLessThan(DIAGRAM_MARGIN + 4);
    }
    expect(width % 4).toBe(0); expect(height % 4).toBe(0);
  }
});

test("on a named canvas a box inside the image margin warns", () => {
  // Shifted inward so the section and its heading lie on the canvas.
  const inset = { ...voyage, size: "doc-wide", nodes: voyage.nodes.map(node => ({ ...node, at: [node.at[0] + 32, node.at[1] + 32] as [number, number] })) };
  const near = { ...inset, nodes: inset.nodes.map(node => node.id === "oracle" ? { ...node, at: [4, 48] as [number, number] } : node), groups: undefined };
  const result = checkDiagram(JSON.stringify(near));
  expect(result.errors).toEqual([]);
  expect(result.warnings, "PRESET_MARGIN_WARNS").toContainEqual({ path: "$.nodes[0].at", code: "margin", message: "Node 'oracle' is closer than 12px to the canvas edge; move it inward or use size: fit" });
  const clear = checkDiagram(JSON.stringify(inset));
  expect(clear.errors).toEqual([]);
  expect(clear.warnings.filter(w => w.code === "margin")).toEqual([]);
});

test("on a named canvas a route detours on the side that keeps the image margin", () => {
  // Around Scylla, the left lane would run at x = 0; the right one keeps the margin.
  const strait = { schema_version: 1, type: "architecture", title: "Around the rock", desc: "Odysseus steers around Scylla on 2026-07-12.", size: "doc-inline",
    nodes: [box("ship", "Ship", [24, 24], [152, 48]), box("scylla", "Scylla", [24, 120], [152, 48]), box("passage", "Strait", [24, 216], [152, 48])], edges: [{ from: "ship", to: "passage" }] };
  expect(checkDiagram(JSON.stringify(strait)).errors).toEqual([]);
  const [route] = routes(buildDiagram(strait as never));
  for (const p of route!.points) expect(p.x, "PRESET_ROUTE_MARGIN").toBeGreaterThanOrEqual(DIAGRAM_MARGIN);
});
