/**
 * The schema attribution's counting rules, asserted (#155).
 *
 * `scripts/attribute-show-block-schema.ts` produces the figures a decision
 * record quotes about what `show_block`'s schema spends, and a counting hole
 * there is a confident wrong number. Each rule below is one that would
 * silently move a column: prose that is not all the prose, a repeat counted
 * twice because it sits inside another repeat, a repeat counted that a
 * reference could not make shorter, and a sharing estimate that forgets the
 * references it adds.
 */

import { describe, expect, test } from "bun:test";

import {
  attribute,
  listBridgeTools,
  outermost,
  REF_FORM,
  repeatedShapes,
  sharingBound,
  stripProse,
  variantsOf,
} from "../scripts/attribute-show-block-schema.ts";

/** An enum long enough that sharing it would pay. */
const SHARED = { type: "string", enum: ["amber", "gold", "teal", "purple", "blue", "red", "neutral"] };

function variant(kind: string, properties: Record<string, unknown>) {
  return {
    type: "object",
    properties: { kind: { type: "string", const: kind }, ...properties },
    required: ["kind"],
  };
}

describe("prose", () => {
  test("is every description, key and quotes included, and nothing else", () => {
    const [row] = attribute([
      variant("a", { label: { type: "string", description: "xy" } }),
    ]).rows;
    expect(row!.prose).toBe(',"description":"xy"'.length);
  });

  test("the three parts sum to the variant, and each is non-empty here", () => {
    const variants = [
      variant("a", { tone: { ...SHARED, description: "A colour." }, own: { type: "number", minimum: 0 } }),
      variant("b", { tone: { ...SHARED, description: "A colour." } }),
    ];
    const { rows } = attribute(variants);
    for (const row of rows) {
      expect(row.prose).toBeGreaterThan(0);
      expect(row.repeated).toBeGreaterThan(0);
      expect(row.irreducible).toBeGreaterThan(0);
      expect(row.prose + row.repeated + row.irreducible).toBe(row.chars);
    }
  });

  test("stripProse leaves a property literally named description", () => {
    const tree = { properties: { description: { type: "string" } } };
    expect(stripProse(tree)).toEqual(tree);
  });
});

describe("repeated structure", () => {
  test("counts a subtree that appears in two variants and is longer than a reference", () => {
    const shapes = repeatedShapes([variant("a", { tone: SHARED }), variant("b", { tone: SHARED })]);
    expect(shapes.get(JSON.stringify(SHARED))).toBe(2);
  });

  test("does not count a repeat a reference could not make shorter", () => {
    const short = { type: "string" };
    expect(JSON.stringify(short).length).toBeLessThanOrEqual(REF_FORM.length);
    const shapes = repeatedShapes([variant("a", { x: short }), variant("b", { x: short })]);
    expect(shapes.has(JSON.stringify(short))).toBe(false);
  });

  test("counts a repeat inside a repeat once, as the outer one", () => {
    const row = { type: "object", properties: { tone: SHARED, v: { type: "string" } } };
    const a = variant("a", { rows: { type: "array", items: row } });
    const b = variant("b", { rows: { type: "array", items: row } });
    const shapes = repeatedShapes([a, b]);
    // Both the row and the enum inside it repeat...
    expect(shapes.has(JSON.stringify(SHARED))).toBe(true);
    // ...but only the outermost is counted against the variant.
    const counted = outermost(a, shapes);
    expect(counted).toHaveLength(1);
    expect(counted[0]!.length).toBeGreaterThan(JSON.stringify(SHARED).length);
  });
});

describe("the sharing estimate", () => {
  const LONG = { ...SHARED, description: "One of the kit's accents; omit for the default, and never for severity." };
  const schemaWith = (sites: number, tone: object = LONG) => ({
    type: "object",
    properties: {
      block: { oneOf: Array.from({ length: sites }, (_, i) => variant(`k${i}`, { tone })) },
    },
  });

  test("is every copy but one, less a reference at each site and the table key", () => {
    const size = JSON.stringify(LONG).length;
    const expected = 2 * size - 3 * REF_FORM.length - '"xxxxx":,'.length;
    expect(expected).toBeGreaterThan(0);
    expect(sharingBound(schemaWith(3))).toBe(expected);
  });

  test("is zero, not negative, when the references would cost more than the copies", () => {
    // Two copies of the bare enum: sharing it would add more than it removes.
    const size = JSON.stringify(SHARED).length;
    expect(size - 2 * REF_FORM.length - '"xxxxx":,'.length).toBeLessThan(0);
    expect(sharingBound(schemaWith(2, SHARED))).toBe(0);
  });
});

describe("the shipped schema", () => {
  test("show_block's union is found, and every variant carries prose", async () => {
    const tools = await listBridgeTools();
    const tool = tools.find((entry) => entry.name === "show_block");
    expect(tool).toBeDefined();
    const variants = variantsOf(tool!.inputSchema);
    expect(variants.length).toBeGreaterThan(0);
    const { rows } = attribute(variants);
    expect(rows.map((row) => row.kind)).not.toContain("?");
    for (const row of rows) expect(row.prose).toBeGreaterThan(0);
  });
});
