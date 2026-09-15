import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Chronology inside an answer: what happened, when, in the user's own record.
 *
 * The time column is mono and fixed-width so dates line up, and the dot's tone
 * says what kind of event it was — teal decided, amber agent action, red
 * failure, neutral noted.
 */
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
    gap: 4,
    paddingTop: 4,
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
      {src.map((it, i) => (
        <div key={i} style={row}>
          <span style={timeStyle}>{it.time}</span>
          <div style={gutter}>
            {/* `pulse === true`, not truthiness: a dot that breathes when nobody
                asked says an agent is working. */}
            <StatusDot tone={it.tone || "neutral"} pulse={it.pulse === true} size={7} />
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
      ))}
    </div>
  );
}
