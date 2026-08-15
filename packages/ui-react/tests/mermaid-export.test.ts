import { describe, expect, test } from "bun:test";
import { sizeSvgForExport } from "../src/lib/mermaid.js";
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
  test("both themes carry the app surfaces and the shared series scale", () => {
    const dark = mermaidThemeVariables("dark");
    const light = mermaidThemeVariables("light");
    expect(dark.background).toBe("#141619");
    expect(light.background).toBe("#ffffff");
    expect(dark.darkMode).toBe(true);
    expect(light.darkMode).toBe(false);
    // Series colors are shared so a dark diagram and its shared PNG keep the
    // same identity per series.
    expect(dark.pie1).toBe("#3987e5");
    expect(light.pie1).toBe("#3987e5");
    expect(dark.cScale0).toBe("#3987e5");
    expect(dark.git7).toBeDefined();
    expect(dark.fillType7).toBeDefined();
  });

  test("every value is a plain string or boolean", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const [key, value] of Object.entries(mermaidThemeVariables(theme))) {
        expect(typeof value === "string" || typeof value === "boolean").toBe(true);
        expect(key).not.toContain(" ");
      }
    }
  });

  test("the two themes define exactly the same variables", () => {
    // A variable present in one theme and missing in the other would inherit
    // mermaid's own default for that surface — a stock-mermaid color leaking
    // into a share export is exactly the bug this palette exists to prevent.
    expect(Object.keys(mermaidThemeVariables("dark")).sort()).toEqual(
      Object.keys(mermaidThemeVariables("light")).sort()
    );
  });
});
