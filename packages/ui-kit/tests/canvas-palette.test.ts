/**
 * The two canvas sets, measured (seventh drop, §L6).
 *
 * The graph canvas and the diagram theme are the two places the app hands a
 * colour to something that does not draw with CSS, so these tokens are read
 * as values rather than referenced — which means nothing downstream can
 * re-derive them. The design's ruling: node and edge colours are marks, judged
 * at the 3:1 non-text bar against the canvas — "but they ARE judged, which the
 * dark set never was on paper". This is where they are judged, so that a
 * respelled slot fails here before it fails on someone's screen.
 */

import { describe, expect, test } from "bun:test";

import { LIGHT_TOKENS, TOKENS, canvas } from "../src/tokens.js";
import { contrast, parse, type Rgb } from "./_contrast.js";

const T = TOKENS as Record<string, string>;
const L = LIGHT_TOKENS as Record<string, string>;
const dark = (name: string): Rgb => parse(T[name]!).rgb;
const paper = (name: string): Rgb => parse(L[name]!).rgb;

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `canvas-slot-${n}`);
const RAMP = [1, 2, 3, 4, 5].map((n) => `canvas-ramp-${n}`);
const ROLES = ["canvas-root", "canvas-other"];
const LENSES = ["canvas-lens-orphan", "canvas-lens-unreachable", "canvas-lens-broken", "canvas-lens-stale"];
/** The diagram's lines and text carry information; its three grounds are surfaces. */
const DIAGRAM_MARKS = ["diagram-line", "diagram-cluster-border", "diagram-text"];
const DIAGRAM_GROUNDS = ["diagram-bg", "diagram-node", "diagram-cluster"];

const MARKS = [...SLOTS, ...RAMP, ...ROLES, ...LENSES, ...DIAGRAM_MARKS];

describe("canvas palettes", () => {
  test("every paper mark clears 3:1 against the paper canvas", () => {
    const ground = paper("color-canvas");
    expect(L["color-canvas"]).toBe("#ece7dc");
    const failing = MARKS.filter((name) => contrast(paper(name), ground) < 3);
    expect(failing).toEqual([]);
  });

  test("the paper values are the design's, at the ratios it drew", () => {
    // §L6 states each value with its live ratio. The slots and roles
    // reproduce to the hundredth; the ramp lands within 0.05 of the design's
    // figures, whose calculator rounds the composite once more than this one.
    const ground = paper("color-canvas");
    const ratio = (name: string) => contrast(paper(name), ground);
    expect(SLOTS.map(ratio)).toEqual([3.74, 4.62, 3.94, 5.26, 4.81, 4.1, 5.08, 5.12]);
    const drawn = [10.64, 7.4, 5.49, 4.15, 3.21];
    RAMP.forEach((n, i) => expect(Math.abs(ratio(n) - drawn[i]!)).toBeLessThanOrEqual(0.05));
    expect(ratio("canvas-root")).toBe(4.95);
    expect(ratio("canvas-other")).toBe(4.36);
    expect(ratio("diagram-line")).toBe(5.7);
    expect(ratio("diagram-cluster-border")).toBe(3.34);
  });

  test("the dark marks clear 3:1 against the dark canvas, with the three recessive exceptions named", () => {
    const ground = dark("color-canvas");
    expect(T["color-canvas"]).toBe("#0c0e12");
    // These three were tuned to recede, not to be read: the ramp's far end is
    // the last hop fading out, `other` is the long tail past the legend, and
    // the cluster border is the card edge. Named here so a fourth cannot join
    // them unnoticed; changing them is a design question, not a derivation.
    const recessive = ["canvas-ramp-5", "canvas-other", "diagram-cluster-border"];
    const failing = MARKS.filter((name) => contrast(dark(name), ground) < 3);
    expect(failing).toEqual(recessive);
  });

  test("the diagram grounds are surfaces on paper, and its text is the ink", () => {
    // On paper the three grounds are the kit's own three surfaces. In the
    // dark the node fill is the app's former overlay step (#1e2128, one above
    // raised) rather than a kit surface — kept as it was, because the ruling
    // respelled the paper set and left the dark one alone.
    const surfaces = ["color-canvas", "color-surface", "color-raised"];
    for (const name of DIAGRAM_GROUNDS) expect(surfaces.map((s) => L[s])).toContain(L[name]);
    expect(surfaces.map((s) => T[s])).toContain(T["diagram-bg"]);
    expect(surfaces.map((s) => T[s])).toContain(T["diagram-cluster"]);
    expect(T["diagram-text"]).toBe(T["color-ink"]);
    expect(L["diagram-text"]).toBe(L["color-ink"]);
  });

  test("the slots are eight distinct values in each theme, in the same order", () => {
    // The order is the CVD mechanism. A respelling keeps every slot distinct;
    // a reordering would pass a per-theme distinctness check and still break
    // the comparison between a dark screenshot and a paper one, which is why
    // the design values are pinned above and the export keeps the index.
    expect(new Set(SLOTS.map((n) => T[n])).size).toBe(8);
    expect(new Set(SLOTS.map((n) => L[n])).size).toBe(8);
    expect(canvas.slots).toEqual(SLOTS.map((n) => `var(--bk-${n})`));
    expect(canvas.ramp).toEqual(RAMP.map((n) => `var(--bk-${n})`));
  });

  test("the ramp is monotone in luminance in both themes", () => {
    // Near to far, the dark ramp fades toward the canvas from light and the
    // paper ramp fades toward it from dark: each is one direction throughout,
    // which is what reads as a ramp rather than as five colours.
    const lum = (rgb: Rgb) => contrast(rgb, [0, 0, 0]);
    const darkSteps = RAMP.map((n) => lum(dark(n)));
    const paperSteps = RAMP.map((n) => lum(paper(n)));
    for (let i = 1; i < RAMP.length; i++) {
      expect(darkSteps[i]!).toBeLessThan(darkSteps[i - 1]!);
      expect(paperSteps[i]!).toBeGreaterThan(paperSteps[i - 1]!);
    }
  });
});
