import type { CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { VALUE_CUE } from "../internal/tone-cue.js";
import { DiffBlock } from "../primitives/DiffBlock.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { Tone, ValueTone } from "../types.js";

/**
 * "Capability you'd grant", hash comparisons, provenance blocks — any list of
 * machine facts the user is being asked to trust. Rows are key/value, never
 * prose, and the footnote is the load-bearing part: it is where the scope of
 * the grant is stated.
 *
 * No interaction states: a receipt is evidence, not a control. The design gives
 * it none and none are invented.
 *
 * A judged row draws its tone's glyph leading the value, inline, so the
 * `break-all` behaviour is unchanged (`internal/tone-cue.ts`, #309). The
 * title and scope icons need none: each is already a shape, and the text
 * says what it is. A toned row loses three mono characters to the glyph: in
 * a 320px phone's chat a value fits 25, not 28 (`tests/visual/receipt-value-budget.visual.tsx`).
 */
export interface ReceiptRow {
  k: string;
  v: string;
  tone?: ValueTone;
}

export interface ReceiptProps {
  /** Unboxed rows inside a surface that already supplies its boundary. */
  bare?: boolean;
  /** The uppercase mono header. Omit for a bare row list. */
  title?: string;
  titleIcon?: IconName;
  titleTone?: Tone;
  rows?: ReceiptRow[];
  /** Rendered as an inset `DiffBlock` under the rows. */
  diff?: string;
  /** The scope line. */
  footnote?: string;
  footIcon?: IconName;
  footTone?: Tone;
  /** Key column width, 40-90. The column grows to the widest key, up to 90,
   * and a key longer than 90px wraps inside it. */
  keyWidth?: number;
  radius?: number;
}

/**
 * Every accent's ink plus the two inks. An UNTONED value is dim ink — a
 * receipt's unremarkable values are still values to read, not labels to skim
 * past — and `neutral` is the grey accent, as everywhere else (D33). The
 * source's dead `muted` entry is gone; `dim` is the real member.
 */
const TONES: Record<ValueTone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
  ink: color.ink,
  dim: color.inkDim,
};

/** The documented `keyWidth` range. The upper bound is also the most the
 * column grows to fit a long key. */
const KEY_MIN = 40;
const KEY_MAX = 90;

const FALLBACK: ReceiptRow[] = [
  { k: "tool", v: "Edit" },
  { k: "path", v: "voyage/aeaea-landing.md", tone: "teal" },
];

export function Receipt(p: ReceiptProps) {
  const rows = p.rows || FALLBACK;
  const title = p.title ?? "Capability you'd grant";
  const footnote = p.footnote ?? "this file only · this run only · not a standing grant";
  const keyWidth = Math.min(KEY_MAX, Math.max(KEY_MIN, Number(p.keyWidth) || 56));

  const box: CSSProperties = {
    border: p.bare ? "none" : `1px solid ${color.edge}`,
    background: p.bare ? "transparent" : color.surface,
    borderRadius: Number(p.radius) || 14,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "9px 12px",
    borderBottom: `1px solid ${color.line}`,
    font: `600 9.5px/1 ${font.mono}`,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    color: color.inkMute,
  };
  // One grid for every row, so the key column is sized once (#88): as wide as
  // the widest key, never narrower than `keyWidth` and never wider than 90. A
  // key past 90 wraps inside the column rather than running over the gutter
  // into its value, and is never cut: a receipt row IS the record
  // (`docs/decisions/design-feedback.md`, "where truncation is allowed"). The
  // value column's left edge is the same on every row. When every key fits,
  // the track is exactly `keyWidth` and the geometry is the old flex row's,
  // cell boxes included: its 8px block padding is the grid's padding and half
  // of its 16px row gap.
  const rowsGrid: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `minmax(${keyWidth}px, max-content) minmax(0, 1fr)`,
    gap: "16px 10px",
    padding: p.bare ? "8px 0" : "8px 12px",
    font: `500 11px/1.5 ${font.mono}`,
  };
  const rowStyle: CSSProperties = { display: "contents" };
  const keyStyle: CSSProperties = {
    maxWidth: KEY_MAX,
    minWidth: 0,
    overflowWrap: "anywhere",
    color: color.inkMute,
  };
  const diffWrap: CSSProperties = { padding: "2px 12px 10px" };
  const foot: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "9px 12px",
    borderTop: `1px solid ${color.line}`,
    font: `500 10px/1.45 ${font.mono}`,
    color: color.inkMute,
  };

  return (
    <div style={box}>
      {title ? (
        <div style={head}>
          <Icon icon={p.titleIcon ?? "capability"} size={12} color={TONES[p.titleTone || "amber"]} />
          {title}
        </div>
      ) : null}
      {rows.length ? (
        <div style={rowsGrid}>
          {rows.map((row, i) => {
            const tone = row.tone || "dim";
            const cue = VALUE_CUE[tone];
            return (
              <div key={`${row.k}-${i}`} style={rowStyle}>
                <span style={keyStyle}>{row.k}</span>
                <span
                  data-tone={tone}
                  style={{
                    minWidth: 0,
                    wordBreak: "break-all",
                    color: TONES[tone] || TONES.dim,
                    fontWeight: 500,
                  }}
                >
                  {cue ? <Cue icon={cue} size={11} inline /> : null}
                  {row.v}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {p.diff ? (
        <div style={diffWrap}>
          <DiffBlock text={p.diff} variant="inset" />
        </div>
      ) : null}
      {footnote ? (
        <div style={foot}>
          <Icon icon={p.footIcon ?? "scope"} size={12} color={TONES[p.footTone || "teal"]} />
          {footnote}
        </div>
      ) : null}
    </div>
  );
}
