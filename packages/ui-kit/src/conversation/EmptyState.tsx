import type { CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ButtonTone, EmptyTone, EmptyVariant } from "../types.js";

/**
 * Screen-level emptiness, where `Placeholder` is card-level.
 *
 * The difference matters: a drained queue inside a list is a row, but an
 * Actions tab with nothing in it is a whole screen, and that screen should
 * read as REASSURANCE rather than absence — "you are caught up", not "no
 * data". `offline` and `first-run` are the same shape because both are states
 * the user can fix.
 *
 * Every variant's copy is a fallback, so a caller can override `title` and
 * `body` without losing the glyph and the tone. The five below are this
 * fixture world's voice and they are NOT the source's: the source's `offline`
 * copy names a real VPN product, which `AGENTS.md` bans outright as personal
 * infrastructure, so this variant could never have shipped verbatim.
 */
export interface EmptyStateProps {
  variant?: EmptyVariant;
  title?: string;
  body?: string;
  /** The quiet mono line under the body — evidence that the emptiness is real. */
  meta?: string;
  primaryLabel?: string;
  primaryIcon?: IconName;
  primaryTone?: ButtonTone;
  secondaryLabel?: string;
  icon?: IconName;
  tone?: EmptyTone;
  /** Vertical centring inside a screen. 0 shrink-wraps. */
  minHeight?: number;
  pad?: number;
  titleSize?: number;
  onPrimary?: () => void;
  onSecondary?: () => void;
}

const INKS: Record<EmptyTone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

const MEDALLION_TINTS: Record<EmptyTone, string> = {
  amber: token("medallion-tint-amber"),
  gold: token("medallion-tint-gold"),
  teal: token("medallion-tint-teal"),
  purple: token("medallion-tint-purple"),
  red: token("medallion-tint-red"),
  neutral: token("medallion-tint-neutral"),
};

const MEDALLION_BORDERS: Record<EmptyTone, string> = {
  amber: token("medallion-border-amber"),
  gold: token("medallion-border-gold"),
  teal: token("medallion-border-teal"),
  purple: token("medallion-border-purple"),
  red: token("medallion-border-red"),
  neutral: token("medallion-border-neutral"),
};

const VARIANTS: Record<EmptyVariant, { icon: IconName; tone: EmptyTone; title: string; body: string }> = {
  caught_up: {
    icon: "resolved",
    tone: "teal",
    title: "Nothing is waiting on you",
    body: "Everything that came in overnight has been filed or answered. Brain keeps working and will escalate here if it gets stuck.",
  },
  "no-results": {
    icon: "search",
    tone: "neutral",
    title: "Nothing in the corpus about that",
    body: "Ten years of this voyage are written down. This is not one of the things in them.",
  },
  // The source's copy for this variant named a real VPN product. Replaced, not
  // paraphrased: the rule in AGENTS.md is about the category, not the wording.
  offline: {
    icon: "wifi",
    tone: "gold",
    title: "No reach to the host",
    body: "The brain is on the other side of an ocean. Reads are served from the last index; anything queued keeps running there.",
  },
  "first-run": {
    icon: "install",
    tone: "amber",
    title: "Nothing indexed yet",
    body: "Point Brain at a folder and it will build the index, then start filing what arrives.",
  },
  quiet: {
    icon: "later",
    tone: "neutral",
    title: "Quiet hours",
    body: "Escalations are held until 08:00. Anything urgent still lands in Actions.",
  },
};

export function EmptyState(p: EmptyStateProps) {
  const v = VARIANTS[p.variant || "caught_up"] || VARIANTS.caught_up;
  const tone = p.tone || v.tone;
  const ink = INKS[tone] || INKS.neutral;

  const box: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    textAlign: "center",
    boxSizing: "border-box",
    width: "100%",
    padding: Number(p.pad ?? 26),
    minHeight: Number(p.minHeight) || 0,
  };

  return (
    <div style={box}>
      <span
        style={{
          width: 56,
          height: 56,
          borderRadius: 19,
          marginBottom: 14,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: MEDALLION_TINTS[tone] || MEDALLION_TINTS.neutral,
          border: `1px solid ${MEDALLION_BORDERS[tone] || MEDALLION_BORDERS.neutral}`,
        }}
      >
        <Icon icon={p.icon || v.icon} size={26} color={ink} />
      </span>
      <div
        style={{ font: `400 ${Number(p.titleSize) || 21}px/1.2 ${font.display}`, color: color.ink }}
      >
        {p.title ?? v.title}
      </div>
      <div
        style={{
          maxWidth: 290,
          marginTop: 6,
          font: `400 12.5px/1.65 ${font.body}`,
          color: accent.neutral.ink,
          textWrap: "pretty",
        }}
      >
        {p.body ?? v.body}
      </div>
      {(p.meta ?? "last escalation 4m ago · 41 resolved this week") ? (
        <div
          style={{ marginTop: 10, font: `500 10px/1.4 ${font.mono}`, color: accent.neutral.ink }}
        >
          {p.meta ?? "last escalation 4m ago · 41 resolved this week"}
        </div>
      ) : null}
      {p.primaryLabel ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <Button
            label={p.primaryLabel}
            tone={p.primaryTone || "ghost"}
            size="md"
            icon={p.primaryIcon}
            center
            block={false}
            onClick={p.onPrimary}
          />
          {p.secondaryLabel ? (
            <Button
              label={p.secondaryLabel}
              tone="quiet"
              size="md"
              center
              block={false}
              onClick={p.onSecondary}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
