import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { Emphasis, Tone } from "../types.js";

/**
 * The card shell every panel is built on.
 *
 * `emphasis`: hairline = inert container, strong = interactive, bold = needs a
 * decision, dashed = stale or unverified.
 *
 * **Interaction states landed in wave 1b.** `.bk-row`, not `.bk-control`, and
 * this is the component the −2 focus offset was written for: a Surface sets
 * `overflow: hidden`, so a ring at +2 on a Surface inside a Surface is drawn
 * outside the inner box and clipped away entirely. Hover is the tone's tint one
 * step up (`--bk-surface-hover-tint-*`); the border does not move, because it
 * is what carries the tone and D20 forbids a hover that changes what a thing
 * means.
 *
 * `emphasis="strong"` is the design's word for "interactive", but the ROLE is
 * still gated on `onClick` and not on the emphasis: emphasis is paint, a
 * handler is behaviour, and a card that looks tappable without being tappable
 * is the failure the gating rule exists to prevent.
 *
 * The accessible name comes from the card's own contents, which is right for a
 * card that is one target. It also means a caller must not put a button inside
 * an operable Surface — two nested controls have no sane tab order, and axe's
 * `nested-interactive` says so. Compose the other way: an inert Surface holding
 * an operable row.
 */
export interface SurfaceProps {
  tone?: Tone;
  emphasis?: Emphasis;
  /** Turns on the mono/uppercase header row. */
  label?: string;
  labelIcon?: IconName;
  /** Right-aligned in the header row. */
  meta?: string;
  pad?: number;
  radius?: number;
  /** Forces the tone tint on; `bold` implies it. */
  tint?: boolean;
  children?: ReactNode;
  onClick?: () => void;
}

interface ToneSkin {
  fg: string;
  border: string;
  tint: string;
}

/** Surface tints sit at 5-6%, the quiet end of the design's 4-10% range — a
 * card is a large field. Note the neutral row: its "tint" is the plain surface
 * colour and its border is the in-card hairline, not the card edge. Both
 * deliberate, and both resolved in `theme.css` rather than here. */
const TONES: Record<Tone, ToneSkin> = {
  amber: { fg: accent.amber.ink, border: token("surface-border-amber"), tint: token("surface-tint-amber") },
  gold: { fg: accent.gold.ink, border: token("surface-border-gold"), tint: token("surface-tint-gold") },
  teal: { fg: accent.teal.ink, border: token("surface-border-teal"), tint: token("surface-tint-teal") },
  purple: { fg: accent.purple.ink, border: token("surface-border-purple"), tint: token("surface-tint-purple") },
  blue: { fg: accent.blue.ink, border: token("surface-border-blue"), tint: token("surface-tint-blue") },
  red: { fg: accent.red.ink, border: token("surface-border-red"), tint: token("surface-tint-red") },
  neutral: { fg: accent.neutral.ink, border: token("surface-border-neutral"), tint: token("surface-tint-neutral") },
};

/** Hover only. Same seven names as `TONES`, one step up, resolved in
 * `theme.css`. Kept as its own table rather than a fourth field on `ToneSkin`
 * so the rest skin stays exactly what the design drew. */
const HOVER_TINTS: Record<Tone, string> = {
  amber: token("surface-hover-tint-amber"),
  gold: token("surface-hover-tint-gold"),
  teal: token("surface-hover-tint-teal"),
  purple: token("surface-hover-tint-purple"),
  blue: token("surface-hover-tint-blue"),
  red: token("surface-hover-tint-red"),
  neutral: token("surface-hover-tint-neutral"),
};

export function Surface(p: SurfaceProps) {
  const t = TONES[p.tone || "neutral"] || TONES.neutral;
  const em = p.emphasis || "hairline";
  const pad = Number(p.pad ?? 12);
  const radius = Number(p.radius) || 14;
  const toned = Boolean(p.tone && p.tone !== "neutral");
  const tinted = p.tint === true || em === "bold";

  const border =
    em === "none"
      ? "none"
      : em === "bold"
        ? `2px solid ${t.border}`
        : em === "dashed"
          ? `1px dashed ${t.border}`
          : `1px solid ${toned ? t.border : em === "strong" ? color.edge : color.line}`;

  const box: CSSProperties = {
    border,
    borderRadius: radius,
    boxSizing: "border-box",
    background: tinted || toned ? t.tint : color.surface,
    overflow: "hidden",
    flex: "none",
    cursor: p.onClick ? "pointer" : "default",
    // The tone's tint one step up. Neutral resolves to `raised`, which is
    // D20's literal "surface one step up".
    ...({ "--hv-bg": p.onClick ? HOVER_TINTS[p.tone || "neutral"] || HOVER_TINTS.neutral : undefined } as CSSProperties),
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: `${pad}px ${pad}px 0`,
    font: `600 9.5px/1 ${font.mono}`,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    color: toned ? t.fg : color.inkMute,
  };
  const metaStyle: CSSProperties = {
    marginLeft: "auto",
    textTransform: "none",
    letterSpacing: "normal",
    color: color.inkMute,
    fontWeight: 500,
  };
  const body: CSSProperties = { padding: pad, paddingTop: p.label ? 9 : pad };

  const act = Boolean(p.onClick);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      {p.label ? (
        <div style={head}>
          {p.labelIcon ? <Icon icon={p.labelIcon} size={12} color={toned ? t.fg : color.inkMute} /> : null}
          {p.label}
          {p.meta ? <span style={metaStyle}>{p.meta}</span> : null}
        </div>
      ) : null}
      <div style={body}>{p.children ?? null}</div>
    </div>
  );
}
