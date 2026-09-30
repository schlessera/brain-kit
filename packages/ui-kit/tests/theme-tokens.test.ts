/**
 * The token set is a design decision, so it gets a test rather than a comment.
 *
 * Two things this catches that review does not: a token quietly dropped when
 * the file is reorganised, and the spacing/radius scales being "tidied" onto a
 * 4px grid — the design's ranges are deliberate, and regularising them
 * redesigns the kit silently.
 *
 * `tests/tokens-match-theme.test.ts` is the companion: it pins every value here
 * against `src/tokens.ts`. This file asserts the SHAPE of the set — that the
 * design's own rules about it still hold. The values live in `tokens.css`; the
 * Tailwind scales (`@theme static`) live in `theme.css`, which imports it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { DECLARED, PACKAGE_ROOT, tailwindTheme, theme } from "./_theme.js";

const styles = readFileSync(join(PACKAGE_ROOT, "src", "styles.css"), "utf8");
const dark = (name: string) => DECLARED.get(`--bk-${name}`)?.dark;
const light = (name: string) => DECLARED.get(`--bk-${name}`)?.light;

describe("design tokens", () => {
  // The catalog's PALETTE is twelve rows, but two of them name a second
  // load-bearing colour inside the row: #2a2d35 (the card border, distinct
  // from the #1f2229 hairline inside a card) and #9a96a1 (machine meta).
  // Both were nearly lost by reading the palette as twelve values.
  // Third column: the design's paper palette (`Brain Kit Light.dc.html` §L5).
  // The accents' light value is their INK — the hue's identity on paper.
  const COLOURS: [string, string, string][] = [
    ["canvas", "#0c0e12", "#ece7dc"],
    ["surface", "#141619", "#f8f5ef"],
    ["raised", "#1a1d22", "#fffefa"],
    ["line", "#1f2229", "#ddd6c7"],
    ["edge", "#2a2d35", "#c8bfac"],
    ["ink", "#e8e4df", "#231f1a"],
    ["ink-dim", "#c0bcb5", "#554f45"],
    ["ink-mute", "#9a96a1", "#5f584c"],
    ["amber", "#e09f3e", "#7f4c08"],
    ["gold", "#eab354", "#6f540c"],
    ["teal", "#5bb5a2", "#15594c"],
    ["purple", "#b197d4", "#5d4489"],
    ["blue", "#67b8e3", "#1a5c7f"],
    ["red", "#f87171", "#9c2a24"],
  ];

  for (const [name, hex, paper] of COLOURS) {
    test(`--bk-color-${name} is ${hex}, and ${paper} on paper`, () => {
      expect(dark(`color-${name}`)).toBe(hex);
      expect(light(`color-${name}`)).toBe(paper);
    });
  }

  test("ink never comes from alpha", () => {
    // Hierarchy is weight and size. Alpha-muted ink drops 9-12px type under
    // 4.5:1, so the ink RAMP is the only source of ink and no entry in it may
    // carry an alpha channel. (`--bk-button-ink-on-solid` is deliberately not
    // in the ramp: it is near-black ON a filled accent, which is the one place
    // the design does tint a foreground.)
    const ramp = [...DECLARED.keys()].filter((n) => n.startsWith("--bk-color-ink"));
    expect(ramp.length).toBe(3);
    for (const name of ramp) {
      const { light, dark } = DECLARED.get(name)!;
      expect(`${name} -> ${dark}`).toMatch(/^[\w-]+ -> #[0-9a-f]{6}$/);
      // Same rule in both themes: "alpha ink is still banned".
      expect(`${name} -> ${light}`).toMatch(/^[\w-]+ -> #[0-9a-f]{6}$/);
    }
  });

  test("every accent carries a tint and a border on each surface, and nothing hand-rolls alpha", () => {
    // Tints are the accent at 4-10% alpha, borders at 30-50%. Each component
    // picks its own point in that band — chip 9-10%, callout 6-8%, surface
    // 5-6% — so the rule is encoded as three ramps rather than one, which is
    // what keeps it from being re-derived inside a component.
    for (const surface of ["chip", "surface", "callout"]) {
      for (const accent of ["amber", "gold", "teal", "purple", "blue", "red"]) {
        expect(dark(`${surface}-tint-${accent}`)).toMatch(/^rgba\([\d,]+,0\.(0[4-9]|1[0-4]?)\)$/);
        expect(dark(`${surface}-border-${accent}`)).toMatch(/^rgba\([\d,]+,0\.(3[0-9]?|4[0-9]?|5)\)$/);
        // On paper the band moves up — tints at 8-16%, borders at 35-60% —
        // because the same alpha that lifts a panel off black vanishes on
        // cream. The design's own words: "tints go up, not down".
        expect(light(`${surface}-tint-${accent}`)).toMatch(/^rgba\([\d,]+,0\.(0[8-9]|1[0-6])\)$/);
        expect(light(`${surface}-border-${accent}`)).toMatch(/^rgba\([\d,]+,0\.(3[5-9]|4[0-9]?|5[0-9]?|6)\)$/);
      }
    }
  });

  test("each accent carries all three roles", () => {
    // ink for text and borders, fill for solid surfaces, mark for 6-8px marks.
    // One value in the dark theme, three on paper — the names are what make the
    // light theme a token file instead of 58 component edits.
    for (const accent of ["amber", "gold", "teal", "purple", "blue", "red", "neutral"]) {
      for (const role of ["ink", "fill", "mark"]) {
        expect(DECLARED.has(`--bk-${accent}-${role}`)).toBe(true);
      }
      // One colour in the dark — and three different ones on paper, which is
      // the whole reason the names exist.
      const roles = ["ink", "fill", "mark"].map((r) => light(`${accent}-${r}`));
      expect(new Set(roles).size).toBe(3);
    }
  });

  test("the radius scale keeps both ends of every range", () => {
    // 5 chip · 8 inset · 11-12 option · 13-14 card · 16-18 panel · 26 sheet ·
    // 42 device · 999 pill. Three of those are ranges and both ends ship.
    const expected: [string, string][] = [
      ["chip", "5px"],
      ["inset", "8px"],
      ["option-tight", "11px"],
      ["option", "12px"],
      ["card-tight", "13px"],
      ["card", "14px"],
      ["panel-tight", "16px"],
      ["panel", "18px"],
      ["sheet", "26px"],
      ["device", "42px"],
      ["pill", "999px"],
    ];
    for (const [name, value] of expected) {
      expect(tailwindTheme).toContain(`--radius-${name}: ${value};`);
    }
  });

  test("the spacing set is the design's irregular one, not a 4px grid", () => {
    const values = [...tailwindTheme.matchAll(/--spacing-(\d+): (\d+)px;/g)].map((m) => Number(m[2]));
    expect(values).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 26]);
    // The giveaway for a "tidied" scale: every step a multiple of four.
    expect(values.every((v) => v % 4 === 0)).toBe(false);
  });

  test("the three families each have one job", () => {
    expect(tailwindTheme).toContain('--font-display: "DM Serif Text", Georgia, serif;');
    expect(tailwindTheme).toContain('--font-body: "Plus Jakarta Sans", system-ui, sans-serif;');
    expect(tailwindTheme).toContain('--font-mono: "JetBrains Mono", ui-monospace, monospace;');
  });

  test("Tailwind's colour namespace mirrors the kit's rather than restating it", () => {
    // One source of truth, and a [data-theme] swap reaches Tailwind too. The
    // cost is that a var-valued theme colour generates no bg-*/text-* utility;
    // nothing in the kit uses one.
    for (const [name] of COLOURS) {
      expect(tailwindTheme).toContain(`--color-${name}: var(--bk-color-${name});`);
    }
  });

  test("breathe is declared once, plus exactly one reduced-motion override", () => {
    // The source redeclares it in thirteen separate component files and relies
    // on the DC runtime deduping them. In the kit it is one global rule, and a
    // second copy anywhere is the old mistake growing back.
    //
    // The ONE legitimate second copy is wave 1b's reduced-motion override.
    // Redefining the keyframe is how one rule reaches all six call sites: they
    // write `animation: breathe …` on their own INLINE style, which a
    // stylesheet cannot override without `!important`. Two copies of a keyframe
    // name resolve by SOURCE ORDER rather than by specificity, so the override
    // must come second or it does nothing — asserted below, because getting it
    // backwards produces a stylesheet that parses, loads and silently ignores
    // the user's preference.
    //
    // Comments are stripped first, or the note above explaining the rule would
    // count as a declaration of it.
    const css = `${theme}\n${tailwindTheme}\n${styles}`.replace(/\/\*[\s\S]*?\*\//g, "");
    const declarations = [...css.matchAll(/@keyframes\s+breathe\b/g)];
    expect(declarations.length).toBe(2);

    const reduced = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toBeGreaterThan(-1);
    expect(declarations[0]!.index).toBeLessThan(reduced);
    expect(declarations[1]!.index).toBeGreaterThan(reduced);

    // Exactly one reduced-motion block, for the same reason there is one
    // keyframe: a second one is where the two answers start disagreeing.
    expect([...css.matchAll(/@media \(prefers-reduced-motion/g)]).toHaveLength(1);
  });

  test("the reduced-motion keyframe settles at the REST state, not the trough", () => {
    // A dot that reduced motion left at `opacity: .6` reads as disabled, which
    // is exactly the meaning-lost failure the rule exists to prevent. The
    // override therefore has one stop and it is the 0%/100% end of the
    // animation, so the pulse resolves to a full-opacity static dot.
    const block = theme.slice(theme.indexOf("@media (prefers-reduced-motion: reduce)"));
    // Scope this to the keyframe, not every later selector (sr-only uses 50%).
    const match = block.match(/@keyframes breathe\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
    expect(match).not.toBeNull();
    const frame = match![1]!;
    expect(frame).toContain("opacity: 1;");
    expect(frame).not.toContain("opacity: 0.6");
    expect(frame).not.toContain("50%");
  });

  test("interaction states are implemented once each, and gated on a class", () => {
    // "Each state has exactly one implementation — that is the only reason four
    // states across thirty components stay consistent." Every rule is scoped to
    // a class the component adds only when it was given a handler, so a static
    // row never pretends to be clickable.
    expect(theme).toContain(".bk-control:hover");
    expect(theme).toContain(".bk-control:active");
    expect(theme).toContain(".bk-control:focus-visible");
    expect(theme).toContain(".bk-switch::before");
    // :focus-visible, never :focus — a pointer tap must not leave a ring.
    // Comments are stripped, or the line above explaining the rule trips it.
    const rules = theme.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/:focus(?!-visible)/);
  });

  test("the Tailwind theme entry imports the tokens, and the tokens carry no @theme", () => {
    // A consumer with its own Tailwind scale imports `tokens.css` and must
    // get no `@theme` from it: the kit's `--spacing-2: 2px` would otherwise
    // redefine that consumer's `p-2`. Found while wiring ui-react (S5).
    expect(tailwindTheme).toContain('@import "./tokens.css";');
    expect(tailwindTheme).toContain("@theme static {");
    const bare = theme.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bare).not.toContain("@theme");
    expect(bare).not.toContain("@import");
  });

  test("the Tailwind entry pins its own scan root", () => {
    // `source(none)` plus an explicit @source is what stops Tailwind scanning
    // the whole monorepo — and what makes the compiled output identical no
    // matter which directory the CLI runs from.
    expect(styles).toContain('@import "tailwindcss" source(none);');
    expect(styles).toContain('@source "./";');
  });
});
