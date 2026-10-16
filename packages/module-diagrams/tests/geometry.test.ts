import { expect, test } from "bun:test";
import { buildDiagram, DiagramGeometryError } from "../src/geometry.js";
import { checkDiagram } from "../src/check.js";
import { assertFan, assertIndependent, assertLabelGap, assertMasks, assertOrthogonal, assertPathCorrespondence, assertSixRules, assertTransit, connectors } from "./geometry-assertions.js";
import { cases, node, spec } from "./fixtures/geometry-cases.js";

for (const [name, input] of Object.entries(cases)) test(`upstream free-layout adversarial case re-authored: ${name}`, () => {
  const before = JSON.stringify(input), first = buildDiagram(input), second = buildDiagram(input);
  assertSixRules(input, first);
  expect(JSON.stringify(first), "BYTE_IDENTICAL_GEOMETRY").toBe(JSON.stringify(second));
  expect(JSON.stringify(input), "BUILDER_NEVER_MUTATES_SOURCE").toBe(before);
});
test("rule 1 uses actual orthogonal path commands and rounded corners", () => assertOrthogonal(cases.orthogonal, buildDiagram(cases.orthogonal)));
test("rule 2 measures the opaque label mask gap from the output geometry", () => assertLabelGap(cases.mask, buildDiagram(cases.mask)));
test("rule 3 keeps independently traceable parallel trunks", () => { assertIndependent(cases.trunk, buildDiagram(cases.trunk)); assertIndependent(cases.closeParallel, buildDiagram(cases.closeParallel)); });
test("rule 3 gives one crossing hop to the less important connector", () => {
  const tree = buildDiagram(cases.crossing); assertIndependent(cases.crossing, tree);
  expect(connectors(tree).find(route => route.edge === 0)!.bridges).toEqual([]);
  expect(connectors(tree).find(route => route.edge === 1)!.bridges).toHaveLength(1);
});
test("rule 4 checks actual evenly fanned attachment coordinates", () => assertFan(cases.fan, buildDiagram(cases.fan)));
test("rule 5 reroutes around an avoidable intervening box", () => assertTransit(cases.intervening, buildDiagram(cases.intervening)));
test("rule 5 marks genuinely unavoidable transit and keeps its label at the visible end", () => {
  const tree = buildDiagram(cases.transit); assertTransit(cases.transit, tree); expect(connectors(tree)[0]!.transit).toEqual(["athena"]);
});
test("rule 6 prevents a later node clipping an opaque label mask", () => assertMasks(cases.mask, buildDiagram(cases.mask)));
test("a self loop has separate perpendicular ports and rounded visible geometry", () => {
  const input = spec([node("raft", 300, 200)], [{ from: "raft", to: "raft", label: "RETURN" }]);
  assertSixRules(input, buildDiagram(input));
});
test("group endpoints derive their box from members without moving nodes", () => {
  const input = spec([node("raft", 40, 120), node("athena", 240, 120), node("ithaca", 640, 120)], [{ from: "homecoming", to: "ithaca", label: "WORD" }]);
  input.groups = [{ id: "homecoming", label: "HOMECOMING", members: ["raft", "athena"] }];
  const tree = buildDiagram(input); expect(tree.elements[0]!.kind).toBe("group"); expect(connectors(tree)[0]!.from.node).toBe("homecoming");
  expect(checkDiagram(JSON.stringify(input)).valid).toBe(true);
});
test("generated free-layout specs satisfy all six rules on every successful output", () => {
  let successful = 0, refused = 0;
  for (let seed = 1; seed <= 48; seed++) {
    let value = seed; const random = () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value; };
    const nodes = [node("raft", 40 + random() % 8 * 4, 40 + random() % 8 * 4, 96 + random() % 3 * 16), node("athena", 600 + random() % 8 * 4, 40 + random() % 8 * 4, 96 + random() % 3 * 16), node("penelope", 40 + random() % 8 * 4, 360 + random() % 8 * 4, 96 + random() % 3 * 16), node("ithaca", 600 + random() % 8 * 4, 360 + random() % 8 * 4, 96 + random() % 3 * 16)];
    const edges = [{ from: "raft", to: "athena", label: "WORD" }, { from: "raft", to: "ithaca" }, { from: "penelope", to: "athena" }, { from: "penelope", to: "ithaca", label: "RETURN" }];
    const input = spec(nodes, edges);
    let tree;
    try { tree = buildDiagram(input); } catch (error) { if (!(error instanceof DiagramGeometryError)) throw error; refused++; continue; }
    successful++; assertSixRules(input, tree);
    expect(JSON.stringify(buildDiagram(input)), `DETERMINISTIC_SEED_${seed}`).toBe(JSON.stringify(tree));
  }
  expect(successful, `NONVACUOUS_PROPERTY_OUTPUTS (refused=${refused})`).toBeGreaterThanOrEqual(32);
});


test("emitted path commands correspond to actual routed corners and hops", () => {
  for (const input of [cases.orthogonal, cases.crossing, cases.intervening]) assertPathCorrespondence(input, buildDiagram(input));
});
test("label metric options reject unsupported dimensions and scale measured masks", () => {
  for (const options of [{ labelFontSize: 8 }, { labelFontSize: Infinity }, { labelLineHeight: NaN }, { labelFontSize: 16, labelLineHeight: 12 }, { labelLineHeight: 257 }]) expect(() => buildDiagram(cases.mask, options)).toThrow("Label metrics");
  const first = buildDiagram(cases.vertical, { labelFontSize: 16, labelLineHeight: 20 });
  assertSixRules(cases.vertical, first); expect(JSON.stringify(first)).toBe(JSON.stringify(buildDiagram(cases.vertical, { labelFontSize: 16, labelLineHeight: 20 })));
});
test("generated required-rule classes always produce nonvacuous geometry", () => {
  for (let seed = 0; seed < 12; seed++) for (const name of ["crossing", "fan", "transit", "vertical"] as const) {
    const input = structuredClone(cases[name]);
    for (const item of input.nodes) if ("at" in item) { item.at[0] += seed % 4 * 4; if (name !== "transit") item.at[1] += seed % 3 * 4; }
    const tree = buildDiagram(input); assertSixRules(input, tree);
    if (name === "crossing") expect(connectors(tree).some(route => route.bridges.length > 0), "GENERATED_TRUE_CROSSING").toBe(true);
    if (name === "fan") expect(connectors(tree).filter(route => route.from.node === "raft")).toHaveLength(2);
    if (name === "transit") expect(connectors(tree)[0]!.transit, "GENERATED_TRUE_UNAVOIDABLE_TRANSIT").toEqual(["athena"]);
    if (name === "vertical") expect(tree.elements.some(item => item.kind === "label-mask"), "GENERATED_TRUE_VERTICAL_LABEL").toBe(true);
  }
});
