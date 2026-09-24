import type { CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { warnOnce } from "../internal/dev.js";
import { VALUE_CUE } from "../internal/tone-cue.js";
import { accent, color, font, token } from "../tokens.js";
import type { DeltaTone, Tone } from "../types.js";

/**
 * A short series — spend per day, runs per day, notes filed per week.
 *
 * Bars rather than a line, because every bar is a real bucket the user can ask
 * about, and the LAST bucket is drawn at full strength since "today" is what
 * they meant. Anything longer than about fourteen buckets belongs on its own
 * screen.
 *
 * **The empty ticks are load-bearing.** An empty label renders as a
 * transparent `·` rather than as nothing, so it still holds its grid slot and
 * every visible label sits under the bucket it names. Deleting the placeholder
 * makes the axis drift by half a bar per missing label — which reads as a
 * chart whose labels are off by one, and is exactly the kind of wrong that
 * survives review.
 *
 * The delta pill's good-or-bad reading was ink and border hue alone, which
 * a grayscale print loses. A red delta now leads with the value map's glyph
 * inside the pill (`internal/tone-cue.ts`, #309); teal draws none, and with
 * only two `DeltaTone`s glyph-or-no-glyph is a complete code. The direction
 * is already the text's sign, the series class is the label's, and the
 * "today" bar is a lightness step that survives grayscale, so those stay.
 */
export interface TrendChartProps {
  /** The uppercase mono line above the number. */
  label?: string;
  /** The number itself, pre-formatted — this component does no arithmetic on
   * the caller's unit. */
  value?: string;
  /** The change pill. Absent means the series has no comparison. */
  delta?: string;
  deltaTone?: DeltaTone;
  /** Raw values in the series' own unit; scaled here against their own max. */
  values?: number[];
  /** One label per bucket. Empty strings are slots, not omissions. */
  ticks?: string[];
  tone?: Tone;
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

const BARS: Record<Tone, string> = {
  amber: token("trend-bar-amber"),
  gold: token("trend-bar-gold"),
  teal: token("trend-bar-teal"),
  purple: token("trend-bar-purple"),
  blue: token("trend-bar-blue"),
  red: token("trend-bar-red"),
  neutral: token("trend-bar-neutral"),
};

export function TrendChart(p: TrendChartProps) {
  if (p.values && !Array.isArray(p.values)) warnOnce("TrendChart: `values` is not an array; the fallback series will draw instead.");
  const tone = p.tone || "purple";
  const ink = INKS[tone] || INKS.purple;
  const bar = BARS[tone] || BARS.purple;

  // The source's fallback series, verbatim — it carries no brand, so it stays.
  const vals = (p.values && p.values.length ? p.values : [0.9, 1.4, 0.6, 2.2, 1.1, 0.4, 1.9]).map(
    Number,
  );
  // The `0.0001` floor keeps an all-zero series from dividing by zero; every
  // bar then draws at the 2px minimum rather than at NaN.
  const max = Math.max(...vals, 0.0001);
  const h = Number(p.height) || 62;
  const ticks = p.ticks || ["Thu", "", "", "Sun", "", "", "Wed"];
  // Two readings and no third: anything but red is the teal pill.
  const deltaTone = p.deltaTone === "red" ? "red" : "teal";
  const deltaCue = VALUE_CUE[deltaTone];

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 14,
    padding: 13,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 11,
  };

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              font: `600 9px/1.2 ${font.mono}`,
              letterSpacing: ".07em",
              textTransform: "uppercase",
              color: accent.neutral.ink,
            }}
          >
            {p.label ?? "Spend · last 7 days"}
          </div>
          <div style={{ marginTop: 5, font: `400 22px/1 ${font.display}`, color: color.ink }}>
            {p.value ?? "$8.50"}
          </div>
        </div>
        {p.delta ? (
          <span
            data-tone={deltaTone}
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
              border: `1px solid ${deltaTone === "red" ? token("chip-border-red") : token("chip-border-teal")}`,
              color: deltaTone === "red" ? accent.red.ink : accent.teal.ink,
              borderRadius: 6,
              padding: "3px 7px",
              font: `500 10px/1.3 ${font.mono}`,
            }}
          >
            {deltaCue ? <Cue icon={deltaCue} size={12} /> : null}
            {p.delta}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 5, alignItems: "flex-end" }}>
        {vals.map((v, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              minWidth: 0,
              height: h,
              display: "flex",
              alignItems: "flex-end",
              background: token("trend-track"),
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                width: "100%",
                height: Math.max(2, Math.round((v / max) * h)),
                background: i === vals.length - 1 ? ink : bar,
              }}
            />
          </span>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: 5,
          font: `400 9px/1 ${font.mono}`,
          color: accent.neutral.ink,
          textAlign: "center",
        }}
      >
        {ticks.map((t, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              minWidth: 0,
              textAlign: "center",
              // See the note at the top: an empty tick is a TRANSPARENT middot,
              // not an empty span. It holds the slot so the axis stays aligned.
              color: t ? undefined : "transparent",
            }}
          >
            {t || "·"}
          </span>
        ))}
      </div>
    </div>
  );
}
