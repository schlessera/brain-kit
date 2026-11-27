/**
 * The literal-config front end both config editors share (#4769), and each
 * editor's refusal of the same shapes through its own public function: the
 * module-flag editor (`planModuleFlag`) and the media-policy editor
 * (`planMediaPolicyEdit`, `readMediaPolicyLists`).
 */
import { describe, expect, test } from "bun:test";

import { literalProperties, parseConfigLiteral, type ConfigLiteralRefusal } from "../src/lib/config-literal";
import { MediaConfigNotLiteral, planMediaPolicyEdit, readMediaPolicyLists } from "../src/lib/media-config-edit";
import { planModuleFlag } from "../src/lib/module-config-edit";

const BODY = `{ "modules": { "jobs": { "enabled": true } } }`;

interface Row {
  name: string;
  source: string;
  format: "ts" | "json";
  /** The front end's refusal, or null when it accepts the row. */
  refusal: ConfigLiteralRefusal["reason"] | null;
}

/** One table of sources, in both formats where the shape exists in JSON. */
const ROWS: Row[] = [
  { name: "a plain literal", format: "ts", source: `export default ${BODY};\n`, refusal: null },
  { name: "a plain literal", format: "json", source: `${BODY}\n`, refusal: null },
  { name: "defineConfig({...})", format: "ts", source: `import { defineConfig } from "@schlessera/brain";\nexport default defineConfig(${BODY});\n`, refusal: null },
  { name: "a satisfies wrapper", format: "ts", source: `export default (${BODY}) satisfies object;\n`, refusal: null },
  { name: "an as wrapper", format: "ts", source: `export default ${BODY} as const;\n`, refusal: null },
  { name: "a non-null wrapper", format: "ts", source: `export default (${BODY})!;\n`, refusal: null },
  { name: "a parenthesised literal", format: "ts", source: `export default ((${BODY}));\n`, refusal: null },
  { name: "a spread", format: "ts", source: `const base = {};\nexport default { ...base, "modules": { "jobs": {} } };\n`, refusal: "not-assignment" },
  { name: "a computed key", format: "ts", source: `const k = "modules";\nexport default { [k]: { "jobs": {} } };\n`, refusal: "not-assignment" },
  { name: "a shorthand property", format: "ts", source: `const modules = { jobs: {} };\nexport default { modules };\n`, refusal: "not-assignment" },
  { name: "a method", format: "ts", source: `export default { "modules": { "jobs": {} }, media() { return {}; } };\n`, refusal: "not-assignment" },
  { name: "a duplicate key", format: "ts", source: `export default { "modules": { "jobs": {} }, "modules": { "jobs": {} } };\n`, refusal: "duplicate" },
  { name: "a duplicate key", format: "json", source: `{ "modules": { "jobs": {} }, "modules": { "jobs": {} } }`, refusal: "duplicate" },
  { name: "a non-literal default export", format: "ts", source: `const config = ${BODY};\nexport default config;\n`, refusal: "not-object" },
  { name: "a JSON array", format: "json", source: `[]`, refusal: "not-object" },
  { name: "export =", format: "ts", source: `export = ${BODY};\n`, refusal: "no-default-literal" },
  { name: "two default exports", format: "ts", source: `export default ${BODY};\nexport default ${BODY};\n`, refusal: "no-default-literal" },
  { name: "a call to another function", format: "ts", source: `export default build(${BODY});\n`, refusal: "not-define-config" },
  { name: "defineConfig with two arguments", format: "ts", source: `export default defineConfig(${BODY}, {});\n`, refusal: "not-define-config" },
  { name: "a syntax error", format: "ts", source: `export default { "modules": { ;\n`, refusal: "syntax" },
  { name: "invalid JSON", format: "json", source: `{ "modules": { `, refusal: "invalid-json" },
];

class Refused extends Error {
  constructor(readonly refusal: ConfigLiteralRefusal) { super(refusal.reason); }
}
const refuse = (refusal: ConfigLiteralRefusal): never => { throw new Refused(refusal); };

const label = (row: Row) => `${row.name} (${row.format})`;
const refused = ROWS.filter((row) => row.refusal !== null);
const acceptedRows = ROWS.filter((row) => row.refusal === null);

describe("the shared front end", () => {
  test("accepts or refuses every row of the table", () => {
    const outcomes = ROWS.map((row) => {
      try {
        const { root } = parseConfigLiteral(row.source, row.format, refuse);
        literalProperties(root, "the config", refuse);
        return { row: label(row), refusal: null };
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        return { row: label(row), refusal: error.refusal.reason };
      }
    });
    expect(outcomes).toEqual(ROWS.map((row) => ({ row: label(row), refusal: row.refusal })));
  });

  test("hands JSON's own parse error to the caller, and names the key a duplicate repeats", () => {
    const invalid = ROWS.find((row) => row.refusal === "invalid-json")!;
    let caught: unknown;
    try { parseConfigLiteral(invalid.source, "json", refuse); } catch (error) { caught = error; }
    expect((caught as Refused).refusal).toMatchObject({ reason: "invalid-json", error: expect.any(SyntaxError) });
    const duplicate = ROWS.find((row) => row.refusal === "duplicate")!;
    const { root } = parseConfigLiteral(duplicate.source, duplicate.format, refuse);
    expect(() => literalProperties(root, "the config", refuse)).toThrow(expect.objectContaining({ refusal: { reason: "duplicate", what: "the config", key: "modules" } }));
  });

  test("JSON is parsed behind an export default prefix that the caller slices off", () => {
    const parsed = parseConfigLiteral(BODY, "json", refuse);
    expect(parsed.prefix).toBe("export default ");
    expect(parsed.input).toBe(`export default ${BODY}`);
    expect(parseConfigLiteral(`export default ${BODY};\n`, "ts", refuse).prefix).toBe("");
  });
});

/** What an editor call did: its output, or the class and message it threw. */
function outcome(fn: () => unknown): { output: unknown } | { threw: string; message: string } {
  try { return { output: fn() }; } catch (error) { return { threw: (error as Error).constructor.name, message: (error as Error).message }; }
}

describe("the module-flag editor", () => {
  test("refuses every refused row with its own error and returns no edited source", () => {
    for (const row of refused) {
      const result = outcome(() => planModuleFlag(row.source, row.format, "jobs", false));
      // Invalid JSON stays JSON.parse's own SyntaxError, as before the shared front end (#4769).
      const expected = row.refusal === "invalid-json" ? "SyntaxError" : "Error";
      expect({ row: label(row), threw: "threw" in result ? result.threw : "no refusal" }).toEqual({ row: label(row), threw: expected });
      if (expected === "Error") expect({ row: label(row), message: (result as { message: string }).message }).toEqual({ row: label(row), message: expect.stringContaining("; no changes made.") });
    }
  });

  test("edits every accepted row", () => {
    for (const row of acceptedRows) {
      expect({ row: label(row), output: planModuleFlag(row.source, row.format, "jobs", false) }).toEqual({ row: label(row), output: expect.stringContaining('"enabled": false') });
    }
  });
});

describe("the media-policy editor", () => {
  test("refuses every refused row with MediaConfigNotLiteral and returns no edited source", () => {
    for (const row of refused) {
      for (const run of [() => planMediaPolicyEdit(row.source, row.format, { addTrack: "a/*.png" }), () => readMediaPolicyLists(row.source, row.format)]) {
        let caught: unknown;
        let output: unknown;
        try { output = run(); } catch (error) { caught = error; }
        expect({ row: label(row), output, refused: caught instanceof MediaConfigNotLiteral, code: (caught as { code?: string })?.code })
          .toEqual({ row: label(row), output: undefined, refused: true, code: "config-not-literal" });
      }
    }
  });

  test("edits every accepted row", () => {
    for (const row of acceptedRows) {
      expect({ row: label(row), lists: planMediaPolicyEdit(row.source, row.format, { addTrack: "a/*.png" }).lists }).toEqual({ row: label(row), lists: { track: ["a/*.png"], ignore: [] } });
    }
  });
});
