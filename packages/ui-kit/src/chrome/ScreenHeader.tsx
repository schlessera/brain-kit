import type { CSSProperties } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font, token } from "../tokens.js";
import type { ScreenHeaderVariant, SubtitleTone, Tone } from "../types.js";

/**
 * Screen chrome, in three shapes.
 *
 * `title` is a destination — a serif display line over a mono status line.
 * `nav` is a pushed detail view: a back chevron and the item's own identity,
 * with a rule under it because something is scrolling beneath. `hero` is a
 * decision screen that opens with a sentence.
 *
 * **The filament belongs to the chat surface only.** It is the one gradient in
 * the kit and it means "this screen is a conversation"; putting it on a list
 * spends the signal.
 */
export interface ScreenHeaderProps {
  title?: string;
  variant?: ScreenHeaderVariant;
  /** The mono status line under the title. */
  subtitle?: string;
  subTone?: SubtitleTone;
  /** A dot before the subtitle. Optional, and unset means no dot. */
  subDot?: Tone;
  subPulse?: boolean;
  /** Counts, right-aligned on the title row. */
  meta?: string;
  metaTone?: "neutral" | "teal";
  /** A sentence under the whole row. `hero`'s reason for existing. */
  description?: string;
  /** A 32px rounded avatar before the title. */
  avatarIcon?: IconName;
  trailingIcon?: IconName;
  /** A breathing dot at the end of the row: something is happening off-screen. */
  trailingDot?: Tone;
  /** `nav` only, and on by default there. */
  back?: boolean;
  /** `nav`'s bottom rule. On by default; `false` removes it. */
  divider?: boolean;
  /** Overrides the per-variant serif size. */
  titleSize?: number;
  /** The chat surface's gradient hairline. */
  filament?: boolean;
}

const TITLE_SIZES: Record<ScreenHeaderVariant, number> = { title: 22, nav: 17, hero: 24 };

const SUB_INKS: Record<SubtitleTone, string> = {
  neutral: color.inkMute,
  teal: accent.teal.ink,
  red: accent.red.ink,
};

export function ScreenHeader(p: ScreenHeaderProps) {
  const v = p.variant || "title";
  const back = v === "nav" && p.back !== false;
  const title = p.title ?? "Actions";

  const wrap: CSSProperties = {
    flex: "none",
    boxSizing: "border-box",
    width: "100%",
    padding: v === "nav" ? "8px 16px 10px" : "8px 20px 12px",
    borderBottom: p.divider !== false && v === "nav" ? `1px solid ${color.line}` : "none",
  };
  const trailWrap: CSSProperties = { marginLeft: p.meta ? 10 : "auto", display: "flex", flex: "none" };

  return (
    <div style={wrap}>
      <div style={{ display: "flex", alignItems: v === "title" ? "baseline" : "center", gap: 10 }}>
        {back ? <Icon icon="back" size={20} color={color.inkMute} /> : null}
        {p.avatarIcon ? (
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 11,
              flex: "none",
              background: color.surface,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: accent.amber.ink,
            }}
          >
            <Icon icon={p.avatarIcon} size={18} />
          </span>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              font: `400 ${Number(p.titleSize) || TITLE_SIZES[v] || 22}px/1.15 ${font.display}`,
              color: color.ink,
            }}
          >
            {title}
          </div>
          {p.subtitle ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                marginTop: 3,
                font: `500 10px/1.4 ${font.mono}`,
                color: SUB_INKS[p.subTone ?? "neutral"] || SUB_INKS.neutral,
              }}
            >
              {p.subDot ? <StatusDot tone={p.subDot} pulse={p.subPulse === true} size={5} /> : null}
              {p.subtitle}
            </div>
          ) : null}
        </div>
        {p.meta ? (
          <span
            style={{
              flex: "none",
              font: `500 10px/1 ${font.mono}`,
              color: p.metaTone === "teal" ? accent.teal.ink : color.inkMute,
            }}
          >
            {p.meta}
          </span>
        ) : null}
        {p.trailingIcon ? (
          <span style={trailWrap}>
            <Icon icon={p.trailingIcon} size={18} color={color.inkMute} />
          </span>
        ) : null}
        {p.trailingDot ? (
          <span style={trailWrap}>
            <StatusDot tone={p.trailingDot} pulse size={8} />
          </span>
        ) : null}
      </div>
      {p.description ? (
        <div style={{ marginTop: 9, font: `400 12.5px/1.6 ${font.body}`, color: color.inkMute }}>{p.description}</div>
      ) : null}
      {p.filament === true ? (
        <div
          style={{
            height: 1,
            marginTop: 10,
            background: `linear-gradient(to right,transparent 0%,${token("filament-edge")} 30%,${token("filament-core")} 50%,${token("filament-edge")} 70%,transparent 100%)`,
            opacity: 0.7,
          }}
        />
      ) : null}
    </div>
  );
}
