/**
 * `brain travel migrate` edits brain.config as source text with its own copy
 * of the literal-config checks (`packages/module-travel/src/migration.ts`): a
 * module package may not import core's internals, so it cannot use core's
 * front end (`packages/core/src/lib/config-literal.ts`, #4769). This test
 * holds the copy to core's front end, the reference (#4770): every source core
 * refuses, travel refuses without an edited source; every source core accepts
 * that carries the legacy `speaking.travelParty` field, travel migrates.
 */
import { describe, expect, test } from "bun:test";

import { literalProperties, parseConfigLiteral, type ConfigLiteralRefusal } from "../packages/core/src/lib/config-literal";
import { planTravelConfigMigration } from "../packages/module-travel/src/migration";

const SPEAKING = "@schlessera/brain-module-speaking";
const PARTY = `[{ "name": "Odysseus" }, { "name": "Penelope", "requirementsDoc": "people/penelope.md" }]`;
const LEGACY = `{ "modules": { "${SPEAKING}": { "travelParty": ${PARTY} } } }`;
const MODULES = `"modules": { "${SPEAKING}": { "travelParty": ${PARTY} } }`;

interface Row { name: string; format: "ts" | "json"; source: string }

/** Config shapes, each carrying the legacy field, in both formats where the shape exists in JSON. */
const ROWS: Row[] = [
  { name: "a plain literal", format: "ts", source: `export default ${LEGACY};\n` },
  { name: "a plain literal", format: "json", source: `${LEGACY}\n` },
  { name: "defineConfig({...})", format: "ts", source: `import { defineConfig } from "@schlessera/brain";\nexport default defineConfig(${LEGACY});\n` },
  { name: "a satisfies wrapper", format: "ts", source: `export default (${LEGACY}) satisfies object;\n` },
  { name: "an as wrapper", format: "ts", source: `export default ${LEGACY} as const;\n` },
  { name: "a non-null wrapper", format: "ts", source: `export default (${LEGACY})!;\n` },
  { name: "a parenthesised literal", format: "ts", source: `export default ((${LEGACY}));\n` },
  { name: "a spread", format: "ts", source: `const base = {};\nexport default { ...base, ${MODULES} };\n` },
  { name: "a computed key", format: "ts", source: `const k = "ignore";\nexport default { [k]: [], ${MODULES} };\n` },
  { name: "a shorthand property", format: "ts", source: `const ignore = [];\nexport default { ignore, ${MODULES} };\n` },
  { name: "a method", format: "ts", source: `export default { ${MODULES}, media() { return {}; } };\n` },
  { name: "a duplicate key", format: "ts", source: `export default { "ignore": [], ${MODULES}, "ignore": [] };\n` },
  { name: "a duplicate key", format: "json", source: `{ "ignore": [], ${MODULES}, "ignore": [] }` },
  { name: "a non-literal default export", format: "ts", source: `const config = ${LEGACY};\nexport default config;\n` },
  { name: "a JSON array", format: "json", source: `[${LEGACY}]` },
  { name: "export =", format: "ts", source: `export = ${LEGACY};\n` },
  { name: "two default exports", format: "ts", source: `export default ${LEGACY};\nexport default ${LEGACY};\n` },
  { name: "a call other than a direct defineConfig", format: "ts", source: `export default build(${LEGACY});\n` },
  { name: "defineConfig with two arguments", format: "ts", source: `export default defineConfig(${LEGACY}, {});\n` },
  { name: "a syntax error", format: "ts", source: `export default { ${MODULES}, ;\n` },
  { name: "invalid JSON", format: "json", source: `{ ${MODULES}, ` },
];

class Refused extends Error {
  constructor(readonly refusal: ConfigLiteralRefusal) { super(refusal.reason); }
}
const refuse = (refusal: ConfigLiteralRefusal): never => { throw new Refused(refusal); };

/** Core's verdict: the front end parses the file and reads the exported object's properties. */
function coreAccepts(row: Row): boolean {
  try {
    literalProperties(parseConfigLiteral(row.source, row.format, refuse).root, "the config", refuse);
    return true;
  } catch (error) {
    if (error instanceof Refused) return false;
    throw error;
  }
}

/** Travel's verdict: the migrated source, or the refusal it threw. */
function travel(row: Row): { migrated: string } | { refused: string } {
  try { return { migrated: planTravelConfigMigration(row.source, row.format).source }; }
  catch (error) { return { refused: (error as Error).message }; }
}

const label = (row: Row) => `${row.name} (${row.format})`;

describe("travel's literal-config checks agree with core's front end", () => {
  test("the table covers every refused shape and an accepted row in each format", () => {
    const refusedByCore = ROWS.filter((row) => !coreAccepts(row)).map(label);
    expect(refusedByCore).toEqual([
      "a spread (ts)", "a computed key (ts)", "a shorthand property (ts)", "a method (ts)", "a duplicate key (ts)", "a duplicate key (json)",
      "a non-literal default export (ts)", "a JSON array (json)", "export = (ts)", "two default exports (ts)",
      "a call other than a direct defineConfig (ts)", "defineConfig with two arguments (ts)", "a syntax error (ts)", "invalid JSON (json)",
    ]);
    expect(ROWS.filter(coreAccepts).map((row) => row.format)).toEqual(expect.arrayContaining(["ts", "json"]));
  });

  test("every source core refuses, travel refuses and returns no edited source", () => {
    const verdicts = ROWS.filter((row) => !coreAccepts(row)).map((row) => ({ row: label(row), refused: "refused" in travel(row) }));
    expect(verdicts).toEqual(verdicts.map(({ row }) => ({ row, refused: true })));
  });

  test("every source core accepts, travel migrates: the party moves to the travel module", () => {
    for (const row of ROWS.filter(coreAccepts)) {
      const result = travel(row);
      expect({ row: label(row), migrated: "migrated" in result && result.migrated !== row.source }).toEqual({ row: label(row), migrated: true });
      const migrated = (result as { migrated: string }).migrated;
      expect({ row: label(row), legacy: migrated.includes(`"${SPEAKING}": { "travelParty"`) }).toEqual({ row: label(row), legacy: false });
      expect({ row: label(row), moved: migrated.includes(`"@schlessera/brain-module-travel": { "travelParty": ${PARTY} }`) }).toEqual({ row: label(row), moved: true });
    }
  });
});
