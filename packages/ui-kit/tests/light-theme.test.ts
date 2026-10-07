/**
 * The light theme is generated, and this pins the generated output to its
 * generator so that neither `theme.css` nor `LIGHT_TOKENS` can drift from the
 * rules and overrides in `tools/theme/derive-light.ts`.
 *
 * Why a generator at all: the design gives the paper palette, every accent's
 * ink/fill pair and roughly fifty rendered tints and borders, and says nothing
 * about the other two hundred and sixty alpha tokens. Those follow one rule
 * each — written down once, there — and a hand edit to a light value that is
 * not also a rule or an override is exactly the kind of quiet fork this test
 * exists to catch. A designer's answer lands in `SPECIFIED`; this test then
 * fails until the files are regenerated, which is the workflow.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { LIGHT_TOKENS, TOKENS } from "../src/tokens.js";
import { lightTokens, lightTs, rewriteTheme } from "../tools/theme/derive-light.js";
import { DECLARED, PACKAGE_ROOT, theme } from "./_theme.js";

describe("light theme", () => {
  const generated = lightTokens();

  test("LIGHT_TOKENS is what the generator produces", () => {
    expect(LIGHT_TOKENS).toEqual(generated as typeof LIGHT_TOKENS);
    const source = readFileSync(join(PACKAGE_ROOT, "src", "tokens.ts"), "utf8");
    expect(source).toContain(lightTs(generated));
  });

  test("theme.css is what the generator produces", () => {
    // Idempotent: rewriting the current file changes nothing.
    expect(rewriteTheme(theme, generated)).toBe(theme);
  });

  test("every token has a light half, and no light token is unknown", () => {
    expect(Object.keys(LIGHT_TOKENS).sort()).toEqual(Object.keys(TOKENS).sort());
    for (const name of Object.keys(TOKENS)) {
      expect(DECLARED.get(`--bk-${name}`)?.light).toBe(LIGHT_TOKENS[name as keyof typeof TOKENS]);
    }
  });

  test("the design's own values are the design's, verbatim", () => {
    // `Brain Kit Light.dc.html` §L5. If one of these moves, the design moved
    // and the override table has to say so — a rule must not produce them.
    expect(LIGHT_TOKENS["color-canvas"]).toBe("#ece7dc");
    expect(LIGHT_TOKENS["color-ink-mute"]).toBe("#5f584c");
    expect(LIGHT_TOKENS["amber-ink"]).toBe("#7f4c08");
    expect(LIGHT_TOKENS["amber-fill"]).toBe("#e09f3e");
    expect(LIGHT_TOKENS["amber-mark"]).toBe("#b06d10");
    expect(LIGHT_TOKENS["neutral-mark"]).toBe("#847c6f");
    expect(LIGHT_TOKENS["gold-ink"]).toBe("#6f540c");
    expect(LIGHT_TOKENS["teal-ink"]).toBe("#15594c");
    expect(LIGHT_TOKENS["purple-ink"]).toBe("#5d4489");
    expect(LIGHT_TOKENS["blue-ink"]).toBe("#1a5c7f");
    expect(LIGHT_TOKENS["red-ink"]).toBe("#9c2a24");
    expect(LIGHT_TOKENS["on-fill"]).toBe("#231f1a");
    // The ring IS ink, in both themes: it says where you are, not what a
    // thing means, and it must read on paper as a dark ring.
    expect(LIGHT_TOKENS["focus-ring"]).toBe("var(--bk-color-ink)");
  });

  test("a fill is a fill: solid accents keep their dark value on paper", () => {
    // Fill-as-text is illegible and ink-as-fill turns the primary button to
    // mud, so the fills exist to carry `on-fill` and do not darken.
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red"]) {
      expect(LIGHT_TOKENS[`${tone}-fill` as keyof typeof TOKENS]).toBe(TOKENS[`${tone}-fill` as keyof typeof TOKENS]);
    }
  });

  test("tints keep the fill hue and borders keep the ink hue", () => {
    // "Tints use the fill hue at 8-14%, never the ink hue, which reads as
    // dirt." A tint whose rgb is a darkened ink would be that mistake.
    const fills: Record<string, string> = {
      amber: "224,159,62", gold: "234,179,84", teal: "91,181,162",
      purple: "177,151,212", blue: "103,184,227", red: "248,113,113",
    };
    const inks: Record<string, string> = {
      amber: "127,76,8", gold: "111,84,12", teal: "21,89,76",
      purple: "93,68,137", blue: "26,92,127", red: "156,42,36",
    };
    let checked = 0;
    for (const [name, value] of Object.entries(LIGHT_TOKENS)) {
      const m = /^(chip|surface|callout|action|toast|quote|avatar|medallion)-(tint|border)-(amber|gold|teal|purple|blue|red)$/.exec(name);
      if (!m) continue;
      checked++;
      const [, , kind, tone] = m;
      expect(`${name}: ${value}`).toContain(kind === "tint" ? fills[tone!]! : inks[tone!]!);
    }
    expect(checked, "tint and border hues were measured").toBeGreaterThan(0);
  });

  test("the hover veils invert to ink at the same alpha", () => {
    for (const name of ["hover-veil-soft", "hover-veil", "hover-veil-firm", "hover-veil-strong"] as const) {
      const alpha = /,([\d.]+)\)$/.exec(TOKENS[name])![1];
      expect(LIGHT_TOKENS[name]).toBe(`rgba(35,31,26,${alpha})`);
    }
  });

  test("no light value is a dark-theme literal left behind", () => {
    // The near-blacks and the dark ink: a light theme has no business with
    // any of them except as `on-fill`, which the design names.
    const darkOnly = ["#0c0e12", "#141619", "#1a1d22", "#1f2229", "#2a2d35", "#e8e4df", "#c0bcb5", "#8a8691", "#9a96a1"];
    // ...and the first light drop's inks, superseded the same day (§19), and
    // the second drop's teal, red and amber dot, superseded by the fourth
    // (§20: stacked tints; every dot now stated). The second drop's purple
    // dot, #6b4f9e, is not listed: the seventh drop states it again as the
    // paper canvas slot 4 (§L6), a categorical mark judged at 3:1.
    darkOnly.push("#6e6659", "#94580a", "#795c0d", "#1f6d96", "#b8362f", "#1a6b5b", "#a52e28", "#c07d12");
    for (const [name, value] of Object.entries(LIGHT_TOKENS)) {
      for (const hex of darkOnly) expect(`${name}: ${value}`).not.toContain(hex);
    }
  });
});
