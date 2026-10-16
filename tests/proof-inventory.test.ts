import { expect, test } from "bun:test";
import { assertInventory, browserDomain, proofInventory, sourceAssertions } from "../scripts/proof-inventory";

const specs = [
  { project: "ui-react-layout", file: "packages/ui-react/tests/browser/recordings.offline.tsx" },
  { project: "ui-react-endurance", file: "packages/ui-react/tests/browser/recordings.endurance.tsx" },
];
test("default ownership rejects omission, duplication and endurance in an ordinary project", () => {
  const leaves = specs.map(spec => spec.file);
  expect(() => assertInventory(specs, leaves)).not.toThrow();
  expect(() => assertInventory(specs.slice(0, 1), leaves)).toThrow("Undiscovered browser scenario");
  expect(() => assertInventory([...specs, specs[0]!], leaves)).toThrow("Duplicate proof scenario ownership");
  expect(() => assertInventory([{ ...specs[1]!, project: "ui-react-layout" }], [leaves[1]!])).toThrow("Wrong endurance ownership");
  expect(browserDomain(specs[1]!)).toBe("endurance");
  const newSpec = { project: "ui-react-endurance", file: "packages/ui-react/tests/browser/new.endurance.tsx" };
  expect(() => assertInventory([...specs, newSpec], [...leaves, newSpec.file])).not.toThrow();
});
test("assertion inventory reports actual source declarations and nested matcher locations", () => {
  const inventory = sourceAssertions('test("saved audio", () => {\n expect(blob.size).toBeGreaterThan(0);\n expect(decoded.duration).toBe(600);\n});', "recording.endurance.tsx");
  expect(inventory.scenarios).toEqual([{ line: 1, declaration: '\"saved audio\"' }]);
  expect(inventory.assertions).toEqual([2, 3]);
});


test("installed Vitest and Bun discovery assign every actual product execution and retain recording assertions", async () => {
  const inventory = await proofInventory(new URL("..", import.meta.url).pathname);
  const endurance = inventory.rows.filter(row => row.domain === "endurance");
  const recording = endurance.find(row => row.file.endsWith("recordings.endurance.tsx"));
  expect(recording).toBeDefined();
  expect(recording!.scenarios.some(scenario => scenario.declaration.includes("ten-minute native endurance"))).toBe(true);
  expect(recording!.assertions.length).toBeGreaterThanOrEqual(7);
  expect(inventory.rows.some(row => row.domain === "layout" && row.file.endsWith("recording-limits.offline.tsx"))).toBe(true);
  expect(inventory.rows.filter(row => row.file.endsWith("recordings.endurance.tsx"))).toHaveLength(1);
});
