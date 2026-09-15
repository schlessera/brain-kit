import type { CSSProperties } from "react";

import { color, font, token } from "../tokens.js";

/**
 * Machine evidence, monochrome on purpose — the design's reasoning: "the +/-
 * markers carry the meaning, colour is reserved for whether a human still has
 * to decide something."
 *
 * `inset` sits inside another card (no border, darker than its host);
 * `boxed` stands alone.
 */
export interface DiffBlockProps {
  /** Raw diff text; newlines are preserved (`white-space: pre-wrap`). */
  text?: string;
  variant?: "inset" | "boxed";
  fontSize?: number;
  pad?: number;
  /** Read by the source's renderVals(), absent from its data-props. */
  radius?: number;
}

export function DiffBlock(p: DiffBlockProps) {
  const inset = p.variant === "inset";
  const box: CSSProperties = {
    margin: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
    background: inset ? token("inset-well-bg") : color.surface,
    border: inset ? "none" : `1px solid ${color.edge}`,
    borderRadius: Number(p.radius) || (inset ? 8 : 11),
    padding: Number(p.pad) || 10,
    font: `400 ${Number(p.fontSize) || 10.5}px/1.65 ${font.mono}`,
    color: color.inkMute,
    whiteSpace: "pre-wrap",
  };
  return <pre style={box}>{p.text ?? "- seats: 40\n+ seats: 24"}</pre>;
}
