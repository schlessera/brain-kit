import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkDiagram } from "../src/check.js";
import { buildDiagram } from "../src/geometry.js";
import { buildDiagramLayout, diagramLayout } from "../src/layout.js";
import type { DiagramSpec } from "../src/spec.js";
import { assertSixRules } from "./geometry-assertions.js";
const source = readFileSync(new URL("./fixtures/adopted-homecoming-relay.diagram.yaml", import.meta.url), "utf8");
const spec: DiagramSpec = JSON.parse(source);
test("ADOPTED_NARROW_DELIVER_MASK: exact semantic model and authored placements build", () => {
 expect(checkDiagram(source).errors, "ADOPTED_NARROW_DELIVER_MASK").toEqual([]);
 const before = JSON.stringify(spec);
 for (const layout of ["default", "narrow"] as const) {
  const placed = diagramLayout(spec, layout), tree = buildDiagramLayout(spec, layout);
  expect(tree).toEqual(buildDiagramLayout(spec, layout));
  expect(tree.elements.filter(e => e.kind === "node")).toHaveLength(8);
  expect(tree.elements.filter(e => e.kind === "connector")).toHaveLength(7);
  expect(tree.elements.filter(e => e.kind === "edge-label").map(e => e.text)).toContain("DELIVER");
  assertSixRules(placed, tree);
 }
 expect(JSON.stringify(spec)).toBe(before);
});
test("removing only DELIVER's label is a diagnostic isolation control", () => {
 const copy = structuredClone(spec); delete copy.edges.find(e => e.id === "deliver")!.label;
 expect(checkDiagram(JSON.stringify(copy)).valid).toBe(true);
 expect(buildDiagram(diagramLayout(copy, "narrow")).elements.filter(e => e.kind === "connector")).toHaveLength(7);
});
for (const reflectX of [false, true]) for (const reflectY of [false, true]) test(`actual padded quarter arcs retain clearance in reflected orientation ${reflectX}/${reflectY}`, () => {
 const copy = structuredClone(spec);
 for (const node of copy.layouts!.narrow.nodes) {
  if (reflectX) node.at[0] = 320 - node.at[0] - node.size[0];
  if (reflectY) node.at[1] = 1088 - node.at[1] - node.size[1];
 }
 const placed = diagramLayout(copy, "narrow"), tree = buildDiagramLayout(copy, "narrow");
 assertSixRules(placed, tree);
 const turns = new Set<string>();
 for (const edge of tree.elements) if (edge.kind === "connector") for (let i = 1; i < edge.points.length - 1; i++) {
  const a = edge.points[i - 1]!, b = edge.points[i]!, c = edge.points[i + 1]!;
  turns.add(`${Math.sign(b.x - a.x)},${Math.sign(b.y - a.y)}:${Math.sign(c.x - b.x)},${Math.sign(c.y - b.y)}`);
 }
 expect(turns.size).toBeGreaterThan(0);
});
test("reflections cover all eight directed quarter-arc orientations", () => {
 const turns = new Set<string>();
 for (const reflectX of [false, true]) for (const reflectY of [false, true]) {
  const copy = structuredClone(spec);
  for (const node of copy.layouts!.narrow.nodes) {
   if (reflectX) node.at[0] = 320 - node.at[0] - node.size[0];
   if (reflectY) node.at[1] = 1088 - node.at[1] - node.size[1];
  }
  for (const edge of buildDiagramLayout(copy, "narrow").elements) if (edge.kind === "connector") for (let i = 1; i < edge.points.length - 1; i++) {
   const a = edge.points[i - 1]!, b = edge.points[i]!, c = edge.points[i + 1]!;
   turns.add(`${Math.sign(b.x - a.x)},${Math.sign(b.y - a.y)}:${Math.sign(c.x - b.x)},${Math.sign(c.y - b.y)}`);
  }
 }
 expect(turns.size).toBe(8);
});
