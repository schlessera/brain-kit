import type { CSSProperties } from "react";

import { DiffBlock } from "../primitives/DiffBlock.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * "Capability you'd grant", hash comparisons, provenance blocks — any list of
 * machine facts the user is being asked to trust. Rows are key/value, never
 * prose, and the footnote is the load-bearing part: it is where the scope of
 * the grant is stated.
 *
 * No interaction states: a receipt is evidence, not a control. The design gives
 * it none and none are invented.
 */
export interface ReceiptRow {
  k: string;
  v: string;
  tone?: Tone;
}

export interface ReceiptProps {
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
  /** Key column width, 40-90. */
  keyWidth?: number;
  radius?: number;
}

/**
 * Receipt's own tone table, and it is NOT the shared one: its `neutral` is dim
 * ink rather than the neutral accent, because a receipt's unremarkable values
 * are still values to read, not labels to skim past. Ported as written.
 */
const TONES: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: color.inkDim,
};

/* The source's table also carries a `muted` entry that nothing reads — its key
 * column spells the same colour inline. Dead in the source, so not ported. */

const FALLBACK: ReceiptRow[] = [
  { k: "tool", v: "Edit" },
  { k: "path", v: "talks/lisbon-2026.md", tone: "teal" },
];

export function Receipt(p: ReceiptProps) {
  const rows = p.rows || FALLBACK;
  const title = p.title ?? "Capability you'd grant";
  const footnote = p.footnote ?? "this file only · this run only · not a standing grant";

  const box: CSSProperties = {
    border: `1px solid ${color.edge}`,
    background: color.surface,
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
  const rowStyle: CSSProperties = { display: "flex", gap: 10, padding: "8px 12px", font: `500 11px/1.5 ${font.mono}` };
  const keyStyle: CSSProperties = { width: Number(p.keyWidth) || 56, flex: "none", color: color.inkMute };
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
      {rows.map((row, i) => (
        <div key={`${row.k}-${i}`} style={rowStyle}>
          <span style={keyStyle}>{row.k}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              wordBreak: "break-all",
              color: TONES[row.tone || "neutral"] || TONES.neutral,
              fontWeight: 500,
            }}
          >
            {row.v}
          </span>
        </div>
      ))}
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
