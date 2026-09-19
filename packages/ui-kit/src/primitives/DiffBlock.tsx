import type { CSSProperties } from "react";

import { accent, color, font, token } from "../tokens.js";

/**
 * Machine evidence, monochrome by default — the design's reasoning: "the +/-
 * markers carry the meaning, colour is reserved for whether a human still has
 * to decide something."
 *
 * `inset` sits inside another card (no border, darker than its host);
 * `boxed` stands alone.
 *
 * **`tinted` is for the one case where the diff IS the decision** — a tool
 * receipt whose approval turns on these exact lines (seventh drop, ruling 5).
 * Removed rows take a red ground and added rows a teal ground, at the kit's
 * tint rule on the FILL hue (`--bk-diff-tint-*`), and the sign column takes
 * the tone's INK token at full weight: the sign is the mark, and a 70%-alpha
 * mark is the alpha-ink ban wearing a different hat.
 *
 * A diff row IS the record, so a long line WRAPS with a hanging indent —
 * never truncates, never scrolls sideways. Each row is a flex pair of a fixed
 * 8px sign column and the text, so a wrapped continuation lines up under the
 * text and can never be misread as an unsigned line. Horizontal scroll in a
 * diff hides the half of the line the change is usually in, and an ellipsis
 * in evidence is not evidence.
 */
export interface DiffBlockProps {
  /** Raw diff text; newlines are preserved (`white-space: pre-wrap`). */
  text?: string;
  variant?: "inset" | "boxed";
  /** Colour the removed and added rows. Off by default: colour is reserved
   * for the diff that is itself the decision. */
  tinted?: boolean;
  fontSize?: number;
  pad?: number;
  /** Read by the source's renderVals(), absent from its data-props. */
  radius?: number;
}

type Sign = "-" | "+" | " ";

/** A tinted row's ground and its sign's ink. Context rows have neither. */
const TINT: Record<Sign, { bg: string; fg: string }> = {
  "-": { bg: token("diff-tint-red"), fg: accent.red.ink },
  "+": { bg: token("diff-tint-teal"), fg: accent.teal.ink },
  " ": { bg: "transparent", fg: color.inkMute },
};

/** The rows `tinted` draws, split on newline and signed by first character.
 * Exported for tests; a consumer wanting the same split gets the same rows. */
export function diffRows(text: string): { sign: Sign; text: string }[] {
  return text.split("\n").map((line) => {
    const sign: Sign = line[0] === "-" || line[0] === "+" ? (line[0] as Sign) : " ";
    // A unified diff spells a context line as a blank sign and a separator,
    // so it consumes the same two characters as a signed line does; the
    // design's source consumed one, which indented every context row by a
    // cell. A line with no sign at all is taken whole.
    const body = line[0] === " " || sign !== " " ? line.slice(1) : line;
    return { sign, text: body.replace(/^ /, "") };
  });
}

export function DiffBlock(p: DiffBlockProps) {
  const inset = p.variant === "inset";
  const pad = Number(p.pad) || 10;
  const shell: CSSProperties = {
    margin: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
    background: inset ? token("inset-well-bg") : color.surface,
    border: inset ? "none" : `1px solid ${color.edge}`,
    borderRadius: Number(p.radius) || (inset ? 8 : 11),
    font: `400 ${Number(p.fontSize) || 10.5}px/1.65 ${font.mono}`,
  };
  const text = p.text ?? "- seats: 40\n+ seats: 24";

  if (p.tinted !== true) {
    const box: CSSProperties = { ...shell, padding: pad, color: color.inkMute, whiteSpace: "pre-wrap" };
    return <pre style={box}>{text}</pre>;
  }

  const rowsBox: CSSProperties = { ...shell, padding: `${pad}px 0`, display: "flex", flexDirection: "column" };
  return (
    <div style={rowsBox} data-tinted="">
      {diffRows(text).map((row, i) => {
        const t = TINT[row.sign];
        const rowStyle: CSSProperties = { display: "flex", gap: 8, padding: `1px ${pad}px`, background: t.bg };
        const signStyle: CSSProperties = { flex: "none", width: 8, fontWeight: 600, color: t.fg };
        // Hanging indent: the continuation of a wrapped line sits under the
        // text column, never under the sign.
        const textStyle: CSSProperties = {
          flex: 1,
          minWidth: 0,
          color: row.sign === " " ? color.inkMute : color.inkDim,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        };
        return (
          <div key={i} style={rowStyle} data-sign={row.sign}>
            <span style={signStyle} aria-hidden={row.sign === " " ? true : undefined}>
              {row.sign === " " ? "\u00A0" : row.sign}
            </span>
            <span style={textStyle}>{row.text}</span>
          </div>
        );
      })}
    </div>
  );
}
