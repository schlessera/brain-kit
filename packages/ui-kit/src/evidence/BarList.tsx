import type { CSSProperties } from "react";

import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * "Where it went" — spend or volume attribution.
 *
 * The bar colour identifies the CLASS of work (purple = T2 agent runs, blue =
 * T1 triage, gold = retries, neutral = housekeeping), so the same palette reads
 * consistently across the budget, activity and digest surfaces. It is not a
 * per-chart choice.
 *
 * No interaction states: a bar list is a reading, not a control.
 */
export interface BarListRow {
  label: string;
  /** 0-100. Clamped, because a percentage that overflows its track draws a
   * bar longer than the thing it is a fraction of. */
  pct: number;
  /** The figure, right-aligned in its own column. */
  value: string;
  tone?: Tone;
}

export interface BarListProps {
  rows?: BarListRow[];
  /** Track width in px, 40-140. */
  barWidth?: number;
  valueWidth?: number;
}

/** A 5px-high bar is a mark, not a field: the `mark` role is the one that
 * survives the light theme at this size. */
const TONES: Record<Tone, string> = {
  amber: accent.amber.mark,
  gold: accent.gold.mark,
  teal: accent.teal.mark,
  purple: accent.purple.mark,
  blue: accent.blue.mark,
  red: accent.red.mark,
  neutral: accent.neutral.mark,
};

/** The source's own fallback, verbatim — it names tiers of work rather than
 * anything of anyone's, so there is nothing here to replace. */
const FALLBACK: BarListRow[] = [
  { label: "T2 agent runs · 14", pct: 82, value: "$3.60", tone: "purple" },
  { label: "T1 triage batches · 9", pct: 16, value: "$0.70", tone: "blue" },
  { label: "retries + redo", pct: 14, value: "$0.60", tone: "gold" },
  { label: "state compaction", pct: 3, value: "$0.10", tone: "neutral" },
];

export function BarList(p: BarListProps) {
  const src = p.rows || FALLBACK;

  const box: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    boxSizing: "border-box",
    width: "100%",
    font: `500 11px/1 ${font.mono}`,
  };
  const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
  const labelStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    color: color.inkDim,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const trackStyle: CSSProperties = {
    width: Number(p.barWidth) || 74,
    flex: "none",
    height: 5,
    borderRadius: 99,
    background: color.line,
    overflow: "hidden",
    display: "block",
  };
  const valueStyle: CSSProperties = {
    width: Number(p.valueWidth) || 44,
    flex: "none",
    textAlign: "right",
    color: color.inkMute,
  };

  return (
    <div style={box}>
      {src.map((r, i) => (
        <div key={`${r.label}-${i}`} style={rowStyle}>
          <span style={labelStyle}>{r.label}</span>
          <span style={trackStyle}>
            <span
              style={{
                display: "block",
                width: `${Math.max(0, Math.min(100, r.pct))}%`,
                height: "100%",
                background: TONES[r.tone || "teal"] || TONES.teal,
              }}
            />
          </span>
          <span style={valueStyle}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
