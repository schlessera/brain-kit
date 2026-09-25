/**
 * The schema attribution's counting rules, asserted (#155, D47).
 *
 * `scripts/attribute-show-block-schema.ts` produces the figures D47 quotes
 * about what `show_block`'s schema spends, and a counting hole there is a
 * confident wrong number. So the columns are asserted as values worked out by
 * hand on fixtures that exercise the hard cases — descriptions inside arrays,
 * a repeat nested in another repeat, an array that repeats but is not a
 * schema — rather than as a sum the code makes true by construction.
 */

import { describe, expect, test } from "bun:test";

import {
  attribute,
  calibrate,
  CALIBRATION,
  childSchemas,
  dereference,
  fitLine,
  type Json,
  type JsonObject,
  listBridgeTools,
  outermost,
  REF_FORM,
  repeatedShapes,
  shareDefinitions,
  sharingSaving,
  stripProse,
  variantsOf,
} from "../scripts/attribute-show-block-schema.ts";

/** An enum long enough that sharing it would pay at enough sites. */
const SHARED = { type: "string", enum: ["amber", "gold", "teal", "purple", "blue", "red", "neutral"] };

function variant(kind: string, properties: JsonObject): JsonObject {
  return {
    type: "object",
    properties: { kind: { type: "string", const: kind }, ...properties },
    required: ["kind"],
  };
}

function union(...variants: Json[]): JsonObject {
  return { type: "object", properties: { block: { oneOf: variants } }, required: ["block"] };
}

const len = (value: unknown) => JSON.stringify(value).length;

/** `shared` with one definition put back at every site that references it. */
function inlineOne(shared: JsonObject, id: string): JsonObject {
  const definitions = { ...(shared.definitions as JsonObject) };
  const body = JSON.stringify(definitions[id]);
  delete definitions[id];
  const ref = JSON.stringify({ allOf: [{ $ref: `#/definitions/${id}` }] });
  const rest = { ...shared, definitions } as JsonObject;
  if (Object.keys(definitions).length === 0) delete rest.definitions;
  return JSON.parse(JSON.stringify(rest).replaceAll(ref, body)) as JsonObject;
}

describe("prose", () => {
  test("is every description, key and quotes included, and nothing else", () => {
    const [row] = attribute([variant("a", { label: { type: "string", description: "xy" } })]).rows;
    expect(row!.prose).toBe(',"description":"xy"'.length);
  });

  test("counts descriptions inside anyOf members and array items", () => {
    const [row] = attribute([
      variant("a", {
        cells: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", description: "one" },
              { type: "object", properties: { v: { type: "string", description: "two" } } },
            ],
          },
          description: "three",
        },
      }),
    ]).rows;
    expect(row!.prose).toBe(
      ',"description":"one"'.length + ',"description":"two"'.length + ',"description":"three"'.length
    );
  });

  test("stripProse leaves a property literally named description", () => {
    const tree = { properties: { description: { type: "string" } } };
    expect(stripProse(tree)).toEqual(tree);
  });
});

describe("repeated structure", () => {
  const row = { type: "object", properties: { tone: SHARED, v: { type: "string" } } };
  const a = variant("a", { rows: { type: "array", items: row } });
  const b = variant("b", { rows: { type: "array", items: row } });
  const c = variant("c", { tone: SHARED, own: { type: "number" } });

  test("is the exact characters of the outermost repeat, per variant", () => {
    const { rows } = attribute([a, b, c]);
    // `a` and `b` each carry the whole `rows` property twice over the union:
    // the array schema around the row is itself the outermost repeat.
    const rowsProperty = { type: "array", items: row };
    expect(rows.map((r) => r.repeated)).toEqual([len(rowsProperty), len(rowsProperty), len(SHARED)]);
    expect(rows.map((r) => r.irreducible)).toEqual([
      len(a) - len(rowsProperty),
      len(b) - len(rowsProperty),
      len(c) - len(SHARED),
    ]);
  });

  test("selects the outer subschema, not the enum nested in it", () => {
    const shapes = repeatedShapes([a, b, c]);
    expect(shapes.get(JSON.stringify(SHARED))).toBe(3);
    expect(outermost(a, shapes)).toEqual([JSON.stringify({ type: "array", items: row })]);
    expect(outermost(c, shapes)).toEqual([JSON.stringify(SHARED)]);
  });

  test("does not count a repeat a reference could not make shorter", () => {
    const short = { type: "string" };
    expect(len(short)).toBeLessThanOrEqual(REF_FORM.length);
    const shapes = repeatedShapes([variant("a", { x: short }), variant("b", { x: short })]);
    expect(shapes.has(JSON.stringify(short))).toBe(false);
  });

  test("never offers an enum array or a properties map as a subschema", () => {
    const schema = { type: "object", properties: { t: SHARED }, required: ["t"] };
    expect(childSchemas(schema).map((child) => JSON.stringify(child))).toEqual([JSON.stringify(SHARED)]);
    expect(childSchemas(SHARED)).toEqual([]);
    // Four copies of the same enum array under four different descriptions:
    // the array repeats, but no `$ref` can stand where it stands.
    const shapes = repeatedShapes(
      ["a", "b", "c", "d"].map((kind) => variant(kind, { tone: { ...SHARED, description: `Only ${kind}.` } }))
    );
    expect(shapes.has(JSON.stringify(SHARED.enum))).toBe(false);
  });
});

describe("sharing through definitions", () => {
  const LONG = { ...SHARED, description: "One of the kit's accents; omit for the default, and never for severity." };

  test("takes out every copy but one, less the references and the table", () => {
    const schema = union(variant("a", { tone: LONG }), variant("b", { tone: LONG }), variant("c", { tone: LONG }));
    const ref = JSON.stringify({ allOf: [{ $ref: "#/definitions/s0" }] });
    const table = ',"definitions":{"s0":}'.length + len(LONG);
    const expected = 3 * len(LONG) - 3 * ref.length - table;
    expect(expected).toBeGreaterThan(0);
    expect(sharingSaving(schema)).toBe(expected);
  });

  test("gives back the original schema when dereferenced", () => {
    const schema = union(variant("a", { tone: LONG }), variant("b", { tone: LONG }), variant("c", { tone: LONG }));
    const shared = shareDefinitions(schema);
    expect(JSON.stringify(shared)).toContain("#/definitions/s0");
    expect(dereference(shared)).toEqual(schema);
  });

  test("leaves the schema alone when the references would cost more than the copies", () => {
    const schema = union(variant("a", { tone: SHARED }), variant("b", { tone: SHARED }));
    expect(shareDefinitions(schema)).toEqual(schema);
    expect(sharingSaving(schema)).toBe(0);
  });

  test("does not share when the table would cost more than the two copies save", () => {
    // Two 85-character schemas: a reference each plus the table outweigh one copy.
    const tone = { type: "string", description: "x".repeat(51) };
    expect(len(tone)).toBe(85);
    const schema = union(variant("a", { tone }), variant("b", { tone }));
    expect(shareDefinitions(schema)).toEqual(schema);
    expect(sharingSaving(schema)).toBe(0);
  });

  test("drops a nested definition that an outer one has left with too few sites", () => {
    const child = { type: "string", description: "y".repeat(46) };
    const parent = { type: "object", properties: { c: child, x: { type: "number" } } };
    const schema = union(variant("a", { p: parent }), variant("b", { p: parent }), variant("c", { c: child }));
    const shared = shareDefinitions(schema);
    expect(sharingSaving(schema)).toBeGreaterThan(0);
    expect(dereference(shared)).toEqual(schema);
    const definitions = (shared.definitions ?? {}) as JsonObject;
    expect(Object.keys(definitions).length).toBeGreaterThan(0);
    for (const id of Object.keys(definitions)) {
      expect(len(inlineOne(shared, id))).toBeGreaterThan(len(shared));
    }
  });

  test("does not share an enum array that repeats under different descriptions", () => {
    const schema = union(
      ...["a", "b", "c", "d"].map((kind) =>
        variant(kind, { tone: { ...SHARED, description: `The ${kind} colour, which only this variant has.` } })
      )
    );
    expect(sharingSaving(schema)).toBe(0);
    expect(JSON.stringify(shareDefinitions(schema))).not.toContain("$ref");
  });
});

describe("the calibration", () => {
  test("fitLine recovers an exact line", () => {
    const fit = fitLine([1, 2, 5, 9].map((chars) => ({ chars, tokens: 2 * chars + 3 })));
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(3, 10);
  });

  test("reproduces each of D44's counted rows to within 23 tokens", () => {
    const { rows } = calibrate();
    expect(rows).toHaveLength(CALIBRATION.length);
    for (const row of rows) expect(Math.abs(row.residual)).toBeLessThanOrEqual(23);
  });

  test("the range is the full fit and every leave-one-out refit, worked out independently", () => {
    // Closed-form slope, written separately from fitLine's centred sums.
    const slopeOf = (rows: readonly { description: number; schema: number; tokens: number }[]) => {
      const n = rows.length;
      const xs = rows.map((row) => row.description + row.schema);
      const ys = rows.map((row) => row.tokens);
      const sx = xs.reduce((a, b) => a + b, 0);
      const sy = ys.reduce((a, b) => a + b, 0);
      const sxy = xs.reduce((sum, x, i) => sum + x * ys[i]!, 0);
      const sxx = xs.reduce((sum, x) => sum + x * x, 0);
      return (n * sxy - sx * sy) / (n * sxx - sx * sx);
    };
    const folds = CALIBRATION.map((_, skip) => slopeOf(CALIBRATION.filter((__, i) => i !== skip)));
    const all = [slopeOf(CALIBRATION), ...folds];
    const { slope, low, high } = calibrate();
    expect(slope).toBeCloseTo(slopeOf(CALIBRATION), 12);
    expect(low).toBeCloseTo(Math.min(...all), 12);
    expect(high).toBeCloseTo(Math.max(...all), 12);
    // The endpoints D47 quotes: without show_block, and without query_activity.
    expect(low).toBeCloseTo(0.3899329744, 9);
    expect(high).toBeCloseTo(0.4170873939, 9);
  });
});

describe("the shipped schema", () => {
  test("show_block's union is found, every variant carries prose, and sharing round-trips", async () => {
    const tools = await listBridgeTools();
    const tool = tools.find((entry) => entry.name === "show_block");
    expect(tool).toBeDefined();
    const variants = variantsOf(tool!.inputSchema);
    expect(variants.length).toBeGreaterThan(0);
    const { rows } = attribute(variants);
    expect(rows.map((row) => row.kind)).not.toContain("?");
    for (const row of rows) expect(row.prose).toBeGreaterThan(0);
    expect(rows.some((row) => row.repeated > 0)).toBe(true);
    const shared = shareDefinitions(tool!.inputSchema);
    expect(JSON.stringify(shared)).toContain("#/definitions/");
    expect(dereference(shared)).toEqual(tool!.inputSchema);
    for (const id of Object.keys(shared.definitions as JsonObject)) {
      expect(len(inlineOne(shared, id))).toBeGreaterThan(len(shared));
    }
  });
});
