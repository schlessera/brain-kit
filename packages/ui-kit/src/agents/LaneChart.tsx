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
 *
 * ## Segments that meet are ONE bar, not two
 *
 * A lane whose segments touch -- `{start: 0, width: 58}` then `{start: 58, …}`
 * -- is one piece of work changing state, and it has to read that way. Ported
 * as written, every segment carried a radius on all four corners, so the solid
 * bar's right cap and the hatched bar's left cap rounded away from each other
 * and left a notch: two runs butted together rather than one that started
 * waiting.
 *
 * A continuation therefore drops its left rounding, reaches back under its
 * predecessor by exactly one corner radius, and paints behind it. All three are
 * needed -- square corners alone still leave the predecessor's own cap rounding
 * into empty track.
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
    <div data-kit-lane-chart="" style={{ boxSizing: "border-box", width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
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
            <div data-lane-name={lane.name} key={`${lane.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: labelW,
                  flex: "none",
                  textAlign: "right",
                  font: `500 10.5px/1 ${font.mono}`,
                  color: ink,
                  overflowWrap: "anywhere",
                  whiteSpace: "normal",
                }}
              >
                {lane.name}
              </span>
              <span style={track}>
                {(lane.segments || []).map((seg, j) => {
                  // Does this segment CONTINUE the one before it, or start a
                  // new run? Two segments that meet at a number are one lane of
                  // work changing state -- running, then waiting on you -- and
                  // the chart's job is to say the work did not stop.
                  const prev = (lane.segments || [])[j - 1];
                  const joins = prev !== undefined && seg.start <= prev.start + prev.width + 0.01;
                  return (
                    <span
                      key={j}
                      data-lane-segment="" data-lane-start={seg.start} data-lane-width={seg.width}
                      data-lane-hatch={seg.hatch ? "true" : undefined} data-lane-fade={seg.fade ? "true" : undefined}
                      style={{
                        position: "absolute",
                        // A continuation reaches back UNDER its predecessor by
                        // exactly one corner radius and drops its own left
                        // rounding. Without both, the two ends round away from
                        // each other and leave a notch that reads as a gap --
                        // two pieces of work butted together rather than one
                        // that changed state. The 4px is `borderRadius`, not a
                        // tuned number: it is the width of the notch.
                        left: joins ? `calc(${seg.start}% - 4px)` : `${seg.start}%`,
                        width: joins ? `calc(${seg.width}% + 4px)` : `${seg.width}%`,
                        borderRadius: joins ? "0 4px 4px 0" : 4,
                        // And it paints BEHIND, so the solid segment's own cap
                        // covers the overlap rather than the hatch drawing over
                        // it. Later siblings win ties, so this cannot be left to
                        // document order.
                        zIndex: joins ? 0 : 1,
                        top: 0,
                        bottom: 0,
                        background: seg.hatch
                          ? `repeating-linear-gradient(45deg,${HATCH[tone] || HATCH.teal} 0 4px,transparent 4px 8px)`
                          : seg.fade
                            ? `linear-gradient(to right,${ink},${FADE[tone] || FADE.teal})`
                            : ink,
                      }}
                    />
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
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
