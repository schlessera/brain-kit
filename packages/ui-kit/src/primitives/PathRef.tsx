import type { CSSProperties } from "react";

import { Icon, type IconName } from "./Icon.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Every reference to a thing in the corpus. Colour carries the entity type:
 * teal = file or person, blue = company, purple = project, amber = the thing in
 * focus.
 */
export interface PathRefProps {
  /** The path or name, shown verbatim. */
  text?: string;
  tone?: Tone;
  variant?: "chip" | "inline" | "link" | "plain";
  icon?: IconName;
  /** A dimmer suffix — a line number, a size, a timestamp. */
  meta?: string;
  /** 9-13px. */
  fontSize?: number;
}

/** A PathRef is text and a dotted underline — the `ink` role throughout. */
const TONES: Record<Tone, string> = {
  teal: accent.teal.ink,
  blue: accent.blue.ink,
  purple: accent.purple.ink,
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

export function PathRef(p: PathRefProps) {
  const fg = TONES[p.tone || "teal"] || TONES.teal;
  const v = p.variant || "chip";

  // The source computes a `skins` table and then overrides `link` with a
  // separate expression, so the table's own `link` entry — which builds a
  // malformed colour via `fg.replace('#','rgba(')` — is unreachable. Only the
  // reachable branch is ported.
  const skins: Record<"chip" | "inline" | "plain", CSSProperties> = {
    chip: { border: `1px solid ${color.edge}`, borderRadius: 7, padding: "5px 8px" },
    inline: { wordBreak: "break-all" },
    plain: {},
  };
  const skin: CSSProperties =
    v === "link" ? { borderBottom: `1px dotted ${fg}`, paddingBottom: 1 } : (skins[v] ?? skins.chip);

  const box: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    color: fg,
    font: `500 ${Number(p.fontSize) || 10.5}px/1.3 ${font.mono}`,
    minWidth: 0,
    ...skin,
  };
  const metaStyle: CSSProperties = { marginLeft: 6, color: color.inkMute, fontWeight: 400 };

  return (
    <span style={box}>
      {p.icon ? <Icon icon={p.icon} size={11} /> : null}
      {p.text ?? "talks/lisbon-2026.md"}
      {p.meta ? <span style={metaStyle}>{p.meta}</span> : null}
    </span>
  );
}
