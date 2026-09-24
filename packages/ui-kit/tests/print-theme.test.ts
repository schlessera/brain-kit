/**
 * The print theme (#46): what a shared PNG or PDF is drawn in.
 *
 * Two kinds of assertion. The committed table and stylesheet block must be
 * what `tools/theme/derive-print.ts` produces, so a hand edit has to arrive as
 * a rule or an override there. And the generator's output must obey the four
 * rules its header states. Those are checked here directly, because a rule
 * change regenerates both files and would pass the first kind on its own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { LIGHT_TOKENS, PRINT_TOKENS, TOKENS, printThemeCss } from "../src/tokens.js";
import { printCss, printTokens, printTs } from "../tools/theme/derive-print.js";
import { PACKAGE_ROOT, theme } from "./_theme.js";

const generated = printTokens();

describe("print theme", () => {
  test("PRINT_TOKENS and the stylesheet block are what the generator produces", () => {
    expect(PRINT_TOKENS).toEqual(generated as typeof PRINT_TOKENS);
    const source = readFileSync(join(PACKAGE_ROOT, "src", "tokens.ts"), "utf8");
    expect(source).toContain(printTs(generated));
    expect(theme).toContain(printCss(generated));
  });

  test("defines every token, and no token the kit does not have", () => {
    expect(Object.keys(PRINT_TOKENS).sort()).toEqual(Object.keys(TOKENS).sort());
  });

  test("rule 1: the page and every neutral ground are white", () => {
    for (const name of ["color-canvas", "color-surface", "color-raised", "inset-well-bg", "surface-tint-neutral"] as const) {
      expect({ name, value: PRINT_TOKENS[name] }).toEqual({ name, value: "#ffffff" });
    }
  });

  test("rule 2: no wash survives: every translucent tint, veil, hover, glow and shadow is transparent", () => {
    // A wash is a translucent fill on paper. An opaque token that only shares
    // the name (`hover-border`, a solid hex) is a line, not a wash.
    const washes = (Object.keys(PRINT_TOKENS) as (keyof typeof PRINT_TOKENS)[]).filter(
      (name) => /(tint|veil|hover|glow|shadow|halo|fade)/.test(name) && LIGHT_TOKENS[name].startsWith("rgba("),
    );
    const wrong = washes.filter((name) => PRINT_TOKENS[name] !== "transparent");
    expect(washes.length).toBeGreaterThan(80);
    expect(wrong).toEqual([]);
  });

  test("rule 3: every colour is opaque or transparent; nothing depends on what is under it", () => {
    const translucent = Object.entries(PRINT_TOKENS).filter(([, v]) => v.startsWith("rgba("));
    expect(translucent).toEqual([]);
  });

  test("rule 3: lines are darker than on the paper screen, so a printer keeps them", () => {
    const luminance = (hex: string) =>
      [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
    for (const name of ["color-line", "color-edge"] as const) {
      expect(luminance(PRINT_TOKENS[name])).toBeLessThan(luminance(LIGHT_TOKENS[name]));
    }
  });

  test("rule 4: ink is the light theme's ink", () => {
    for (const name of ["color-ink", "color-ink-dim", "color-ink-mute", "amber-ink", "teal-ink", "red-ink", "purple-ink", "blue-ink", "gold-ink"] as const) {
      expect({ name, value: PRINT_TOKENS[name] }).toEqual({ name, value: LIGHT_TOKENS[name] });
    }
  });

  test("printThemeCss sets every token on :root, in light colour-scheme", () => {
    const css = printThemeCss();
    expect(css.startsWith(":root{color-scheme:light;")).toBe(true);
    for (const [name, value] of Object.entries(PRINT_TOKENS)) expect(css).toContain(`--bk-${name}:${value};`);
  });
});
