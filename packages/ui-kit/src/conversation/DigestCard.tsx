import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The briefing as a single chat block — what "What's new?" answers with inside
 * a transcript.
 *
 * Ordered by what it costs the READER: things already settled first, things
 * that still need them last, so the card can be abandoned halfway without
 * missing a decision. The spend sits on the card because a brain that worked
 * overnight spent money doing it, and D20's rule is that a run which spends
 * says so.
 */
export interface DigestItem {
  text: string;
  /** When, or where it landed. Right-aligned mono. */
  meta?: string;
}

export interface DigestGroup {
  label: string;
  icon?: IconName;
  tone?: Tone;
  /** The group's own count, as a string — this card does no arithmetic. */
  count?: string;
  items: DigestItem[];
}

export interface DigestCardProps {
  title?: string;
  /** The window and the run count. */
  subtitle?: string;
  /** What the window cost. */
  spend?: string;
  groups?: DigestGroup[];
  footnote?: string;
  footIcon?: IconName;
  titleSize?: number;
}

const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

/**
 * THE SOURCE'S FALLBACK, VERBATIM. Nine of wave 3's twenty components keep the
 * design's own stand-in content because it carries no brand; the other eleven
 * had to be replaced under D19 and can no longer be parity-compared on their
 * defaults. Keeping this one as the source wrote it is what lets the DC parity
 * harness compare this component with no arguments on either side.
 */
const FALLBACK: DigestGroup[] = [
  {
    label: "Filed",
    icon: "filer",
    tone: "teal",
    count: "6",
    items: [
      { text: "4 shared links, 2 duplicates merged", meta: "23:14" },
      { text: "Dentist moved to Thursday", meta: "life/health" },
    ],
  },
  {
    label: "Failed",
    icon: "failed",
    tone: "red",
    count: "1",
    items: [{ text: "ledger_sync — invoice source unreachable", meta: "3 tries" }],
  },
  {
    label: "Needs you",
    icon: "approval",
    tone: "amber",
    count: "1",
    items: [{ text: "Seat count in lisbon-2026 contradicts your notes", meta: "blocks 1" }],
  },
];

export function DigestCard(p: DigestCardProps) {
  if (p.groups && !Array.isArray(p.groups)) warnOnce("DigestCard: `groups` is not an array; no sections will render.");
  const src = p.groups || FALLBACK;
  const footnote = p.footnote ?? "nothing else needs you · next digest 04:30";

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 14,
    padding: 13,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 11,
  };

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              font: `400 ${Number(p.titleSize) || 18}px/1.2 ${font.display}`,
              color: color.ink,
            }}
          >
            {p.title ?? "While you were away"}
          </div>
          <div
            style={{ marginTop: 4, font: `500 10px/1.4 ${font.mono}`, color: accent.neutral.ink }}
          >
            {p.subtitle ?? "23:00 → 06:40 · 14 runs"}
          </div>
        </div>
        {(p.spend ?? "$0.40") ? (
          <span
            style={{
              flex: "none",
              border: `1px solid ${color.edge}`,
              borderRadius: 7,
              padding: "4px 8px",
              font: `500 10px/1.3 ${font.mono}`,
              color: color.inkDim,
            }}
          >
            {p.spend ?? "$0.40"}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {src.map((g, gi) => {
          const ink = INKS[g.tone || "neutral"] || INKS.neutral;
          return (
            <div
              key={gi}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                paddingTop: 11,
                borderTop: `1px solid ${color.line}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Icon icon={g.icon || "fyi"} size={13} color={ink} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    font: `600 9.5px/1 ${font.mono}`,
                    letterSpacing: ".09em",
                    textTransform: "uppercase",
                    color: ink,
                  }}
                >
                  {g.label}
                </span>
                <span
                  style={{
                    flex: "none",
                    font: `600 10px/1 ${font.mono}`,
                    color: accent.neutral.ink,
                  }}
                >
                  {g.count}
                </span>
              </div>
              {(g.items || []).map((it, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "baseline",
                    // Indented to clear the group's glyph, so the items read as
                    // belonging to the label rather than to the card.
                    paddingLeft: 20,
                    font: `400 11.5px/1.55 ${font.body}`,
                    color: color.inkDim,
                  }}
                >
                  {it.text}
                  {it.meta ? (
                    <span
                      style={{
                        flex: "none",
                        marginLeft: "auto",
                        font: `400 9.5px/1.4 ${font.mono}`,
                        color: accent.neutral.ink,
                      }}
                    >
                      {it.meta}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {footnote ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            paddingTop: 11,
            borderTop: `1px solid ${color.line}`,
            font: `400 10.5px/1.5 ${font.mono}`,
            color: accent.neutral.ink,
          }}
        >
          <Icon icon={p.footIcon || "resolved"} size={12} color={accent.teal.ink} />
          {footnote}
        </div>
      ) : null}
    </div>
  );
}
