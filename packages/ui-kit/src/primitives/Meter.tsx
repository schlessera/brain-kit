import type { CSSProperties } from "react";

import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Run progress, queue cap pressure, budget spend (normal plus a red reserve
 * segment) and labelled stat rows.
 *
 * "Never used for anything the user can drag — read-only by design."
 */
export interface MeterProps {
  /** 0-100, clamped. */
  value?: number;
  /** 0-100. A second, red segment drawn after the fill. */
  reserve?: number;
  tone?: Tone;
  /** `row` puts the label, track and value on one line; `bar` stacks them. */
  variant?: "bar" | "row";
  label?: string;
  /** Free text, e.g. a spend figure. Rendered verbatim. */
  valueText?: string;
  /** Track height in px, 3-10. */
  height?: number;
  gradient?: boolean;
  /** Label gutter width for the row variant. Stacked labels use the track width. */
  labelWidth?: number;
}

/** The track fill is a solid surface, so every tone takes the `fill` role. */
const TONES: Record<Tone, string> = {
  amber: accent.amber.fill,
  gold: accent.gold.fill,
  teal: accent.teal.fill,
  purple: accent.purple.fill,
  blue: accent.blue.fill,
  red: accent.red.fill,
  neutral: accent.neutral.fill,
};

export function Meter(p: MeterProps) {
  const tone = TONES[p.tone || "teal"] || TONES.teal;
  const h = Number(p.height) || 5;
  const v = Math.max(0, Math.min(100, Number(p.value ?? 40)));
  const res = Number(p.reserve) || 0;
  const row = p.variant === "row";
  // The gradient's second stop is chosen per tone in the source: a lighter teal
  // for teal, gold for everything else. Both stops are tokens.
  const end = p.tone === "teal" ? color.tealLift : accent.gold.fill;
  const grad = p.gradient ? `linear-gradient(to right,${tone},${end})` : tone;

  const wrap: CSSProperties = row
    ? { display: "flex", alignItems: "center", gap: 9, width: "100%" }
    : { display: "flex", flexDirection: "column", gap: 6, width: "100%" };
  const labelStyle: CSSProperties = {
    width: row ? Number(p.labelWidth) || 78 : "100%",
    flex: "none",
    textAlign: row ? "right" : "start",
    ...(!row ? { overflowWrap: "anywhere" as const } : {}),
    font: `400 10px/1 ${font.mono}`,
    color: color.inkMute,
  };
  const track: CSSProperties = {
    display: "flex",
    height: h,
    minHeight: h,
    borderRadius: 99,
    background: color.line,
    overflow: "hidden",
    ...(row ? { flex: 1 } : { flex: "none", width: "100%" }),
  };
  const fill: CSSProperties = { display: "block", width: `${v}%`, height: "100%", background: grad };
  const reserveFill: CSSProperties = { display: "block", width: `${res}%`, height: "100%", background: accent.red.fill };
  const valueStyle: CSSProperties = { flex: "none", font: `500 10px/1 ${font.mono}`, color: color.inkDim };

  return (
    <div style={wrap}>
      {p.label ? <span style={labelStyle}>{p.label}</span> : null}
      <span style={track}>
        <span style={fill} />
        {res > 0 ? <span style={reserveFill} /> : null}
      </span>
      {p.valueText ? <span style={valueStyle}>{p.valueText}</span> : null}
    </div>
  );
}
