import type { CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { VALUE_CUE } from "../internal/tone-cue.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Inline table for model answers. Numbers are always mono and right-aligned; a
 * cell tone is a JUDGEMENT — red = overdue, gold = watch it — never decoration.
 *
 * A judged cell also draws its tone's glyph inline before the text
 * (`internal/tone-cue.ts`, #309). In a right-aligned column that puts the
 * glyph left of the figure, so the digits keep their right edge; a 44px
 * numeric column holds a three-digit figure plus the glyph (20 + 4 + 11).
 * `neutral` cells get nothing, by D33.
 *
 * No interaction states, no sorting, no selection: the design's table states
 * what was found, and a table you can re-sort is a different component with a
 * different contract.
 *
 * Rendered as flex rows rather than a `<table>`, which is what the source does.
 * That is a real accessibility gap — a screen reader gets no row/column
 * relationships — and it belongs to the a11y wave rather than to this port,
 * because changing the element changes the layout model.
 */
export interface DataTableColumn {
  label: string;
  /** Fixed width in px. Columns without one share the remaining space. */
  w?: number;
  align?: "left" | "right";
}

export interface DataTableCell {
  v: string;
  tone?: Tone;
  mono?: boolean;
  bold?: boolean;
}

export interface DataTableRow {
  cells: DataTableCell[];
}

export interface DataTableProps {
  columns?: DataTableColumn[];
  rows?: DataTableRow[];
}

/** `ink` is not a tone — it is the untoned default, and it is what an untagged
 * cell gets. Every tone that IS a tone reads as ink-role accent. */
const TONES: Record<Tone | "ink", string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
  ink: color.ink,
};

const FALLBACK_COLUMNS: DataTableColumn[] = [
  { label: "Landfall" },
  { label: "Lost", w: 66, align: "right" },
  { label: "Day", w: 54, align: "right" },
];

const FALLBACK_ROWS: DataTableRow[] = [
  { cells: [{ v: "Ismarus", bold: true }, { v: "72", mono: true }, { v: "9", mono: true }] },
  { cells: [{ v: "Laestrygonians", bold: true }, { v: "462", mono: true, tone: "red" }] },
];

export function DataTable(p: DataTableProps) {
  const cols = p.columns || FALLBACK_COLUMNS;
  const src = p.rows || FALLBACK_ROWS;

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 14,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
  };
  const headRow: CSSProperties = {
    display: "flex",
    gap: 8,
    padding: "9px 12px",
    // Two pixels, not one: the head rule is the only thing separating a label
    // row from a data row once the type sizes are this close.
    borderBottom: `2px solid ${color.edge}`,
    font: `600 9.5px/1 ${font.mono}`,
    letterSpacing: ".06em",
    textTransform: "uppercase",
    color: color.inkMute,
  };

  return (
    <div style={box}>
      <div style={headRow}>
        {cols.map((c, i) => (
          <span
            key={`${c.label}-${i}`}
            style={{ width: c.w || undefined, flex: c.w ? "none" : 1, minWidth: 0, textAlign: c.align || "left" }}
          >
            {c.label}
          </span>
        ))}
      </div>
      {src.map((r, ri) => (
        <div
          key={ri}
          style={{
            display: "flex",
            gap: 8,
            padding: "9px 12px",
            borderBottom: ri === src.length - 1 ? "none" : `1px solid ${color.line}`,
            font: `400 11.5px/1.3 ${font.body}`,
          }}
        >
          {r.cells.map((c, i) => {
            const tone = c.tone || "ink";
            const cue = VALUE_CUE[tone];
            return (
              <span
                key={i}
                data-tone={tone}
                style={{
                  width: cols[i]?.w ? cols[i].w : undefined,
                  flex: cols[i]?.w ? "none" : 1,
                  minWidth: 0,
                  textAlign: cols[i]?.align || "left",
                  fontFamily: c.mono ? font.mono : font.body,
                  fontWeight: c.bold ? 600 : 400,
                  color: TONES[tone] || TONES.ink,
                }}
              >
                {cue ? <Cue icon={cue} size={11} inline /> : null}
                {c.v}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
