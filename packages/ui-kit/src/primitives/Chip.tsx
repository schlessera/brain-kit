import type { CSSProperties } from "react";

import { Icon, type IconName } from "./Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ChipVariant, Tone } from "../types.js";

/**
 * One chip covers filter pills, effect chips, frontmatter key:value tags,
 * provenance labels, count badges and entity tags. Shape comes from `variant`,
 * meaning from `tone`.
 */
export interface ChipProps {
  label?: string;
  variant?: ChipVariant;
  tone?: Tone;
  /** Semantic key; the glyph inherits the chip's colour. */
  icon?: IconName;
  selected?: boolean;
  /** Uppercase with label tracking. */
  caps?: boolean;
  /** Mono is implied by the `kv`, `effect` and `mono` variants; set true to
   * force it on any other, false to refuse it. */
  mono?: boolean;
  /* Read by the source's renderVals(), absent from its data-props. */
  radius?: number;
  fontSize?: number;
  iconSize?: number;
}

interface ToneSkin {
  fg: string;
  border: string;
  tint: string;
}

/** Chip tints sit at 9-10%, the top of the design's 4-10% range — a chip is a
 * small dense mark. The numbers live in `theme.css`; this table names them. */
const TONES: Record<Tone, ToneSkin> = {
  amber: { fg: accent.amber.ink, border: token("chip-border-amber"), tint: token("chip-tint-amber") },
  gold: { fg: accent.gold.ink, border: token("chip-border-gold"), tint: token("chip-tint-gold") },
  teal: { fg: accent.teal.ink, border: token("chip-border-teal"), tint: token("chip-tint-teal") },
  purple: { fg: accent.purple.ink, border: token("chip-border-purple"), tint: token("chip-tint-purple") },
  blue: { fg: accent.blue.ink, border: token("chip-border-blue"), tint: token("chip-tint-blue") },
  red: { fg: accent.red.ink, border: token("chip-border-red"), tint: token("chip-tint-red") },
  neutral: { fg: accent.neutral.ink, border: token("chip-border-neutral"), tint: token("chip-tint-neutral") },
};

interface Geometry {
  pad: string;
  r: number;
  fs: number;
  fw: number;
}

const GEOMETRY: Partial<Record<ChipVariant, Geometry>> = {
  outline: { pad: "4px 9px", r: 7, fs: 10.5, fw: 500 },
  soft: { pad: "4px 9px", r: 7, fs: 10.5, fw: 500 },
  solid: { pad: "4px 10px", r: 7, fs: 10.5, fw: 600 },
  pill: { pad: "6px 12px", r: 999, fs: 11.5, fw: 500 },
  kv: { pad: "3px 7px", r: 6, fs: 9.5, fw: 500 },
  effect: { pad: "3px 6px", r: 5, fs: 9, fw: 600 },
  mono: { pad: "4px 9px", r: 7, fs: 10.5, fw: 500 },
  count: { pad: "0 4px", r: 999, fs: 9, fw: 600 },
};

const DEFAULT_GEOMETRY: Geometry = { pad: "4px 9px", r: 7, fs: 10.5, fw: 500 };

export function Chip(p: ChipProps) {
  const v = p.variant || "outline";
  const t = TONES[p.tone || "neutral"] || TONES.neutral;
  const mono = p.mono !== false && (v === "kv" || v === "effect" || v === "mono" || p.mono === true);
  const fam = mono ? font.mono : font.body;
  const geo = GEOMETRY[v] || DEFAULT_GEOMETRY;
  const solid = v === "solid" || v === "count";
  const fill = accent[p.tone || "neutral"]?.fill ?? accent.neutral.fill;

  const box: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flex: "none",
    padding: geo.pad,
    borderRadius: Number(p.radius) || geo.r,
    font: `${geo.fw} ${Number(p.fontSize) || geo.fs}px/${v === "count" ? "15px" : "1.35"} ${fam}`,
    letterSpacing: p.caps ? ".07em" : "normal",
    textTransform: p.caps ? "uppercase" : "none",
    whiteSpace: "nowrap",
    // A solid chip is a FILLED surface taking near-black text on it — `on-fill`
    // — and an outline chip is text and takes ink. Identical in the dark
    // theme, different on paper.
    color: solid ? color.onFill : t.fg,
    background: solid ? fill : p.selected || v === "soft" ? t.tint : "transparent",
    border: solid ? "none" : `1px solid ${p.selected ? t.fg : t.border}`,
  };
  // The source mutates `box` after the fact for these two; kept as written so
  // the override order stays visible.
  if (v === "count") {
    box.minWidth = 15;
    box.height = 15;
    box.justifyContent = "center";
    box.color = token("chip-count-ink");
  }
  if (v === "ghost") {
    box.border = "none";
    box.background = "transparent";
  }

  const iconSize = Number(p.iconSize) || (geo.fs > 10 ? 12 : 11);

  return (
    <span style={box}>
      {p.icon ? <Icon icon={p.icon} size={iconSize} /> : null}
      {p.label ?? "chip"}
    </span>
  );
}
