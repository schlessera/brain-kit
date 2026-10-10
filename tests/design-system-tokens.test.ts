/**
 * The Design System producer's token reader (scripts/design-system/tokens.ts).
 *
 * The artifact's theme switch only drives the real components if every token
 * keeps its `--bk-*` name and carries all three themes, so these assert both
 * against the kit's real stylesheet as well as on small inputs.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { buildTokensJson, parseTokensCss, toArtifactColor } from "../scripts/design-system/tokens";

const css = `:root {
  /* ── Base palette ───── */
  --bk-color-canvas: light-dark(#ECE7DC, #0c0e12);
  --bk-amber-fill: #e09f3e;
  --bk-chip-tint-amber: light-dark(rgba(224, 159, 62, 0.16), rgba(224,159,62,0.1));
  --bk-choice-mark-bg: light-dark(var(--bk-color-canvas), var(--bk-amber-fill));
  --bk-unsupported: color-mix(in srgb, red, blue);
}
[data-theme="print"] {
  --bk-color-canvas: #ffffff;
  --bk-chip-tint-amber: transparent;
}
.bk-control:hover { --bk-not-a-token: #123456; }
`;

describe("parseTokensCss", () => {
  const { tokens, skipped } = parseTokensCss(css);
  const byName = Object.fromEntries(tokens.map((t) => [t.name, t]));

  test("splits light-dark into Paper and Dark, and takes Print from its own block", () => {
    expect(byName["bk-color-canvas"].value).toEqual({ dark: "#0c0e12", light: "#ece7dc", print: "#ffffff" });
  });

  test("a single value serves every theme, and Print falls back to Paper", () => {
    expect(byName["bk-amber-fill"].value).toEqual({ dark: "#e09f3e", light: "#e09f3e", print: "#e09f3e" });
  });

  test("rgba loses its spaces, transparent becomes zero-alpha black, var() becomes an alias", () => {
    expect(byName["bk-chip-tint-amber"].value).toEqual({ light: "rgba(224,159,62,0.16)", dark: "rgba(224,159,62,0.1)", print: "#00000000" });
    expect(byName["bk-choice-mark-bg"].value).toEqual({ light: "{bk-color-canvas}", dark: "{bk-amber-fill}", print: "{bk-color-canvas}" });
  });

  test("the layer fence stays outside colour tokens and the reader resumes afterward", () => {
    const { tokens, skipped } = parseTokensCss(`:root {
  --bk-amber-fill: #e09f3e;
}
/* @layers:start */
:root {
  --bk-z-panel: 40;
  --bk-z-proof: #123456;
}
/* @layers:end */
:root {
  --bk-layer-neighbor: #112233;
  --bk-unknown-number: 70;
}`);
    expect(tokens.find(token => token.name === "bk-layer-neighbor")?.value.dark,
      "reader resumes after the layer fence").toBe("#112233");
    expect(tokens.map(token => token.name), "layer fence stays outside colour tokens")
      .toEqual(["bk-amber-fill", "bk-layer-neighbor"]);
    expect(skipped, "numbers outside the fence are still refused").toEqual(["bk-unknown-number: 70"]);
  });

  test("records the section heading, skips what the grammar refuses, ignores rule-level declarations", () => {
    expect(byName["bk-color-canvas"].section).toBe("Base palette");
    expect(skipped).toEqual(["bk-unsupported: color-mix(in srgb, red, blue)"]);
    expect(byName["bk-not-a-token"]).toBeUndefined();
  });
});

describe("the kit's real tokens.css", async () => {
  const real = await Bun.file(resolve(import.meta.dir, "../packages/ui-kit/src/tokens.css")).text();
  const { tokens, skipped } = parseTokensCss(real);
  const json = buildTokensJson(tokens, "test@0000000", "2026-07-12");

  test("every :root token parses, within the artifact's 600-colour cap", () => {
    expect(skipped).toEqual([]);
    expect(tokens.length).toBeGreaterThan(300);
    expect(tokens.length).toBeLessThanOrEqual(600);
    expect(new Set(tokens.map((t) => t.name)).size).toBe(tokens.length);
  });

  test("the canvas carries all three themes, Print included", () => {
    const canvas = json.color.tokens.find((t) => t.name === "bk-color-canvas")!;
    expect(canvas.value).toEqual({ dark: "#0c0e12", light: "#ece7dc", print: "#ffffff" });
  });

  test("every alias names a token that exists, and every token has a usage note", () => {
    const names = new Set(tokens.map((t) => t.name));
    const aliases = tokens.flatMap((t) => Object.values(t.value)).filter((v) => v.startsWith("{"));
    expect(aliases.length).toBeGreaterThan(0);
    for (const a of aliases) expect(names.has(a.slice(1, -1))).toBe(true);
    for (const t of json.color.tokens) expect(t.usage.length).toBeGreaterThan(10);
  });
});

test("toArtifactColor refuses what the artifact grammar drops", () => {
  expect(toArtifactColor("currentColor")).toBeUndefined();
  expect(toArtifactColor("var(--other-prefix)")).toBeUndefined();
  expect(toArtifactColor("#ABC")).toBe("#abc");
});
