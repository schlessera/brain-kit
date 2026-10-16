import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDiagram, diagramSource } from "../src/check.js";
import { AXIS_TYPES, DIAGRAM_SIZES, FIXED_LAYOUT_TYPES, FREE_LAYOUT_TYPES, diagramSpecJsonSchema } from "../src/spec.js";
import { parse } from "yaml";
const fixture = (name: string) => readFileSync(resolve(import.meta.dir, "fixtures", name + ".diagram.yaml"), "utf8");
const check = (value: unknown) => checkDiagram(JSON.stringify(value));
const base = () => parse(fixture("free-valid"));

test("valid and invalid family fixtures have pinned result envelopes", () => {
  const expected = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/check-results.json"), "utf8"));
  for (const name of ["free-valid", "free-invalid", "axis-valid", "axis-invalid", "fixed-valid", "fixed-invalid"]) expect(checkDiagram(fixture(name)), name).toEqual(expected[name]);
});
for (const [family, types, source] of [["free", FREE_LAYOUT_TYPES, "free-valid"], ["axis", AXIS_TYPES, "axis-valid"], ["fixed", FIXED_LAYOUT_TYPES, "fixed-valid"]] as const) {
  for (const type of types) test(`v1 common ${family} grammar validates ${type}`, () => {
    const spec = parse(fixture(source)); spec.type = type;
    const checked=check(spec);expect({...checked,warnings:[]}).toEqual({ schema_version: 1, valid: true, type, errors: [], warnings: [] });
    expect(checked.warnings.every(item=>item.code==="budget")).toBe(true);
  });
}
test("the structural JSON schema is regenerated from the actual strict zod union", () => {
  expect(JSON.parse(readFileSync(resolve(import.meta.dir, "../../..", "docs/integration-contract/diagram-spec-v1.schema.json"), "utf8"))).toEqual(diagramSpecJsonSchema);
});
test("unknown nested keys name the exact field and newer formats require an upgrade", () => {
  const spec = base(); spec.nodes[0].style = { color: "amber" };
  expect(check(spec).errors).toEqual([{ path: "$.nodes[0].style", code: "unknown_field", message: "Unknown field" }]);
  delete spec.nodes[0].style; spec.nodes[0]["odd.field"] = "amber";
  expect(check(spec).errors[0]?.path).toBe('$.nodes[0]["odd.field"]');
  spec.schema_version = 2;
  expect(check(spec).errors).toEqual([{ path: "$.schema_version", code: "upgrade_required", message: "Diagram schema_version 2 is newer than supported version 1; upgrade the diagrams module" }]);
});
test("free boxes require a 4px grid and may touch but cannot overlap", () => {
  const spec = base(); spec.edges = []; spec.nodes[1].at = [188, 120];
  expect(check(spec).valid).toBe(true);
  spec.nodes[1].at = [184, 120];
  expect(check(spec).errors).toContainEqual({ path: "$.nodes[1].at", code: "overlap", message: "Node 'ithaca' overlaps 'raft'" });
  spec.nodes[1].at = [189, 120];
  expect(check(spec).errors).toContainEqual({ path: "$.nodes[1].at[0]", code: "grid", message: "Structural geometry must align to the 4px grid" });
  spec.nodes[1].size = [149, 64];
  expect(check(spec).errors.some(item => item.path === "$.nodes[1].size[0]" && item.code === "grid")).toBe(true);
});
test("universal budgets warn without refusing and focal roles cannot bypass the two-element limit", () => {
  const spec = base(); spec.type = "timeline"; spec.nodes = Array.from({ length: 10 }, (_, i) => ({ id: `raft-${i}`, label: "Odysseus's raft" }));
  spec.groups = []; spec.focal = [];
  spec.edges = Array.from({ length: 13 }, () => ({ from: "raft-0", to: "raft-1", label: "WORD FOR PENELOPE" }));
  spec.callouts = Array.from({ length: 3 }, () => ({ target: "raft-0", text: "Prepare provisions." }));
  const output = check(spec);
  expect(output.valid).toBe(true);
  for (const path of ["$.nodes", "$.edges", "$.callouts", "$.edges[0].label"]) expect(output.warnings.some(item => item.path === path && item.code === "budget"), path).toBe(true);
  spec.nodes[0].role = "focal"; spec.nodes[1].role = "focal"; spec.focal = ["raft-2"];
  expect(check(spec).errors.some(item => item.code === "focal_count")).toBe(true);
  spec.focal = ["raft-0", "raft-1", "raft-2"];
  expect(check(spec).errors.some(item => item.path === "$.focal")).toBe(true);
});
test("pinned common per-type budgets warn on the first excess item", () => {
  for (const [type, limit] of [["sequence", 5], ["swimlane", 5], ["er", 8], ["layer-stack", 6], ["pyramid", 6], ["venn", 3]] as const) {
    const spec = { schema_version: 1, type, title: "Homecoming preparations", desc: "Odysseus prepares the homecoming.", size: "doc-inline", nodes: Array.from({ length: limit + 1 }, (_, i) => ({ id: `raft-${i}`, label: "The raft", ...(type === "er" ? { at: [i * 200, 0], size: [148, 64] } : {}) })), edges: [] };
    expect(check(spec).warnings.some(item => item.message.includes(`${limit} default budget`)), type).toBe(true);
  }
});
test("references and identifiers are checked before geometry is consumed", () => {
  const spec = base(); spec.nodes[1].id = "raft"; spec.edges[0].to = "absent";
  expect(check(spec).errors.some(item => item.code === "duplicate_id")).toBe(true);
  expect(check(spec).errors.some(item => item.path === "$.edges[0].to" && item.code === "unknown_reference")).toBe(true);
});
test("fences respect Markdown fence nesting and reject ambiguous or incomplete input", () => {
  const source = fixture("free-valid");
  expect(checkDiagram(`# Homecoming\n\n\`\`\`diagram\n${source}\`\`\`\n`).valid).toBe(true);
  expect(checkDiagram(`~~~diagram\n${source}~~~\n`).valid).toBe(true);
  expect(checkDiagram(`\`\`\`diagram\n${source}`).errors[0]?.code).toBe("parse");
  expect(checkDiagram(`\`\`\`diagram\n${source}\`\`\`\n\`\`\`diagram\n${source}\`\`\``).errors[0]?.message).toContain("exactly one");
  const fencedExample = `\`\`\`\`markdown\n\`\`\`diagram\n${source}\`\`\`\n\`\`\`\`\n`;
  expect(diagramSource(fencedExample)).toBe(fencedExample);
});
test("YAML is data-only and malformed, duplicate, tagged, alias and oversized documents fail", () => {
  for (const source of ["schema_version: [", "schema_version: 1\nschema_version: 2", "value: !unknown data", "x: &x [*x]", "schema_version: 1\n---\nschema_version: 1", "x".repeat(1024 * 1024 + 1)]) expect(checkDiagram(source).errors[0]?.code, source.slice(0, 40)).toBe("parse");
  for (const size of DIAGRAM_SIZES) { const spec = base(); spec.size = size; expect(check(spec).valid, size).toBe(true); }
});


test("tree depth follows edges and counts the root as the first level", () => {
  const spec = base(); spec.type = "tree"; spec.groups = []; spec.focal = [];
  spec.nodes = Array.from({ length: 5 }, (_, i) => ({ id: `raft-${i}`, label: "The raft", at: [i * 200, 0], size: [148, 64] }));
  spec.edges = Array.from({ length: 4 }, (_, i) => ({ from: `raft-${i}`, to: `raft-${i + 1}` }));
  expect(check(spec).warnings.some(item => item.message.includes("4 default budget"))).toBe(true);
  spec.edges.push({ from: "raft-4", to: "raft-0" });
  expect(check(spec).errors.some(item => item.code === "tree_cycle")).toBe(true);
});

test("a standalone description can show a diagram fence as literal data", () => {
  const spec = fixture("free-valid").replace("desc: Odysseus sends word from the raft to Ithaca.", "desc: |\n  Odysseus sends this example:\n  ```diagram\n  schema_version: 2\n  ```");
  expect(checkDiagram(spec).valid).toBe(true);
});
