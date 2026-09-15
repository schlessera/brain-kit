import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { CalloutVariant, Tone } from "../types.js";

/**
 * From the design: "accent = editorial aside inside prose, boxed = a standing
 * notice or suggestion, banner = provenance / trust statement (always mono,
 * never inside model prose)."
 */
export interface CalloutProps {
  text?: string;
  tone?: Tone;
  variant?: CalloutVariant;
  icon?: IconName;
  italic?: boolean;
  /** Mono also switches the text to the tone colour — that is the banner look. */
  mono?: boolean;
  /** A small bordered chip pinned to the right edge. */
  trailing?: string;
  children?: ReactNode;
}

interface ToneSkin {
  fg: string;
  border: string;
  tint: string;
}

/** Callout tints sit at 6-8%, between Chip's and Surface's. */
const TONES: Record<Tone, ToneSkin> = {
  amber: { fg: accent.amber.ink, border: token("callout-border-amber"), tint: token("callout-tint-amber") },
  gold: { fg: accent.gold.ink, border: token("callout-border-gold"), tint: token("callout-tint-gold") },
  teal: { fg: accent.teal.ink, border: token("callout-border-teal"), tint: token("callout-tint-teal") },
  purple: { fg: accent.purple.ink, border: token("callout-border-purple"), tint: token("callout-tint-purple") },
  blue: { fg: accent.blue.ink, border: token("callout-border-blue"), tint: token("callout-tint-blue") },
  red: { fg: accent.red.ink, border: token("callout-border-red"), tint: token("callout-tint-red") },
  neutral: { fg: accent.neutral.ink, border: token("callout-border-neutral"), tint: token("callout-tint-neutral") },
};

export function Callout(p: CalloutProps) {
  const t = TONES[p.tone || "amber"] || TONES.amber;
  const v = p.variant || "accent";

  const skins: Record<CalloutVariant, CSSProperties> = {
    accent: {
      borderLeft: `3px solid ${t.fg}`,
      background: t.tint,
      borderRadius: "0 8px 8px 0",
      padding: "9px 12px",
    },
    boxed: { border: `1px solid ${t.border}`, background: t.tint, borderRadius: 12, padding: "10px 12px" },
    banner: { border: `1px solid ${t.border}`, background: t.tint, borderRadius: 11, padding: "9px 11px" },
    plain: { padding: "2px 0" },
  };

  const box: CSSProperties = {
    display: "flex",
    alignItems: v === "accent" ? "flex-start" : "center",
    gap: 9,
    boxSizing: "border-box",
    width: "100%",
    ...(skins[v] || skins.accent),
  };
  const textStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    font: `${p.italic ? "italic " : ""}400 ${p.mono ? 10 : 11.5}px/1.55 ${p.mono ? font.mono : font.body}`,
    color: p.mono ? t.fg : color.inkDim,
  };
  const trailingStyle: CSSProperties = {
    flex: "none",
    border: `1px solid ${t.border}`,
    color: t.fg,
    borderRadius: 5,
    padding: "3px 6px",
    font: `600 9px/1.3 ${font.mono}`,
  };

  return (
    <div style={box}>
      {p.icon ? <Icon icon={p.icon} size={14} color={t.fg} /> : null}
      <span style={textStyle}>
        {p.text ?? ""}
        {p.children ?? null}
      </span>
      {p.trailing ? <span style={trailingStyle}>{p.trailing}</span> : null}
    </div>
  );
}
