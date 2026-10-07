import { describe, expect, test } from "bun:test";
import { sizeSvgForExport } from "../src/lib/mermaid.js";
import { LIGHT_TOKENS, TOKENS } from "@schlessera/brain-ui-kit/internal";
import { mermaidThemeVariables } from "../src/lib/mermaid-theme.js";

describe("sizeSvgForExport", () => {
  test("pins width/height from the viewBox and drops the responsive style", () => {
    const svg =
      '<svg id="d" width="100%" style="max-width: 400px;" viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"><g/></svg>';
    const out = sizeSvgForExport(svg);
    expect(out).toContain('width="400"');
    expect(out).toContain('height="300"');
    expect(out).not.toContain("max-width");
    expect(out).toContain('viewBox="0 0 400 300"');
    expect(out).toContain("<g/></svg>");
  });

  test("preserves aspect ratio when clamped to maxWidth", () => {
    const svg = '<svg viewBox="0 0 2000 1000"></svg>';
    const out = sizeSvgForExport(svg, 1200);
    expect(out).toContain('width="1200"');
    expect(out).toContain('height="600"');
  });

  test("leaves markup untouched when the viewBox is missing or degenerate", () => {
    const noViewBox = '<svg width="100%"><g/></svg>';
    expect(sizeSvgForExport(noViewBox)).toBe(noViewBox);
    const zero = '<svg viewBox="0 0 0 0"></svg>';
    expect(sizeSvgForExport(zero)).toBe(zero);
    expect(sizeSvgForExport("not an svg")).toBe("not an svg");
  });

  test("only rewrites the opening tag, not nested elements", () => {
    const svg =
      '<svg viewBox="0 0 100 50"><rect width="10" height="10" style="fill:red"/></svg>';
    const out = sizeSvgForExport(svg);
    expect(out).toContain('<rect width="10" height="10" style="fill:red"/>');
  });
});

describe("mermaidThemeVariables", () => {
  test("both themes carry the kit's diagram surfaces and the slot series scale", () => {
    // No document here, so every value resolves from the kit's own tables.
    const dark = mermaidThemeVariables("dark");
    const light = mermaidThemeVariables("light");
    expect(dark.background).toBe(TOKENS["diagram-bg"]);
    expect(light.background).toBe(LIGHT_TOKENS["diagram-bg"]);
    expect(dark.textColor).toBe(TOKENS["color-ink"]);
    expect(light.textColor).toBe(LIGHT_TOKENS["color-ink"]);
    expect(light.lineColor).toBe(LIGHT_TOKENS["diagram-line"]);
    expect(dark.darkMode).toBe(true);
    expect(light.darkMode).toBe(false);
    // A series keeps its SLOT between a dark diagram and its paper export;
    // the slot is respelled per theme, never reordered.
    expect(dark.pie1).toBe(TOKENS["canvas-slot-1"]);
    expect(light.pie1).toBe(LIGHT_TOKENS["canvas-slot-1"]);
    expect(dark.cScale0).toBe(TOKENS["canvas-slot-1"]);
    expect(light.cScale2).toBe(LIGHT_TOKENS["canvas-slot-3"]);
    expect(dark.git7).toBeDefined();
    expect(dark.fillType7).toBeDefined();
  });

  test("no value is an unresolved light-dark() expression", () => {
    for (const theme of ["dark", "light"] as const) {
      const values = Object.values(mermaidThemeVariables(theme));
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        if (typeof value === "string") expect(value).not.toContain("light-dark(");
      }
    }
  });

  test("every value is a plain string or boolean", () => {
    for (const theme of ["dark", "light"] as const) {
      const entries = Object.entries(mermaidThemeVariables(theme));
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        expect(typeof value === "string" || typeof value === "boolean").toBe(true);
        expect(key).not.toContain(" ");
      }
    }
  });

  test("the two themes define exactly the same variables", () => {
    // A variable present in one theme and missing in the other would inherit
    // mermaid's own default for that surface — a stock-mermaid color leaking
    // into a share export is exactly the bug this palette exists to prevent.
    const dark = Object.keys(mermaidThemeVariables("dark")).sort();
    const light = Object.keys(mermaidThemeVariables("light")).sort();
    expect(dark.length).toBeGreaterThan(0);
    expect(light.length).toBeGreaterThan(0);
    expect(dark).toEqual(light);
  });
});
