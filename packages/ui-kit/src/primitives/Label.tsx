import type { CSSProperties } from "react";

import { Icon, type IconName } from "./Icon.js";
import { color, font } from "../tokens.js";
import type { LabelTone } from "../types.js";
import { valueInk } from "../internal/tone-ink.js";

/**
 * The machine voice. Section headers ("Policies"), kind labels ("Approval") and
 * inline meta lines all come from here so tracking and case never drift.
 *
 * The specimen: 9.5px / 600 / .09em, uppercase, mono, `ink-mute`.
 */
export interface LabelProps {
  text?: string;
  /** Pushed to the far right of the row unless `metaRight` is false. */
  meta?: string;
  icon?: IconName;
  tone?: LabelTone;
  caps?: boolean;
  /** 9-13px. Nothing in the kit goes below 9. */
  size?: number;
  /** Read by the source's renderVals(), absent from its data-props. */
  metaRight?: boolean;
}

export function Label(p: LabelProps) {
  const caps = p.caps !== false;
  const box: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    font: `${caps ? 600 : 500} ${Number(p.size) || 9.5}px/1 ${font.mono}`,
    letterSpacing: caps ? ".09em" : "normal",
    textTransform: caps ? "uppercase" : "none",
    color: valueInk(p.tone || "neutral", "neutral"),
  };
  const metaStyle: CSSProperties = {
    marginLeft: p.metaRight === false ? 0 : "auto",
    textTransform: "none",
    letterSpacing: "normal",
    color: color.inkMute,
    fontWeight: 500,
  };
  return (
    <div style={box}>
      {p.icon ? <Icon icon={p.icon} size={12} /> : null}
      {p.text ?? "Section"}
      {p.meta ? <span style={metaStyle}>{p.meta}</span> : null}
    </div>
  );
}
