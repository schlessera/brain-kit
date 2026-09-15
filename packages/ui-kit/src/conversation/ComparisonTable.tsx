import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Candidates side by side — the other axis from `DataTable`, for when the
 * question is "which one" rather than "how much".
 *
 * One column may be `recommended`, which tints it and says WHY in the
 * footnote. A missing value is an explicit em dash, because a blank cell in a
 * comparison reads as zero. Two or three columns at 390px, never four; D22
 * allows a fourth past 1100px.
 *
 * `neutral` here is the ink ramp, like `StatTiles`: an unremarkable value in a
 * comparison is still a value to read.
 */
export interface ComparisonColumn {
  label: string;
  /** A quiet mono line under the label — provenance, not a second value. */
  note?: string;
  tone?: Tone;
  /** At most one. Tints the whole column and earns the footnote. */
  recommended?: boolean;
}

export type ComparisonCell = string | { v: string; tone?: Tone };

export interface ComparisonRow {
  label: string;
  cells: ComparisonCell[];
}

export interface ComparisonTableProps {
  columns?: ComparisonColumn[];
  rows?: ComparisonRow[];
  /** The top-left cell. Usually empty. */
  corner?: string;
  /** Why the recommendation is the recommendation, stated as a cost. */
  footnote?: string;
  labelWidth?: number;
}

/** Ink for six, PRIMARY ink for `neutral` — see the note above. The source's
 * table also carries a `muted` entry nothing can reach, since `Tone` has no
 * such member; dead in the source, so not ported. */
const TONES: Record<Tone, string> = {
  teal: accent.teal.ink,
  amber: accent.amber.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  gold: accent.gold.ink,
  red: accent.red.ink,
  neutral: color.ink,
};

const FALLBACK_COLUMNS: ComparisonColumn[] = [
  { label: "Pass under Scylla", note: "Circe's advice", tone: "amber", recommended: true },
  { label: "Pass over Charybdis", note: "the other shore", tone: "red" },
];

const FALLBACK_ROWS: ComparisonRow[] = [
  { label: "Losses", cells: [{ v: "6 men", tone: "gold" }, { v: "all hands", tone: "red" }] },
  { label: "Certainty", cells: [{ v: "certain", tone: "red" }, { v: "three times a day", tone: "gold" }] },
  { label: "Ship", cells: [{ v: "survives", tone: "teal" }, { v: "lost", tone: "red" }] },
  { label: "Recoverable", cells: ["no", "no"] },
];

export function ComparisonTable(p: ComparisonTableProps) {
  if (p.columns && !Array.isArray(p.columns)) warnOnce("ComparisonTable: `columns` is not an array; no columns will render.");
  if (p.rows && !Array.isArray(p.rows)) warnOnce("ComparisonTable: `rows` is not an array; no rows will render.");

  const cols = p.columns || FALLBACK_COLUMNS;
  const src = p.rows || FALLBACK_ROWS;
  const recIdx = cols.findIndex((c) => c.recommended);
  const labelWidth = Number(p.labelWidth) || 82;
  const footnote =
    p.footnote ?? "Six men is the price of the ship. The other column has no price, only a chance.";

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 14,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
  };

  return (
    <div style={box}>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          borderBottom: `2px solid ${color.edge}`,
        }}
      >
        <span
          style={{
            width: labelWidth,
            flex: "none",
            padding: "9px 10px",
            font: `600 9px/1.3 ${font.mono}`,
            letterSpacing: ".07em",
            textTransform: "uppercase",
            color: accent.neutral.ink,
          }}
        >
          {p.corner ?? ""}
        </span>
        {cols.map((c, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "9px 8px",
              textAlign: "center",
              font: `600 11px/1.3 ${font.body}`,
              color: TONES[c.tone || "neutral"] || TONES.neutral,
              background: i === recIdx ? token("compare-recommended-head") : "transparent",
              borderLeft: `1px solid ${color.line}`,
            }}
          >
            {c.label}
            {c.note ? (
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  font: `400 9px/1.3 ${font.mono}`,
                  color: accent.neutral.ink,
                  textTransform: "none",
                  fontWeight: 400,
                }}
              >
                {c.note}
              </span>
            ) : null}
          </span>
        ))}
      </div>
      {src.map((r, ri) => (
        <div
          key={ri}
          style={{ display: "flex", alignItems: "stretch", borderTop: `1px solid ${color.line}` }}
        >
          <span
            style={{
              width: labelWidth,
              flex: "none",
              padding: "9px 10px",
              font: `500 10px/1.4 ${font.mono}`,
              color: accent.neutral.ink,
            }}
          >
            {r.label}
          </span>
          {(r.cells || []).map((raw, i) => {
            const cell = typeof raw === "object" && raw !== null ? raw : { v: raw, tone: undefined };
            const isRec = i === recIdx;
            return (
              <span
                key={i}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 8px",
                  textAlign: "center",
                  borderLeft: `1px solid ${color.line}`,
                  background: isRec ? token("compare-recommended-cell") : "transparent",
                  font: `${isRec ? 600 : 500} 11px/1.4 ${font.mono}`,
                  // An untoned cell in the recommended column reads teal; every
                  // other untoned cell reads as plain ink.
                  color: TONES[cell.tone || (isRec ? "teal" : "neutral")] || TONES.neutral,
                }}
              >
                {/* A blank cell in a comparison reads as zero, so absence is
                    stated with an em dash instead. */}
                {cell.v === "" || cell.v === null || cell.v === undefined ? "—" : cell.v}
              </span>
            );
          })}
        </div>
      ))}
      {footnote ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "9px 11px",
            borderTop: `1px solid ${color.line}`,
            font: `400 10.5px/1.5 ${font.body}`,
            color: accent.neutral.ink,
          }}
        >
          <Icon icon="fyi" size={12} />
          {footnote}
        </div>
      ) : null}
    </div>
  );
}
