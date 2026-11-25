import type { CSSProperties } from "react";

import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";
import { sparklineGeometry, type HistoryPoint } from "./history-geometry.js";

/**
 * A small line for one figure over time (#4543): "What this app added on this
 * volume", placed in the stores breakdown by #4544.
 *
 * A new primitive rather than a `TrendChart` variant, because `TrendChart`
 * draws bars and cannot show a gap as a break. Here a `null` value breaks the
 * line exactly as `HistoryChart` does, and a point that stands alone between
 * gaps is a dot, so it does not vanish. There is no area and no axis: it is a
 * shape beside a number, scaled to its own range.
 *
 * The value label ends the line, pre-formatted ("+3.4 GB · 7 d"). With no
 * measurement, or no label, it is a mute `?`, never a zero, and no line is
 * drawn: a flat stand-in would read as "nothing added". The whole thing is
 * one `role="img"` whose name is the caller's sentence plus the gap count.
 */
export interface SparklineProps {
  points: readonly HistoryPoint[];
  /** The accessible name: "App added 3.4 GB on Data volume in 7 days". */
  label: string;
  /** Shown after the line: "+3.4 GB · 7 d". Absent reads as "?". */
  valueLabel?: string;
  tone?: Tone;
  width?: number;
  height?: number;
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

export function Sparkline({ points, label, valueLabel, tone = "blue", width = 120, height = 24 }: SparklineProps) {
  const g = sparklineGeometry(points, width, height);
  const known = g.measured > 0 && Boolean(valueLabel);
  const ink = INKS[tone] ?? INKS.blue;
  const gaps = g.gaps ? `, ${g.gaps} gap${g.gaps === 1 ? "" : "s"}` : "";
  const name = g.measured > 0 ? `${label}${gaps}` : `${label}, not measured`;
  const wrap: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, maxWidth: "100%", minWidth: 0 };
  return (
    <span role="img" aria-label={name} style={wrap} data-part="sparkline">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block", flex: "none" }}>
        {g.paths.map((d, i) => (
          <path key={i} data-part="line" d={d} fill="none" stroke={ink} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {g.dots.map((d, i) => (
          <circle key={`d${i}`} data-part="dot" cx={d.x} cy={d.y} r={1.75} fill={ink} />
        ))}
      </svg>
      <span
        aria-hidden="true"
        data-part="value"
        style={{ minWidth: 0, font: `${known ? 500 : 400} 11px/1.2 ${font.mono}`, color: known ? color.ink : color.inkMute, overflowWrap: "anywhere" }}
      >
        {known ? valueLabel : "?"}
      </span>
    </span>
  );
}
