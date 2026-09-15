import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The same data as {@link AgentOrbit}, as swim lanes.
 *
 * Real elapsed time runs along the x-axis, so overlap and stalls are visible in
 * a way an orbit cannot show. **A hatched fill means waiting on the user**,
 * never "in progress" — that distinction is the whole reason the chart exists,
 * and it is why the legend's own swatch is drawn from the same ramp as the
 * segments rather than from a second colour.
 *
 * Segment `start` and `width` are percentages of the lane, so the caller owns
 * the time axis and the component never guesses at one.
 */
export interface LaneSegment {
  /** 0-100, the left edge as a percentage of the lane. */
  start: number;
  /** 0-100, the width as a percentage of the lane. */
  width: number;
  /** Waiting on a person. Not "in progress". */
  hatch?: boolean;
  /** Fades out to the right: still running, no known end. */
  fade?: boolean;
}

export interface Lane {
  name: string;
  tone?: Tone;
  segments: LaneSegment[];
}

export interface LaneLegendItem {
  label: string;
  tone?: Tone;
  /** The swatch glyph. `HATCH_GLYPH` draws the half-alpha swatch, so the key
   * and the chart agree about what hatching means. */
  glyph?: string;
}

export interface LaneChartProps {
  lanes?: Lane[];
  /** Axis labels, spread edge to edge. */
  ticks?: string[];
  legend?: LaneLegendItem[];
  /** Width of the lane-name gutter, in px. */
  labelWidth?: number;
}

/**
 * The glyph the legend uses for "waiting on you".
 *
 * Exported because the source keys the half-alpha swatch off the glyph STRING
 * (`l.glyph === '▨'`) rather than off a boolean, and a caller comparing against
 * a character they typed by hand would silently get the solid swatch. Ported as
 * found; the constant is what makes it checkable.
 */
export const HATCH_GLYPH = "▨";

const SOLID_GLYPH = "■";

const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

/** The source derives these two by concatenating a hex alpha suffix onto the
 * lane's colour (`c + '80'`, `c + '8c'`). A token cannot be concatenated, so
 * the two derived values are two real ramps — see `theme.css`. */
const HATCH: Record<Tone, string> = {
  amber: token("lane-hatch-amber"),
  gold: token("lane-hatch-gold"),
  teal: token("lane-hatch-teal"),
  purple: token("lane-hatch-purple"),
  blue: token("lane-hatch-blue"),
  red: token("lane-hatch-red"),
  neutral: token("lane-hatch-neutral"),
};

const FADE: Record<Tone, string> = {
  amber: token("lane-fade-amber"),
  gold: token("lane-fade-gold"),
  teal: token("lane-fade-teal"),
  purple: token("lane-fade-purple"),
  blue: token("lane-fade-blue"),
  red: token("lane-fade-red"),
  neutral: token("lane-fade-neutral"),
};

const FALLBACK: Lane[] = [
  { name: "researcher", tone: "purple", segments: [{ start: 2, width: 76, fade: true }] },
  {
    name: "note-filer",
    tone: "teal",
    segments: [
      { start: 8, width: 34 },
      { start: 44, width: 20, hatch: true },
    ],
  },
  { name: "source-watch", tone: "blue", segments: [{ start: 0, width: 26 }] },
  { name: "ledger", tone: "red", segments: [{ start: 30, width: 9 }] },
];

const FALLBACK_TICKS = ["0s", "30s", "60s", "90s"];

const FALLBACK_LEGEND: LaneLegendItem[] = [
  { label: "running", tone: "teal" },
  { label: "waiting on you", tone: "teal", glyph: HATCH_GLYPH },
  { label: "failed", tone: "red" },
];

export function LaneChart(p: LaneChartProps) {
  if (p.lanes && !Array.isArray(p.lanes)) warnOnce("LaneChart: `lanes` is not an array; no lanes will render.");
  const labelW = Number(p.labelWidth) || 88;
  const src = p.lanes || FALLBACK;

  const track: CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: 12,
    borderRadius: 4,
    background: color.surface,
    position: "relative",
    overflow: "hidden",
    display: "block",
  };

  return (
    <div style={{ boxSizing: "border-box", width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          paddingLeft: labelW + 8,
          font: `400 9px/1 ${font.mono}`,
          color: color.inkMute,
        }}
      >
        {(p.ticks || FALLBACK_TICKS).map((t, i) => (
          <span key={`${t}-${i}`}>{t}</span>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {src.map((lane, i) => {
          const tone = lane.tone || "teal";
          const ink = INKS[tone] || INKS.teal;
          return (
            <div key={`${lane.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: labelW,
                  flex: "none",
                  textAlign: "right",
                  font: `500 10.5px/1 ${font.mono}`,
                  color: ink,
                }}
              >
                {lane.name}
              </span>
              <span style={track}>
                {(lane.segments || []).map((seg, j) => (
                  <span
                    key={j}
                    style={{
                      position: "absolute",
                      left: `${seg.start}%`,
                      width: `${seg.width}%`,
                      top: 0,
                      bottom: 0,
                      borderRadius: 4,
                      background: seg.hatch
                        ? `repeating-linear-gradient(45deg,${HATCH[tone] || HATCH.teal} 0 4px,transparent 4px 8px)`
                        : seg.fade
                          ? `linear-gradient(to right,${ink},${FADE[tone] || FADE.teal})`
                          : ink,
                    }}
                  />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 3,
          font: `400 9.5px/1 ${font.mono}`,
          color: color.inkMute,
        }}
      >
        {(p.legend || FALLBACK_LEGEND).map((l, i) => {
          const tone = l.tone || "teal";
          const hatched = l.glyph === HATCH_GLYPH;
          return (
            <span key={`${l.label}-${i}`}>
              <span style={{ color: hatched ? HATCH[tone] || HATCH.teal : INKS[tone] || INKS.teal }}>
                {l.glyph || SOLID_GLYPH}
              </span>{" "}
              {l.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
