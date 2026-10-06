/**
 * Mermaid theme variables for the two schemes a diagram can land on.
 *
 * Mermaid's stock "dark" theme is a blue-grey palette that reads as foreign
 * next to the app's warm-neutral chrome, and its "neutral" theme is what the
 * share renderer used to emit. Both are replaced by the "base" theme plus the
 * variables below, so an in-app diagram and a shared PNG are recognisably the
 * same product.
 *
 * Every value is a kit token, read for the scheme (`readToken`), because
 * mermaid's `themeVariables` take literal colours and cannot follow a CSS
 * custom property:
 *   - The six diagram surfaces are the kit's `--bk-diagram-*` (seventh drop
 *     §L6): the grounds are surfaces, and every LINE is information and takes
 *     the 3:1 bar. Text is the ink — a node's label never takes its node's
 *     colour.
 *   - Multi-series colours are the kit's canvas slots, the repo's one
 *     CVD-validated categorical palette, respelled per theme in the same
 *     order: a series keeps its slot between a dark diagram and its paper
 *     export, and the slot order is the CVD-safety mechanism.
 *   - A bar that carries `on-fill` text (an active, done or critical task) is
 *     a FILL, never an ink or a mark: on paper a darkened accent under
 *     near-black text is unreadable.
 *
 * The share pipeline renders in `light`, whatever the screen shows: a share
 * lands in a mail client or a printer, which assume paper.
 */
import type { TokenName } from "@schlessera/brain-ui-kit/internal";

import { readToken, type ColorScheme } from "./light-dark.js";

export type MermaidTheme = ColorScheme;

// These variables reach mermaid through initialize(), NOT through a
// `%%{init: …}%%` directive: mermaid's directive path rewrites `'` to `"`
// before parsing the JSON and drops any themeVariable containing a hyphen, so
// a font stack cannot survive it. See the note in mermaid.ts.
const SANS = '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif';

interface DiagramPalette {
  bg: string;
  node: string;
  cluster: string;
  line: string;
  clusterBorder: string;
  text: string;
  /** The raised surface: sequence activations, notes, alternate sections. */
  raised: string;
  /** The card edge, as a neutral bar ground. */
  edge: string;
  muted: string;
  /** The amber ink: titles, note borders, the quadrant point. */
  accent: string;
  /** The teal ink: the active activation, the today line. */
  affirm: string;
  /** The red ink: error text. */
  danger: string;
  /** Text on a fill — near-black in both themes. */
  onFill: string;
  /** The three fills that carry on-fill text: active, done, critical. */
  amberFill: string;
  neutralFill: string;
  redFill: string;
  /** Ordered series colours, long enough for the 12-slot scales mermaid asks for. */
  series: string[];
}

function palette(scheme: ColorScheme): DiagramPalette {
  const t = (name: TokenName) => readToken(name, scheme);
  return {
    bg: t("diagram-bg"),
    node: t("diagram-node"),
    cluster: t("diagram-cluster"),
    line: t("diagram-line"),
    clusterBorder: t("diagram-cluster-border"),
    text: t("diagram-text"),
    raised: t("color-raised"),
    edge: t("color-edge"),
    muted: t("color-ink-mute"),
    accent: t("color-amber"),
    affirm: t("color-teal"),
    danger: t("color-red"),
    onFill: t("on-fill"),
    amberFill: t("amber-fill"),
    neutralFill: t("neutral-fill"),
    redFill: t("red-fill"),
    series: [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => t(`canvas-slot-${n}` as TokenName)),
      t("canvas-other"),
      t("blue-mark"),
      t("gold-mark"),
      t("purple-mark"),
    ],
  };
}

/** Expand a scale into the `${prefix}0..count-1` (or 1-based) shape mermaid wants. */
function scale(series: string[], prefix: string, count: number, oneBased = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    out[`${prefix}${oneBased ? i + 1 : i}`] = series[i % series.length]!;
  }
  return out;
}

/**
 * The variables for one palette. Node fills use the diagram node surface so
 * nodes sit a step above the block's own plate, and borders use the diagram
 * line — a 1px border at the card-edge value all but disappears against the
 * plate at diagram scale.
 */
function variables(scheme: ColorScheme, p: DiagramPalette): Record<string, string | boolean> {
  return {
    darkMode: scheme === "dark",
    background: p.bg,
    fontFamily: SANS,
    fontSize: "14px",

    primaryColor: p.node,
    primaryTextColor: p.text,
    primaryBorderColor: p.line,
    secondaryColor: p.raised,
    secondaryTextColor: p.text,
    secondaryBorderColor: p.line,
    tertiaryColor: p.cluster,
    tertiaryTextColor: p.muted,
    tertiaryBorderColor: p.clusterBorder,

    mainBkg: p.node,
    nodeBorder: p.line,
    nodeTextColor: p.text,
    textColor: p.text,
    lineColor: p.line,
    defaultLinkColor: p.line,
    titleColor: p.accent,
    edgeLabelBackground: p.bg,
    clusterBkg: p.cluster,
    clusterBorder: p.clusterBorder,

    noteBkgColor: p.raised,
    noteTextColor: p.text,
    noteBorderColor: p.accent,
    errorBkgColor: p.cluster,
    errorTextColor: p.danger,

    // Sequence
    actorBkg: p.node,
    actorBorder: p.line,
    actorTextColor: p.text,
    actorLineColor: p.line,
    signalColor: p.line,
    signalTextColor: p.text,
    labelBoxBkgColor: p.raised,
    labelBoxBorderColor: p.clusterBorder,
    labelTextColor: p.text,
    loopTextColor: p.text,
    activationBkgColor: p.raised,
    activationBorderColor: p.affirm,
    sequenceNumberColor: p.onFill,

    // State / class / journey
    labelColor: p.text,
    altBackground: p.cluster,
    classText: p.text,

    // Gantt
    sectionBkgColor: p.raised,
    altSectionBkgColor: p.bg,
    sectionBkgColor2: p.node,
    gridColor: p.clusterBorder,
    taskBkgColor: p.edge,
    taskTextColor: p.text,
    taskTextOutsideColor: p.text,
    taskTextDarkColor: p.onFill,
    taskBorderColor: p.line,
    doneTaskBkgColor: p.neutralFill,
    doneTaskBorderColor: p.line,
    activeTaskBkgColor: p.amberFill,
    activeTaskBorderColor: p.amberFill,
    critBkgColor: p.redFill,
    critBorderColor: p.redFill,
    todayLineColor: p.affirm,

    // Pie
    pieTitleTextColor: p.text,
    pieSectionTextColor: p.onFill,
    pieLegendTextColor: p.text,
    pieStrokeColor: p.bg,
    pieOuterStrokeColor: p.clusterBorder,

    // Quadrant / requirement / misc surfaces that don't inherit cleanly
    quadrant1Fill: p.node,
    quadrant2Fill: p.raised,
    quadrant3Fill: p.bg,
    quadrant4Fill: p.node,
    quadrantPointFill: p.accent,
    quadrantTitleFill: p.text,
    quadrantInternalBorderStrokeFill: p.clusterBorder,
    quadrantExternalBorderStrokeFill: p.line,

    ...scale(p.series, "pie", 12, true), // pie1..pie12
    ...scale(p.series, "cScale", 12), // cScale0..11 (journey, timeline, xychart)
    ...scale(p.series, "fillType", 8), // fillType0..7 (class/state/journey sections)
    ...scale(p.series, "git", 8), // git0..git7 (gitgraph branches)
  };
}

/**
 * Theme variables for a scheme, as mermaid's `themeVariables` object. Read
 * at call time, so a host that re-points a token and a theme switch are both
 * honoured; `mermaid.ts` re-initialises per render anyway.
 */
export function mermaidThemeVariables(theme: MermaidTheme): Record<string, string | boolean> {
  return variables(theme, palette(theme));
}
