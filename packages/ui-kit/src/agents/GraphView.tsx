import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * An entity neighbourhood.
 *
 * Node colour is the entity TYPE, and it is the same vocabulary `PathRef` and
 * inline entity mentions use: teal a person, blue a company, purple a project,
 * amber the focus node. So a colour here means the same thing it means in a
 * sentence three components away.
 *
 * `x` and `y` are percentages of the box, not coordinates — this is the one
 * view in the kit that does NOT project. `MapView` is the component that owns
 * geography; a graph is a layout somebody chose.
 *
 * Edges come in two weights, and the difference is load-bearing: every node is
 * joined to the focus node with the brighter `edge` colour, and `edges` adds
 * explicit pairs with the dimmer hairline. So "connected to what you asked
 * about" and "connected to each other" are distinguishable without a legend.
 */
export interface GraphNode {
  label: string;
  tone?: Tone;
  /** 0-100, a percentage of the box's width. */
  x: number;
  /** 0-100, a percentage of the box's height. */
  y: number;
  /** The node the neighbourhood is drawn around. The first one wins. */
  focus?: boolean;
}

/** Index pairs into `nodes`. */
export type GraphEdge = [number, number];

export interface GraphLegendItem {
  label: string;
  tone?: Tone;
}

export interface GraphViewProps {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  legend?: GraphLegendItem[];
  /** The uppercase mono line in the corner. */
  label?: string;
  /** Hop count and node total, bottom right. */
  meta?: string;
  minHeight?: number;
}

const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

/** The source's fallback names a real airline, a plausible real person and a
 * real city used as a client. All three are replaced per D19; the shape is the
 * design's — one focus node and four neighbours at the same coordinates. */
const FALLBACK: GraphNode[] = [
  { label: "scylla", tone: "amber", x: 50, y: 50, focus: true },
  { label: "circe", tone: "teal", x: 24, y: 25 },
  { label: "the strait", tone: "purple", x: 79, y: 32 },
  { label: "charybdis", tone: "blue", x: 31, y: 77 },
  { label: "decisions/", tone: "neutral", x: 76, y: 79 },
];

const FALLBACK_EDGES: GraphEdge[] = [
  [1, 2],
  [3, 4],
];

const FALLBACK_LEGEND: GraphLegendItem[] = [
  { label: "person", tone: "teal" },
  { label: "company", tone: "blue" },
  { label: "project", tone: "purple" },
];

export function GraphView(p: GraphViewProps) {
  if (p.nodes && !Array.isArray(p.nodes)) warnOnce("GraphView: `nodes` is not an array; no nodes will render.");
  const src = p.nodes || FALLBACK;
  const focus = src.find((n) => n.focus) || src[0];

  const lines: { x1: number; y1: number; x2: number; y2: number; stroke: string }[] = [];
  if (focus) {
    for (const n of src) {
      if (!n.focus && n !== focus) {
        lines.push({ x1: focus.x, y1: focus.y, x2: n.x, y2: n.y, stroke: color.edge });
      }
    }
  }
  for (const [a, b] of p.edges || FALLBACK_EDGES) {
    const from = src[a];
    const to = src[b];
    if (from && to) lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: color.line });
  }

  const box: CSSProperties = {
    position: "relative",
    flex: "none",
    alignSelf: "stretch",
    minHeight: Number(p.minHeight) || 240,
    boxSizing: "border-box",
    width: "100%",
    border: `1px solid ${color.line}`,
    borderRadius: 16,
    background: token("graph-canvas-bg"),
    overflow: "hidden",
  };
  const label = p.label ?? "Neighbourhood";
  const meta = p.meta ?? "2-hop · 34 nodes";
  const legend = p.legend || FALLBACK_LEGEND;

  return (
    <div style={box}>
      {label ? (
        <div
          style={{
            position: "absolute",
            left: 12,
            top: 11,
            zIndex: 2,
            font: `600 9.5px/1 ${font.mono}`,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: color.inkMute,
          }}
        >
          {label}
        </div>
      ) : null}
      {/* `preserveAspectRatio: none` is what lets a 0-100 viewBox act as
       * percentages of a box of any shape, and `vector-effect` is what keeps
       * the stroke 1px wide after that distortion. The stroke arrives through
       * `style` rather than the `stroke` attribute because a presentation
       * attribute carrying `var()` is not portable. */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      >
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: l.stroke }}
          />
        ))}
      </svg>
      {src.map((n, i) => {
        const ink = INKS[n.tone || "neutral"] || INKS.neutral;
        return (
          <div
            key={`${n.label}-${i}`}
            style={{
              position: "absolute",
              left: `${n.x}%`,
              top: `${n.y}%`,
              transform: "translate(-50%,-50%)",
              display: "flex",
              alignItems: "center",
              gap: 5,
              whiteSpace: "nowrap",
              background: n.focus ? token("graph-node-focus-tint") : color.raised,
              border: `1px solid ${n.focus ? ink : color.edge}`,
              borderRadius: 999,
              padding: n.focus ? "5px 11px" : "4px 9px",
              font: `${n.focus ? "600 11px/1 " : "500 10px/1 "}${font.body}`,
              color: ink,
            }}
          >
            {n.label}
          </div>
        );
      })}
      {legend.length ? (
        <div
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: 11,
            display: "flex",
            gap: 9,
            font: `400 9px/1 ${font.mono}`,
            color: color.inkMute,
          }}
        >
          {legend.map((l, i) => (
            <span key={`${l.label}-${i}`}>
              <span style={{ color: INKS[l.tone || "neutral"] || INKS.neutral }}>●</span> {l.label}
            </span>
          ))}
          {meta ? <span style={{ marginLeft: "auto" }}>{meta}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
