/**
 * The print theme, derived once from the light theme and written down.
 *
 * A shared PNG or PDF is paper, not a screen: it is read on white, printed by
 * office printers, and often printed in grayscale. The light theme is designed
 * for a warm paper SCREEN — tinted grounds, translucent washes, a shadow for
 * elevation — and each of those either wastes toner, vanishes, or turns to
 * muddy grey on a printer. So print is its own palette (#46), with four rules:
 *
 *   1. The ground is white. Canvas, surface, raised and the neutral grounds
 *      all become `#ffffff`; elevation is carried by borders, not by fills.
 *   2. No washes. Every translucent tint, veil, hover, glow, halo, fade and
 *      shadow becomes `transparent`, so nothing depends on a background
 *      printing.
 *   3. Borders carry the structure. The two line colours step darker, and
 *      every translucent stroke is flattened onto white at +0.2 alpha, so a
 *      hairline survives a printer and reads in grayscale.
 *   4. Ink is the light theme's ink. Those values already clear 4.5:1 on
 *      paper, so on white they clear it with room. Tone is not luminance:
 *      printed in grayscale, the tone inks come out as near-equal greys, and
 *      a block that carries meaning in colour alone (a trend delta's good or
 *      bad tone, a table cell's judgment, a timeline dot's state) loses that
 *      meaning on a grayscale printer. That is the kit's to fix, with a
 *      non-colour cue in the component, not the palette's: tracked in #309.
 *
 * Data marks — bars, pins, hatches, lane gradients — keep their light colour,
 * flattened onto white so they print opaque and identical. The recommended
 * column is stronger than that, so its tint still reads in grayscale.
 *
 * Run it after changing a light token, a rule, or an override:
 *
 *   bun packages/ui-kit/tools/theme/derive-print.ts
 *
 * It rewrites the `@print-tokens` block in `src/tokens.ts` and the
 * `@print-theme` block in `src/tokens.css`. `tests/print-theme.test.ts` fails
 * if either drifts from what this produces.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LIGHT_TOKENS } from "../../src/tokens.ts";

type Rgb = [number, number, number];

const WHITE = "#ffffff";

/** Grounds that become the page: rule 1. */
const GROUNDS = new Set([
  "color-canvas",
  "color-surface",
  "color-raised",
  "surface-tint-neutral",
  "callout-tint-neutral",
  "toast-tint-neutral",
  "inset-well-bg",
  "graph-canvas-bg",
  "rail-bg",
  "diagram-bg",
  "diagram-node",
]);

/** Washes that disappear: rule 2. Matched on the token name. */
const WASH = /(tint|veil|hover|glow|shadow|halo|fade|effect-bg)/;

/** Named like a wash, but data: a lane chart's gradient ends. */
const DATA_MARK = /^lane-fade-/;

/** Strokes that carry structure: rule 3. Matched on the token name. */
const STROKE = /(border|rail|ring|line|stroke|edge|graticule|scale)/;

/** Values set by hand, each with its reason. Applied before the rules. */
const OVERRIDES: Record<string, string> = {
  // Rule 3: the two line colours, one step darker than on the paper screen.
  // #ddd6c7 on white is a line a printer drops; these hold at 1px.
  "color-line": "#cbc3b2",
  "color-edge": "#a89e89",
  // Text set on an ink-solid ground is the page colour.
  "on-ink-solid": WHITE,
  // Ghost text is a loading state, never printed (#1116): `.bk-ghost` is also
  // hidden under print, and these make a stray one paint nothing.
  "ghost-base": "transparent",
  "ghost-amber": "transparent",
  "ghost-purple": "transparent",
  "ghost-blue": "transparent",
  // The recommended column in a comparison is data, not a wash, so it keeps
  // a fill, strong enough to stay visible in grayscale (the header about
  // 1.33:1 against white, the cells about 1.16:1).
  "compare-recommended-head": "#f3dcb6",
  "compare-recommended-cell": "#f9ecd6",
};

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** An rgba() colour composited onto white, as the opaque colour it prints as. */
function onWhite(value: string, extraAlpha = 0): string {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`not an rgba() colour: ${value}`);
  const a = Math.min(1, Number(m[4]) + extraAlpha);
  const rgb = [m[1], m[2], m[3]].map(Number) as Rgb;
  return toHex(rgb.map((c) => c * a + 255 * (1 - a)) as Rgb);
}

function derive(name: string, light: string): string {
  if (name in OVERRIDES) return OVERRIDES[name]!;
  // A reference stays a reference: what it points at is themed here too.
  if (light.startsWith("var(")) return light;
  if (GROUNDS.has(name)) return WHITE;
  if (light.startsWith("#")) return light;
  if (WASH.test(name) && !DATA_MARK.test(name)) return "transparent";
  if (STROKE.test(name)) return onWhite(light, 0.2);
  return onWhite(light);
}

export const PRINT_START = "/* @print-theme:start */";
export const PRINT_END = "/* @print-theme:end */";

const PRINT_SELECTOR = '[data-theme="print"]';

/**
 * `tokens.css` with the print block cut out, and a way to put it back. The
 * light generator and the token tests read every `--bk-*` declaration as the
 * `:root` pair; the print block re-declares the same names with plain values
 * and must not be read as, or rewritten into, that pair.
 *
 * Strict, because a quiet failure here corrupts the print theme: exactly one
 * start and one end marker, in order, and the print selector only between
 * them. A stylesheet with no print theme at all has neither.
 */
export function splitPrintBlock(css: string): { outside: string; restore: (outside: string) => string } {
  const count = (needle: string) => css.split(needle).length - 1;
  if (count(PRINT_START) === 0 && count(PRINT_END) === 0 && !css.includes(PRINT_SELECTOR)) {
    return { outside: css, restore: (outside) => outside };
  }
  if (count(PRINT_START) !== 1 || count(PRINT_END) !== 1) {
    throw new Error("tokens.css must have exactly one @print-theme:start and one @print-theme:end marker");
  }
  const a = css.indexOf(PRINT_START);
  const b = css.indexOf(PRINT_END) + PRINT_END.length;
  if (b < a) throw new Error("tokens.css has its @print-theme markers out of order");
  const before = css.slice(0, a);
  const block = css.slice(a, b);
  const after = css.slice(b);
  if (before.includes(PRINT_SELECTOR) || after.includes(PRINT_SELECTOR)) {
    throw new Error(`tokens.css has a ${PRINT_SELECTOR} rule outside the @print-theme markers`);
  }
  // Put back by position: the rewrite only touches declarations, so the text
  // before the block keeps its length only if nothing there changed. Split
  // the rewritten text at the same boundary marker instead of a placeholder
  // that could collide with content.
  const boundary = "\u0000print\u0000";
  return {
    outside: before + boundary + after,
    restore: (outside) => {
      const parts = outside.split(boundary);
      if (parts.length !== 2) throw new Error("the print block's place was lost while rewriting tokens.css");
      return parts[0] + block + parts[1];
    },
  };
}

export function printTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, light] of Object.entries(LIGHT_TOKENS)) out[name] = derive(name, light);
  return out;
}

export function printTs(tokens = printTokens()): string {
  const lines = Object.entries(tokens).map(([name, value]) => `  "${name}": "${value}",`);
  return `export const PRINT_TOKENS: Record<TokenName, string> = {\n${lines.join("\n")}\n};`;
}

/** The `[data-theme="print"]` block: every token re-pointed, as plain values. */
export function printCss(tokens = printTokens()): string {
  const lines = Object.entries(tokens).map(([name, value]) => `  --bk-${name}: ${value};`);
  return `[data-theme="print"] {\n  color-scheme: light;\n${lines.join("\n")}\n}`;
}

function splice(file: string, start: string, end: string, body: string): void {
  const text = readFileSync(file, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error(`markers missing in ${file}`);
  writeFileSync(file, `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..", "..");
  const tokens = printTokens();
  splice(join(root, "src", "tokens.ts"), "// @print-tokens:start", "// @print-tokens:end", printTs(tokens));
  splice(join(root, "src", "tokens.css"), PRINT_START, PRINT_END, printCss(tokens));
  const counts = { white: 0, transparent: 0, reference: 0, other: 0 };
  for (const v of Object.values(tokens)) {
    if (v === WHITE) counts.white++;
    else if (v === "transparent") counts.transparent++;
    else if (v.startsWith("var(")) counts.reference++;
    else counts.other++;
  }
  console.log(`${Object.keys(tokens).length} print tokens:`, counts);
}
