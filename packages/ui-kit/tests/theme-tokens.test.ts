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
 * design's own rules about it still hold.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const theme = readFileSync(join(PACKAGE_ROOT, "src", "theme.css"), "utf8");
const styles = readFileSync(join(PACKAGE_ROOT, "src", "styles.css"), "utf8");

describe("design tokens", () => {
  // The catalog's PALETTE is twelve rows, but two of them name a second
  // load-bearing colour inside the row: #2a2d35 (the card border, distinct
  // from the #1f2229 hairline inside a card) and #8a8691 (machine meta).
  // Both were nearly lost by reading the palette as twelve values.
  const COLOURS: [string, string][] = [
    ["canvas", "#0c0e12"],
    ["surface", "#141619"],
    ["raised", "#1a1d22"],
    ["line", "#1f2229"],
    ["edge", "#2a2d35"],
    ["ink", "#e8e4df"],
    ["ink-dim", "#c0bcb5"],
    ["ink-mute", "#8a8691"],
    ["amber", "#e09f3e"],
    ["gold", "#eab354"],
    ["teal", "#5bb5a2"],
    ["purple", "#b197d4"],
    ["blue", "#67b8e3"],
    ["red", "#f87171"],
  ];

  for (const [name, hex] of COLOURS) {
    test(`--bk-color-${name} is ${hex}`, () => {
      expect(theme).toContain(`--bk-color-${name}: ${hex};`);
    });
  }

  test("ink never comes from alpha", () => {
    // Hierarchy is weight and size. Alpha-muted ink drops 9-12px type under
    // 4.5:1, so the ink RAMP is the only source of ink and no entry in it may
    // carry an alpha channel. (`--bk-button-ink-on-solid` is deliberately not
    // in the ramp: it is near-black ON a filled accent, which is the one place
    // the design does tint a foreground.)
    const ramp = [...theme.matchAll(/--bk-(color-ink[\w-]*): ([^;]+);/g)];
    expect(ramp.length).toBe(3);
    for (const [, name, value] of ramp) {
      expect(`${name} -> ${value}`).toMatch(/^[\w-]+ -> #[0-9a-f]{6}$/);
    }
  });

  test("every accent carries a tint and a border on each surface, and nothing hand-rolls alpha", () => {
    // Tints are the accent at 4-10% alpha, borders at 30-50%. Each component
    // picks its own point in that band — chip 9-10%, callout 6-8%, surface
    // 5-6% — so the rule is encoded as three ramps rather than one, which is
    // what keeps it from being re-derived inside a component.
    for (const surface of ["chip", "surface", "callout"]) {
      for (const accent of ["amber", "gold", "teal", "purple", "blue", "red"]) {
        expect(theme).toMatch(
          new RegExp(`--bk-${surface}-tint-${accent}: rgba\\([\\d,]+,0\\.(0[4-9]|1[0-4]?)\\);`),
        );
        expect(theme).toMatch(
          new RegExp(`--bk-${surface}-border-${accent}: rgba\\([\\d,]+,0\\.(3[0-9]?|4[0-9]?|5)\\);`),
        );
      }
    }
  });

  test("each accent carries all three roles", () => {
    // ink for text and borders, fill for solid surfaces, mark for 6-8px marks.
    // One value in the dark theme, three on paper — the names are what make the
    // light theme a token file instead of 58 component edits.
    for (const accent of ["amber", "gold", "teal", "purple", "blue", "red", "neutral"]) {
      for (const role of ["ink", "fill", "mark"]) {
        expect(theme).toMatch(new RegExp(`--bk-${accent}-${role}: `));
      }
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
      expect(theme).toContain(`--radius-${name}: ${value};`);
    }
  });

  test("the spacing set is the design's irregular one, not a 4px grid", () => {
    const values = [...theme.matchAll(/--spacing-(\d+): (\d+)px;/g)].map((m) => Number(m[2]));
    expect(values).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 26]);
    // The giveaway for a "tidied" scale: every step a multiple of four.
    expect(values.every((v) => v % 4 === 0)).toBe(false);
  });

  test("the three families each have one job", () => {
    expect(theme).toContain('--font-display: "DM Serif Text", Georgia, serif;');
    expect(theme).toContain('--font-body: "Plus Jakarta Sans", system-ui, sans-serif;');
    expect(theme).toContain('--font-mono: "JetBrains Mono", ui-monospace, monospace;');
  });

  test("Tailwind's colour namespace mirrors the kit's rather than restating it", () => {
    // One source of truth, and a [data-theme] swap reaches Tailwind too. The
    // cost is that a var-valued theme colour generates no bg-*/text-* utility;
    // nothing in the kit uses one.
    for (const [name] of COLOURS) {
      expect(theme).toContain(`--color-${name}: var(--bk-color-${name});`);
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
    const css = `${theme}\n${styles}`.replace(/\/\*[\s\S]*?\*\//g, "");
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
    const frame = block.slice(block.indexOf("@keyframes breathe"));
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

  test("the Tailwind entry pins its own scan root", () => {
    // `source(none)` plus an explicit @source is what stops Tailwind scanning
    // the whole monorepo — and what makes the compiled output identical no
    // matter which directory the CLI runs from.
    expect(styles).toContain('@import "tailwindcss" source(none);');
    expect(styles).toContain('@source "./";');
  });
});
