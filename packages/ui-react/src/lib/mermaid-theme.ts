/**
 * Mermaid theme variables for the two surfaces a diagram can land on.
 *
 * Mermaid's stock "dark" theme is a blue-grey palette that reads as foreign
 * next to the app's warm-neutral chrome, and its "neutral" theme is what the
 * share renderer used to emit. Both are replaced by the "base" theme plus the
 * variables below, so an in-app diagram and a shared PNG are recognisably the
 * same product.
 *
 * Two rules kept the palette honest:
 *   - Surfaces follow the tokens in theme.css, not approximations of them. A
 *     chat diagram sits on `--color-surface` (#141619), not on the page
 *     background, because MermaidBlock draws it on a raised plate.
 *   - Multi-series colors reuse CATEGORICAL_SLOTS from the graph view, which
 *     is the repo's one CVD-validated categorical palette. Slot order is the
 *     CVD-safety mechanism there and is preserved here.
 */
import { CATEGORICAL_SLOTS, OTHER_COLOR } from "../components/graph/lib/graph-helpers.js";

export type MermaidTheme = "dark" | "light";

// These variables reach mermaid through initialize(), NOT through a
// `%%{init: …}%%` directive: mermaid's directive path rewrites `'` to `"`
// before parsing the JSON and drops any themeVariable containing a hyphen, so
// a font stack cannot survive it. See the note in mermaid.ts.
const SANS = '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif';

/** Ordered series colors, long enough for the 12-slot scales mermaid asks for. */
const SERIES = [...CATEGORICAL_SLOTS, OTHER_COLOR, "#67b8e3", "#eab354", "#b197d4"];

/** Expand a scale into the `${prefix}0..count-1` (or 1-based) shape mermaid wants. */
function scale(prefix: string, count: number, oneBased = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    out[`${prefix}${oneBased ? i + 1 : i}`] = SERIES[i % SERIES.length];
  }
  return out;
}

/**
 * Dark: the in-app palette. Node fills use `--color-surface-overlay` so nodes
 * sit a step above the block's own `--color-surface` plate, and borders use
 * #3d4150 rather than `--color-border` (#2a2d35) — a 1px border at the token
 * value all but disappears against the plate at diagram scale.
 */
const DARK: Record<string, string | boolean> = {
  darkMode: true,
  background: "#141619",
  fontFamily: SANS,
  fontSize: "14px",

  primaryColor: "#1e2128",
  primaryTextColor: "#e8e4df",
  primaryBorderColor: "#3d4150",
  secondaryColor: "#1a1d22",
  secondaryTextColor: "#e8e4df",
  secondaryBorderColor: "#3d4150",
  tertiaryColor: "#0c0e12",
  tertiaryTextColor: "#8a8691",
  tertiaryBorderColor: "#2a2d35",

  mainBkg: "#1e2128",
  nodeBorder: "#3d4150",
  nodeTextColor: "#e8e4df",
  textColor: "#e8e4df",
  lineColor: "#8a8691",
  defaultLinkColor: "#8a8691",
  titleColor: "#e09f3e",
  edgeLabelBackground: "#141619",
  clusterBkg: "#0c0e12",
  clusterBorder: "#2a2d35",

  noteBkgColor: "#1a1d22",
  noteTextColor: "#e8e4df",
  noteBorderColor: "#e09f3e",
  errorBkgColor: "#2a1a1a",
  errorTextColor: "#f87171",

  // Sequence
  actorBkg: "#1e2128",
  actorBorder: "#3d4150",
  actorTextColor: "#e8e4df",
  actorLineColor: "#3d4150",
  signalColor: "#8a8691",
  signalTextColor: "#e8e4df",
  labelBoxBkgColor: "#1a1d22",
  labelBoxBorderColor: "#2a2d35",
  labelTextColor: "#e8e4df",
  loopTextColor: "#e8e4df",
  activationBkgColor: "#1a1d22",
  activationBorderColor: "#5bb5a2",
  sequenceNumberColor: "#0c0e12",

  // State / class / journey
  labelColor: "#e8e4df",
  altBackground: "#0c0e12",
  classText: "#e8e4df",

  // Gantt
  sectionBkgColor: "#1a1d22",
  altSectionBkgColor: "#141619",
  sectionBkgColor2: "#1e2128",
  gridColor: "#2a2d35",
  taskBkgColor: "#2a2d35",
  taskTextColor: "#e8e4df",
  taskTextOutsideColor: "#e8e4df",
  taskTextDarkColor: "#0c0e12",
  taskBorderColor: "#3d4150",
  doneTaskBkgColor: "#565b66",
  doneTaskBorderColor: "#3d4150",
  activeTaskBkgColor: "#e09f3e",
  activeTaskBorderColor: "#e09f3e",
  critBkgColor: "#d03b3b",
  critBorderColor: "#d03b3b",
  todayLineColor: "#5bb5a2",

  // Pie
  pieTitleTextColor: "#e8e4df",
  pieSectionTextColor: "#0c0e12",
  pieLegendTextColor: "#e8e4df",
  pieStrokeColor: "#141619",
  pieOuterStrokeColor: "#2a2d35",

  // Quadrant / requirement / misc surfaces that don't inherit cleanly
  quadrant1Fill: "#1e2128",
  quadrant2Fill: "#1a1d22",
  quadrant3Fill: "#141619",
  quadrant4Fill: "#1e2128",
  quadrantPointFill: "#e09f3e",
  quadrantTitleFill: "#e8e4df",
  quadrantInternalBorderStrokeFill: "#2a2d35",
  quadrantExternalBorderStrokeFill: "#3d4150",
};

/**
 * Light: what the share renderer emits. Tuned against the PNG/PDF template's
 * own palette (`ui-server/src/render/template.ts`: #ffffff page, #f8fafc
 * surface, #e5e7eb border, #1f2937 text) so a diagram doesn't look pasted in.
 * The amber and teal are darkened from the app tokens — #e09f3e on white is a
 * 1.9:1 line, unusable for edges or titles.
 */
const LIGHT: Record<string, string | boolean> = {
  darkMode: false,
  background: "#ffffff",
  fontFamily: SANS,
  fontSize: "14px",

  primaryColor: "#f8fafc",
  primaryTextColor: "#1f2937",
  primaryBorderColor: "#c3c9d2",
  secondaryColor: "#f3f4f6",
  secondaryTextColor: "#1f2937",
  secondaryBorderColor: "#c3c9d2",
  tertiaryColor: "#ffffff",
  tertiaryTextColor: "#6b7280",
  tertiaryBorderColor: "#e5e7eb",

  mainBkg: "#f8fafc",
  nodeBorder: "#c3c9d2",
  nodeTextColor: "#1f2937",
  textColor: "#1f2937",
  lineColor: "#6b7280",
  defaultLinkColor: "#6b7280",
  titleColor: "#9a6516",
  edgeLabelBackground: "#ffffff",
  clusterBkg: "#f3f4f6",
  clusterBorder: "#d7dbe0",

  noteBkgColor: "#fdf6e8",
  noteTextColor: "#1f2937",
  noteBorderColor: "#9a6516",
  errorBkgColor: "#fdecec",
  errorTextColor: "#b42323",

  // Sequence
  actorBkg: "#f8fafc",
  actorBorder: "#c3c9d2",
  actorTextColor: "#1f2937",
  actorLineColor: "#c3c9d2",
  signalColor: "#6b7280",
  signalTextColor: "#1f2937",
  labelBoxBkgColor: "#f3f4f6",
  labelBoxBorderColor: "#d7dbe0",
  labelTextColor: "#1f2937",
  loopTextColor: "#1f2937",
  activationBkgColor: "#f3f4f6",
  activationBorderColor: "#2f7d6b",
  sequenceNumberColor: "#ffffff",

  // State / class / journey
  labelColor: "#1f2937",
  altBackground: "#f3f4f6",
  classText: "#1f2937",

  // Gantt
  sectionBkgColor: "#f8fafc",
  altSectionBkgColor: "#ffffff",
  sectionBkgColor2: "#f3f4f6",
  gridColor: "#e5e7eb",
  taskBkgColor: "#e5e7eb",
  taskTextColor: "#1f2937",
  taskTextOutsideColor: "#1f2937",
  taskTextDarkColor: "#1f2937",
  taskBorderColor: "#c3c9d2",
  doneTaskBkgColor: "#d7dbe0",
  doneTaskBorderColor: "#c3c9d2",
  activeTaskBkgColor: "#e0a75a",
  activeTaskBorderColor: "#9a6516",
  critBkgColor: "#e08a8a",
  critBorderColor: "#b42323",
  todayLineColor: "#2f7d6b",

  // Pie
  pieTitleTextColor: "#1f2937",
  pieSectionTextColor: "#ffffff",
  pieLegendTextColor: "#1f2937",
  pieStrokeColor: "#ffffff",
  pieOuterStrokeColor: "#d7dbe0",

  // Quadrant
  quadrant1Fill: "#f8fafc",
  quadrant2Fill: "#f3f4f6",
  quadrant3Fill: "#ffffff",
  quadrant4Fill: "#f8fafc",
  quadrantPointFill: "#9a6516",
  quadrantTitleFill: "#1f2937",
  quadrantInternalBorderStrokeFill: "#e5e7eb",
  quadrantExternalBorderStrokeFill: "#d7dbe0",
};

const SERIES_SCALES: Record<string, string> = {
  ...scale("pie", 12, true), // pie1..pie12
  ...scale("cScale", 12), // cScale0..11 (journey, timeline, xychart)
  ...scale("fillType", 8), // fillType0..7 (class/state/journey sections)
  ...scale("git", 8), // git0..git7 (gitgraph branches)
};

const THEME_VARIABLES: Record<MermaidTheme, Record<string, string | boolean>> = {
  dark: { ...DARK, ...SERIES_SCALES },
  light: { ...LIGHT, ...SERIES_SCALES },
};

/** Theme variables for a target surface, as mermaid's `themeVariables` object. */
export function mermaidThemeVariables(theme: MermaidTheme): Record<string, string | boolean> {
  return THEME_VARIABLES[theme];
}
