import type { CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ButtonTone, Tone } from "../types.js";

/**
 * The lock-screen / push surface.
 *
 * The variant encodes the notification policy rather than merely its size:
 * `rich` is an escalation you can act on from the notification, `compact` is a
 * receipt, `dim` has been swept into the digest and no action is possible.
 * Escalations push, choices coalesce, FYIs never push.
 *
 * It is the only component in the kit that renders over something it does not
 * own, which is why its three grounds are translucent and why it is the only
 * one with a backdrop filter.
 *
 * No interaction states on the card. The OS owns the press on a notification,
 * and the buttons inside `rich` bring wave 1's.
 */
export interface NotificationAction {
  label: string;
  tone?: ButtonTone;
  onClick?: () => void;
}

export interface NotificationCardProps {
  variant?: "rich" | "compact" | "dim";
  tone?: Tone;
  /** The sender, as the OS shows it: "Brain · Actions". */
  app?: string;
  time?: string;
  /** The bold first clause. */
  lead?: string;
  /** The rest of the sentence, continuing from `lead`. Carries its own
   * leading separator — the design writes " — 1 approval, 1 choice". */
  body?: string;
  meta?: string;
  icon?: IconName;
  /** `rich` only, in practice. An empty array renders no row. */
  actions?: NotificationAction[];
}

/** The badge is a 30px filled square taking a near-black glyph when solid, so
 * it takes `fill`; unfilled, the glyph is the accent as ink. */
const FILLS: Record<Tone, string> = {
  amber: accent.amber.fill,
  gold: accent.gold.fill,
  teal: accent.teal.fill,
  purple: accent.purple.fill,
  blue: accent.blue.fill,
  red: accent.red.fill,
  neutral: accent.neutral.fill,
};

const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

export function NotificationCard(p: NotificationCardProps) {
  const v = p.variant || "rich";
  const tone = p.tone || "amber";
  const rich = v === "rich";
  const dim = v === "dim";
  const actions = p.actions && p.actions.length ? p.actions : null;

  const box: CSSProperties = {
    display: "flex",
    gap: 11,
    alignItems: rich ? "flex-start" : "center",
    background: rich
      ? token("notification-bg-rich")
      : dim
        ? token("notification-bg-dim")
        : token("notification-bg-compact"),
    border: `1px solid ${rich ? color.edge : color.line}`,
    borderRadius: 18,
    padding: rich ? "12px 13px" : "11px 13px",
    boxSizing: "border-box",
    width: "100%",
    opacity: dim ? 0.8 : 1,
    backdropFilter: "blur(8px)",
  };
  const appIcon: CSSProperties = {
    width: dim ? 26 : 30,
    height: dim ? 26 : 30,
    borderRadius: dim ? 9 : 10,
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: rich ? FILLS[tone] || FILLS.amber : color.raised,
    // The glyph inherits this, which is why `Icon` is given no colour below.
    color: rich ? color.canvas : INKS[tone] || INKS.amber,
  };
  const content: CSSProperties = { flex: 1, minWidth: 0 };
  const titleRow: CSSProperties = { display: "flex", alignItems: "baseline", gap: 6 };
  // No colour: the app name inherits ink from the lock screen, as the source does.
  const appStyle: CSSProperties = { font: `600 12px/1.2 ${font.body}` };
  const timeStyle: CSSProperties = { font: `400 10px/1 ${font.mono}`, color: color.inkMute };
  const bodyStyle: CSSProperties = {
    marginTop: rich ? 3 : 2,
    font: `400 ${rich ? 12.5 : 11.5}px/1.5 ${font.body}`,
    color: color.inkMute,
  };
  const leadStyle: CSSProperties = { color: color.ink, fontWeight: 600 };
  const metaStyle: CSSProperties = { marginTop: 5, font: `400 10px/1.5 ${font.mono}`, color: color.inkMute };
  const actionRow: CSSProperties = { display: "flex", gap: 7, marginTop: 9 };

  return (
    <div style={box}>
      <span style={appIcon}>
        <Icon icon={p.icon || "resolved"} size={dim ? 14 : 17} />
      </span>
      <div style={content}>
        <div style={titleRow}>
          <b style={appStyle}>{p.app ?? "Brain · Actions"}</b>
          {p.time ? <span style={timeStyle}>{p.time}</span> : null}
        </div>
        <div style={bodyStyle}>
          <b style={leadStyle}>{p.lead ?? "3 actions waiting"}</b>
          {p.body ?? " — 1 approval, 1 choice, 1 failed run"}
        </div>
        {p.meta ? <div style={metaStyle}>{p.meta}</div> : null}
        {actions ? (
          <div style={actionRow}>
            {actions.map((a, i) => (
              <Button key={`${a.label}-${i}`} label={a.label} tone={a.tone} size="sm" block={false} onClick={a.onClick} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
