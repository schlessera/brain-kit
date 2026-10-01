import { describe, expect, test } from "bun:test";
import { parseCatalogue } from "../scripts/captures/catalogue.ts";

const source = await Bun.file(new URL("../docs/process/feature-captures.md", import.meta.url)).text();

describe("canonical editorial capture source", () => {
  test("a missing marker cannot select an unrelated JSON fence", () => {
    const unmarked = source.replace("<!-- feature-capture-data:start -->", "");
    expect(() => parseCatalogue(unmarked)).toThrow("exactly one marked capture-data block");
  });

  test("duplicated canonical blocks fail rather than selecting the first", () => {
    expect(() => parseCatalogue(source + source)).toThrow("exactly one marked capture-data block");
  });

  test("an unknown source kind cannot become an empty successful capture", () => {
    const changed = source.replace('"kind": "storybook-composition"', '"kind": "unknown-renderer"');
    expect(changed).not.toBe(source);
    expect(() => parseCatalogue(changed)).toThrow("source.kind");
  });

  test("the still set has actual sources and nonempty readiness", () => {
    const catalogue = parseCatalogue(source) as {
      recipes: Array<{ id: string; readiness: { required_visible_text: string[] } }>;
    };
    expect(catalogue.recipes.length).toBe(9);
    expect(catalogue.recipes.every((entry) => entry.id && entry.readiness.required_visible_text.length > 0)).toBe(true);
  });
});
