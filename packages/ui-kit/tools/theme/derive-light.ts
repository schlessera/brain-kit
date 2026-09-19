/**
 * The light theme, derived once and written into every declaration.
 *
 * The design publishes the paper palette as a contract (`Brain Kit Light.dc.html`
 * §L5) plus two rebuilt screens and a semantics board (§L3/§L4) that draw a
 * subset of the kit's tints and borders in light values. That covers the base
 * palette, every accent's ink/fill/dot triple, and roughly fifty of the
 * ~320 tokens. The rest have no light value anywhere in the design.
 *
 * This script is where the rest come from, and it exists so that the choice is
 * written down ONCE as a rule rather than three hundred times as a number:
 *
 *   - `SPECIFIED` holds every value the design draws, verbatim, keyed by token.
 *   - Everything else keeps its HUE ROLE (an amber tint stays amber, a purple
 *     border stays purple) and swaps the dark hue for the light one — fill hue
 *     for tints and bars, ink hue for borders and strokes — with its alpha
 *     stepped by the amount the specified values step by: +0.07 on a tint
 *     (capped at 0.16), +0.05 on a border (capped at 0.6). The white hover
 *     veils invert to ink at the same alpha, as the dark file already says.
 *   - The dots are the design's: the fourth drop (2026-09-18, the answers to
 *     the open questions) states all seven, judged against the 3:1 non-text
 *     bar. The earlier blend that produced six of them from the one given is
 *     gone.
 *
 * Run it after changing a dark token, a rule, or an override:
 *
 *   bun packages/ui-kit/tools/theme/derive-light.ts
 *
 * It rewrites every `--bk-*` declaration in `src/tokens.css`'s `:root` block
 * to `light-dark(<light>, <dark>)`, with the dark half taken from `TOKENS`, and
 * the `@light-tokens` block in `src/tokens.ts`. `tests/light-theme.test.ts`
 * fails if either drifts from what this produces, so a hand edit to a light
 * value has to come through here — as an override, which is the point: it
 * keeps the line between "the design said" and "we chose" visible in one file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TOKENS } from "../../src/tokens.ts";

type Rgb = [number, number, number];

/* ── The design's light palette (§L5), keyed by role ───────────────────── */

const BASE: Record<string, string> = {
  "#0c0e12": "#ece7dc", // canvas
  "#141619": "#f8f5ef", // surface
  "#1a1d22": "#fffefa", // raised
  "#1f2229": "#ddd6c7", // line
  "#2a2d35": "#c8bfac", // edge
  "#e8e4df": "#231f1a", // ink
  "#c0bcb5": "#554f45", // ink dim
  "#9a96a1": "#5f584c", // ink meta — the floor: 5.0:1 on a tinted canvas, 5.3 on surface
};

const INK: Record<string, string> = {
  // Stated against the WORST real ground — a 12-16% accent tint over the
  // canvas — after a port measured 141 stories failing on paper from a palette
  // that was stated against the surface (design-feedback §19). Amber, blue,
  // red and ink-meta came down a notch; gold followed; then teal, purple and
  // red came down again for two stacked tints of one hue (§20) — "eight ink
  // moves in that sequence, every one found by measuring".
  amber: "#7f4c08",
  gold: "#6f540c",
  teal: "#15594c",
  purple: "#5d4489",
  blue: "#1a5c7f",
  red: "#9c2a24",
  neutral: "#5f584c",
};

/** The fills are the dark accents, unchanged: they exist to carry `on-fill`. */
const FILL: Record<string, string> = {
  amber: "#e09f3e",
  gold: "#eab354",
  teal: "#5bb5a2",
  purple: "#b197d4",
  blue: "#67b8e3",
  red: "#f87171",
  // The design has no neutral fill — nothing solid is grey. A solid neutral
  // chip still needs a ground that takes near-black text; this is the edge
  // colour one step darker, derived.
  neutral: "#a59d8f",
};

/** The dots — "small marks need a third step: at 6–8px a darkened accent
 * reads black". All seven are the design's (§L5), judged against the 3:1
 * non-text bar on the canvas rather than 4.5. */
const DOT: Record<string, string> = {
  amber: "#b06d10",
  gold: "#9b7610",
  teal: "#227f6c",
  purple: "#7a5fb0",
  blue: "#22719b",
  red: "#bd3b33",
  neutral: "#847c6f",
};

/* ── Hue roles, so an rgba() keeps meaning the same thing ─────────────── */

/** Dark rgb triple → the role it plays, so the light hue can be looked up. */
const HUES: Record<string, string> = {
  "224,159,62": "amber",
  "234,179,84": "gold",
  "91,181,162": "teal",
  "177,151,212": "purple",
  "103,184,227": "blue",
  "248,113,113": "red",
  "154,150,161": "neutral",
  "192,188,181": "dim",
  "42,45,53": "edge",
  "31,34,41": "line",
  "12,14,18": "canvas",
  "232,228,223": "ink",
  "255,255,255": "veil",
  "26,29,34": "raised",
  "20,22,25": "surface",
  "0,0,0": "shadow",
};

/** Light rgb per role, for the alpha tokens. Accents resolve per role below. */
const LIGHT_RGB: Record<string, Rgb> = {
  dim: hex("#554f45"),
  edge: hex("#c8bfac"),
  line: hex("#ddd6c7"),
  canvas: hex("#ece7dc"),
  surface: hex("#f8f5ef"),
  raised: hex("#fffefa"),
  ink: hex("#231f1a"),
  veil: hex("#231f1a"), // "on paper the veil inverts to black"
  shadow: hex("#5a4e3a"), // the light catalog's own device shadow hue
};

/** Tokens that are a FILL of the accent (a ground, a bar, a glow) rather than
 * a stroke. Everything not matched here is treated as ink-hue. */
const FILL_ROLE = /(tint|-bar-|hatch|fade|glow|pin-ring|accuracy-fill|voice|mark-bg|-bg-)/;

/** Tokens whose canvas-hue alpha is a light GROUND on paper, by name. */
const CANVAS_HUE_AS: Record<string, string> = {
  "inset-well-bg": "canvas",
  "map-label-bg": "surface",
  "map-coord-bg": "surface",
  "map-halo": "surface",
  "palette-foot-bg": "canvas",
};

/* ── What the design draws in light, verbatim (§L3, §L4, §L5) ──────────── */

const SPECIFIED: Record<string, string> = {
  // §L5 contract (2026-09-18, revised the same day for §19)
  "color-canvas": "#ece7dc",
  "color-surface": "#f8f5ef",
  "color-raised": "#fffefa",
  "color-line": "#ddd6c7",
  "color-edge": "#c8bfac",
  "color-ink": "#231f1a",
  "color-ink-dim": "#554f45",
  "color-ink-mute": "#5f584c",
  "on-fill": "#231f1a",
  "amber-mark": "#b06d10",
  "gold-mark": "#9b7610",
  "teal-mark": "#227f6c",
  "purple-mark": "#7a5fb0",
  "blue-mark": "#22719b",
  "red-mark": "#bd3b33",
  "neutral-mark": "#847c6f",
  "breathe-glow": "rgba(127,76,8,0.16)",
  // §L3 — ActionCard kinds
  "action-tint-amber": "rgba(224,159,62,0.12)",
  "action-border-bold-amber": "rgba(127,76,8,0.4)",
  "action-border-tinted-red": "rgba(156,42,36,0.5)",
  "action-border-dashed-gold": "rgba(111,84,12,0.6)",
  "action-tint-gold": "rgba(234,179,84,0.12)",
  // §L3 — queue states, provenance, evidence
  "queue-border-blocked": "rgba(127,76,8,0.42)",
  "queue-tint-blocked": "rgba(224,159,62,0.1)",
  "queue-border-failed": "rgba(156,42,36,0.4)",
  "chip-border-purple": "rgba(93,68,137,0.42)",
  "chip-tint-purple": "rgba(177,151,212,0.16)",
  "callout-border-purple": "rgba(93,68,137,0.42)",
  "callout-tint-purple": "rgba(177,151,212,0.14)",
  "callout-tint-amber": "rgba(224,159,62,0.14)",
  "callout-border-teal": "rgba(21,89,76,0.42)",
  "callout-tint-teal": "rgba(91,181,162,0.12)",
  "inset-well-bg": "#ece7dc",
  // §L3 — controls, states, the focus ring
  "button-border-primary": "#d08f2e",
  "button-border-affirm": "#4aa593",
  // "A well over a fill LIGHTENS it" — in both themes, since the fourth drop;
  // and the subtitle on a solid button is opaque on-fill at weight 500.
  "button-ink-on-solid": "#231f1a",
  "button-effect-bg-on-solid": "rgba(255,255,255,0.28)",
  "button-border-danger": "rgba(156,42,36,0.45)",
  "chip-border-amber": "rgba(127,76,8,0.42)",
  "chip-tint-amber": "rgba(224,159,62,0.16)",
  "choice-border-selected": "rgba(21,89,76,0.5)",
  "choice-tint-selected": "rgba(91,181,162,0.14)",
  "choice-mark-bg": "var(--bk-teal-ink)",
  "on-ink-solid": "#f8f5ef",
  "toggle-knob-on": "var(--bk-color-surface)",
  "toggle-knob-off": "var(--bk-color-surface)",
  "placeholder-error-border": "rgba(156,42,36,0.45)",
  "placeholder-error-tint": "rgba(156,42,36,0.07)",
  "placeholder-action-border-red": "rgba(156,42,36,0.5)",
  // §L4 — chat answer (the third revision of the day drew the suggestion chips)
  "suggestion-border-amber": "rgba(127,76,8,0.42)",
  "suggestion-tint-amber": "rgba(224,159,62,0.14)",
  "quote-tint-teal": "rgba(91,181,162,0.14)",
  "step-rail-done": "rgba(21,89,76,0.4)",
  "step-bubble-tint-current": "rgba(224,159,62,0.16)",
  "step-bubble-done-bg": "var(--bk-teal-ink)",
  "filament-edge": "var(--bk-amber-mark)",
  "filament-core": "var(--bk-amber-fill)",
  // The rail, the palette and the graph draw their own grounds one step off
  // the canvas. "Elevation still means lighter": a ground that was darker than
  // a card in the dark is darker than a card on paper too — toward the canvas.
  // The rail's ground must be darker than a card and still carry ink-mute:
  // on paper that is the canvas itself (4.59:1) — one step darker (#e6e0d3)
  // measured 4.31 across seventy rail labels. See design-feedback §19.
  "rail-bg": "#ece7dc",
  "graph-canvas-bg": "#f2eee6",
  "map-sky-inner": "#e4ded0",
  "map-sky-outer": "#ddd6c7",
  "hatch-stripe": "#e6e0d3",
  "hover-border": "#b5ab96",
  // A toned card's hover is its own tint +.04 alpha, "and paper uses the same
  // deltas over its lighter tints": .13 → .17 for the three cool hues. The
  // rule's +0.07 cap at 0.16 would have stopped one step short.
  "surface-hover-tint-teal": "rgba(91,181,162,0.17)",
  "surface-hover-tint-purple": "rgba(177,151,212,0.17)",
  "surface-hover-tint-blue": "rgba(103,184,227,0.17)",
  "palette-shadow": "rgba(90,78,58,0.35)",
};

/* ── Derivation ─────────────────────────────────────────────────────────── */

function hex(h: string): Rgb {
  const s = h.slice(1);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
}

function dot(tone: string): string {
  const value = DOT[tone];
  if (!value) throw new Error(`no light dot for ${tone}`);
  return value;
}

function accentRgb(tone: string, role: "ink" | "fill"): Rgb {
  return hex(role === "fill" ? FILL[tone]! : INK[tone]!);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}

function derive(name: string, dark: string): string {
  if (name in SPECIFIED) return SPECIFIED[name]!;
  // A reference stays a reference: the thing it points at is themed.
  if (dark.startsWith("var(")) return dark;

  // Accent roles by name.
  const role = /^(amber|gold|teal|purple|blue|red|neutral)-(ink|fill|mark)$/.exec(name);
  if (role) {
    const tone = role[1]!;
    const kind = role[2] as "ink" | "fill" | "mark";
    return kind === "ink" ? INK[tone]! : kind === "fill" ? FILL[tone]! : dot(tone);
  }
  // The base accent name is the hue's identity, which on paper is its ink.
  const base = /^color-(amber|gold|teal|purple|blue|red)$/.exec(name);
  if (base) return INK[base[1]!]!;
  // The two lifts are fills one step up and keep their values: a fill is a fill.
  if (name.endsWith("-lift")) return dark;

  if (dark.startsWith("#")) {
    const mapped = BASE[dark];
    if (!mapped) throw new Error(`no light value for ${name}: ${dark}`);
    return mapped;
  }

  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(dark);
  if (!m) throw new Error(`cannot derive ${name}: ${dark}`);
  const key = `${m[1]},${m[2]},${m[3]}`;
  const alpha = Number(m[4]);
  const hue = HUES[key];
  if (!hue) throw new Error(`unknown hue in ${name}: ${dark}`);

  const isFill = FILL_ROLE.test(name);
  if (hue in INK) {
    // An accent. Tints and bars take the fill hue; strokes take the ink hue.
    if (isFill) {
      // Neutral has no fill — a grey tint is the grey ink, faint.
      const rgb = hue === "neutral" ? hex(INK.neutral!) : accentRgb(hue, "fill");
      return rgba(rgb, alpha <= 0.14 ? Math.min(round2(alpha + 0.07), 0.16) : alpha);
    }
    return rgba(accentRgb(hue, "ink"), alpha <= 0.5 ? Math.min(round2(alpha + 0.05), 0.6) : alpha);
  }
  if (hue === "canvas") {
    const as = CANVAS_HUE_AS[name];
    if (!as) throw new Error(`canvas-hue token needs a light ground: ${name}`);
    return rgba(LIGHT_RGB[as]!, alpha);
  }
  if (hue === "dim" || hue === "edge" || hue === "line") {
    const rgb = LIGHT_RGB[hue]!;
    return isFill
      ? rgba(rgb, alpha <= 0.14 ? Math.min(round2(alpha + 0.07), 0.16) : alpha)
      : rgba(rgb, alpha <= 0.5 ? Math.min(round2(alpha + 0.05), 0.6) : alpha);
  }
  // ink, veil, raised, surface, shadow: same alpha, light hue.
  return rgba(LIGHT_RGB[hue]!, alpha);
}

export function lightTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, dark] of Object.entries(TOKENS)) out[name] = derive(name, dark);
  return out;
}

export function lightTs(tokens = lightTokens()): string {
  const lines = Object.entries(tokens).map(([name, value]) => `  "${name}": "${value}",`);
  return `export const LIGHT_TOKENS: Record<TokenName, string> = {\n${lines.join("\n")}\n};`;
}

/** One declaration per token: `--bk-x: light-dark(<light>, <dark>);` — or the
 * bare value when the two halves agree, so a reference reads as a reference. */
export function declaration(name: string, light: string, dark: string): string {
  return light === dark ? `--bk-${name}: ${dark};` : `--bk-${name}: light-dark(${light}, ${dark});`;
}

/**
 * Rewrites the `:root` declarations in place, so each token keeps the comment
 * that explains it. Matches a bare dark value or an existing `light-dark()`,
 * so it is idempotent.
 */
export function rewriteTheme(css: string, tokens = lightTokens()): string {
  const seen = new Set<string>();
  const out = css.replace(/^(\s*)--bk-([\w-]+):\s*([^;]+);/gm, (whole, indent: string, name: string) => {
    if (!(name in TOKENS)) throw new Error(`tokens.css declares --bk-${name}, which tokens.ts does not know`);
    seen.add(name);
    return `${indent}${declaration(name, tokens[name]!, TOKENS[name as keyof typeof TOKENS])}`;
  });
  const missing = Object.keys(TOKENS).filter((n) => !seen.has(n));
  if (missing.length) throw new Error(`tokens.ts knows tokens tokens.css does not declare: ${missing.join(", ")}`);
  return out;
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
  const tokens = lightTokens();
  const theme = join(root, "src", "tokens.css");
  writeFileSync(theme, rewriteTheme(readFileSync(theme, "utf8"), tokens));
  splice(join(root, "src", "tokens.ts"), "// @light-tokens:start", "// @light-tokens:end", lightTs(tokens));
  const specified = Object.keys(SPECIFIED).filter((k) => k in TOKENS).length;
  console.log(`${Object.keys(tokens).length} tokens: ${specified} specified by the design, ${Object.keys(tokens).length - specified} derived`);
  const unknown = Object.keys(SPECIFIED).filter((k) => !(k in TOKENS));
  if (unknown.length) console.log("overrides naming no token:", unknown.join(", "));
}
