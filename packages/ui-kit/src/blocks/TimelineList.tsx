import type { CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { warnOnce } from "../internal/dev.js";
import { TIMELINE_CUE } from "../internal/tone-cue.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Chronology inside an answer: what happened, when, in the user's own record.
 *
 * The time column is mono and fixed-width so dates line up, and the mark's
 * tone says what kind of event it was — teal decided, amber agent action, red
 * failure, neutral noted.
 *
 * For the kinds that have one, the mark is the tone's 11px glyph rather than
 * a 7px dot (`internal/tone-cue.ts`, #309), so the kind survives a grayscale
 * print. Noted (`neutral`), blue and untoned events keep the dot: a grey dot
 * is the absence of a claim (D33). Every mark sits in the same 11px gutter,
 * so the connector keeps joining mark to mark and the text column does not
 * shift between a glyph row and a dot row.
 */

/** The gutter's width: the glyph's, which the dot centres in. */
const MARK = 11;

/** The glyph is drawn in the tone's `ink` role; the dot keeps `mark`, the
 * step the design sizes for a 4-14px disc (`StatusDot`). */
const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};
export interface TimelineItem {
  time: string;
  title: string;
  detail?: string;
  meta?: string;
  tone?: Tone;
  /** Breathes. Reserved for the one event still happening. */
  pulse?: boolean;
}

export interface TimelineListProps {
  items?: TimelineItem[];
  /** Width of the mono time column. */
  timeWidth?: number;
}

/** Overnight, the night before the raft goes in the water. */
const FALLBACK: TimelineItem[] = [
  {
    time: "23:10",
    title: "Release order delivered",
    detail: "From the council, by messenger. Acknowledged without argument.",
    tone: "purple",
  },
  { time: "01:40", title: "Wind service unreachable", meta: "3 tries", tone: "red" },
  {
    time: "03:05",
    title: "4 omens filed",
    detail: "Three went to omens/. The fourth has two plausible homes.",
    tone: "teal",
  },
  { time: "06:12", title: "Sailing directions transcribed", tone: "amber", meta: "on device" },
];

export function TimelineList(p: TimelineListProps) {
  if (p.items && !Array.isArray(p.items)) warnOnce("TimelineList: `items` is not an array; no events will render.");
  const tw = Number(p.timeWidth) || 58;
  const src = p.items || FALLBACK;
  const last = src.length - 1;

  const row: CSSProperties = { display: "flex", gap: 10, alignItems: "stretch" };
  const timeStyle: CSSProperties = {
    width: tw,
    flex: "none",
    textAlign: "right",
    paddingTop: 1,
    font: `500 10px/1.5 ${font.mono}`,
    color: accent.neutral.ink,
  };
  const gutter: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flex: "none",
    width: MARK,
    gap: 4,
    paddingTop: 4,
  };
  /** The mark's box, glyph or dot, so the two centre alike on the connector. */
  const markBox: CSSProperties = {
    width: MARK,
    height: MARK,
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
  const connectorStyle: CSSProperties = { flex: 1, width: 1, minHeight: 12, background: color.edge };
  const titleRow: CSSProperties = { display: "flex", alignItems: "baseline", gap: 8 };
  const titleStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    font: `500 12.5px/1.45 ${font.body}`,
    color: color.ink,
  };
  const metaStyle: CSSProperties = {
    flex: "none",
    font: `500 9.5px/1.4 ${font.mono}`,
    color: accent.neutral.ink,
  };
  const detailStyle: CSSProperties = {
    marginTop: 3,
    font: `400 11.5px/1.6 ${font.body}`,
    color: accent.neutral.ink,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", boxSizing: "border-box", width: "100%" }}>
      {src.map((it, i) => {
        const tone = it.tone || "neutral";
        const cue = TIMELINE_CUE[tone];
        // `pulse === true`, not truthiness: a mark that breathes when nobody
        // asked says an agent is working.
        const pulse = it.pulse === true;
        return (
          <div key={i} style={row}>
            <span style={timeStyle}>{it.time}</span>
            <div style={gutter}>
              <span data-tone={tone} style={markBox}>
                {cue ? (
                  <Cue icon={cue} size={MARK} color={INKS[tone] || INKS.neutral} pulse={pulse} />
                ) : (
                  <StatusDot tone={tone} pulse={pulse} size={7} />
                )}
              </span>
              {i !== last ? <span style={connectorStyle} /> : null}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingBottom: i === last ? 0 : 13 }}>
              <div style={titleRow}>
                <span style={titleStyle}>{it.title}</span>
                {it.meta ? <span style={metaStyle}>{it.meta}</span> : null}
              </div>
              {it.detail ? <div style={detailStyle}>{it.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
