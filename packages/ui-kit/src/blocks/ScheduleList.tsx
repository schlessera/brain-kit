import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Time-of-day agenda inside an answer — appointments, deadlines, scheduled
 * runs.
 *
 * The left rail's colour is the item's claim on you: amber a commitment, red a
 * deadline, teal something the agent will handle, neutral an FYI. A conflict
 * gets the gold tag whatever its rail says, because a clash is a clash.
 *
 * **One source quirk, ported as found.** This component's tone table resolves
 * `neutral` to the `edge` HAIRLINE rather than to the neutral accent — so an
 * FYI draws a rule, not a grey bar. Its tag border follows, at 40% of that
 * hairline. Every other component in the kit resolves `neutral` to the ink
 * ramp; this one does not, and the difference is deliberate in the source.
 */
export interface ScheduleItem {
  time: string;
  title: string;
  detail?: string;
  /** A small outlined pill. `"conflict"` forces it gold. */
  tag?: string;
  tone?: Tone;
}

export interface ScheduleGroup {
  day: string;
  meta?: string;
  items: ScheduleItem[];
}

export interface ScheduleListProps {
  groups?: ScheduleGroup[];
  /** Width of the mono time column. */
  timeWidth?: number;
}

/** The rail. `neutral` is the hairline — see the note above. */
const RAILS: Record<Tone, string> = {
  amber: accent.amber.mark,
  gold: accent.gold.mark,
  teal: accent.teal.mark,
  purple: accent.purple.mark,
  blue: accent.blue.mark,
  red: accent.red.mark,
  neutral: color.edge,
};

const TAG_BORDERS: Record<Tone, string> = {
  amber: token("schedule-tag-border-amber"),
  gold: token("schedule-tag-border-gold"),
  teal: token("schedule-tag-border-teal"),
  purple: token("schedule-tag-border-purple"),
  blue: token("schedule-tag-border-blue"),
  red: token("schedule-tag-border-red"),
  neutral: token("schedule-tag-border-neutral"),
};

/** The day the raft launches, and the day it is due to make land. */
const FALLBACK: ScheduleGroup[] = [
  {
    day: "Today",
    meta: "3 items",
    items: [
      {
        time: "07:00",
        title: "Launch the raft",
        detail: "Tide turns at seven. Stores aboard, sail bent on.",
        tone: "amber",
      },
      {
        time: "11:00",
        title: "Set the bearing",
        detail: "Great Bear on the left hand. Do not correct at night.",
        tone: "teal",
        tag: "17 days",
      },
    ],
  },
  {
    day: "Landfall window",
    items: [
      { time: "06:00", title: "Scheria, if the forecast holds", tone: "amber", tag: "conflict" },
      { time: "—", title: "Water runs out", detail: "One skin aboard.", tone: "red" },
    ],
  },
];

export function ScheduleList(p: ScheduleListProps) {
  if (p.groups && !Array.isArray(p.groups)) warnOnce("ScheduleList: `groups` is not an array; no days will render.");
  const tw = Number(p.timeWidth) || 48;
  const src = p.groups || FALLBACK;

  const dayRow: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 4,
  };
  const dayStyle: CSSProperties = {
    font: `600 9.5px/1 ${font.mono}`,
    letterSpacing: ".09em",
    textTransform: "uppercase",
    color: accent.neutral.ink,
  };
  const dayMetaStyle: CSSProperties = {
    marginLeft: "auto",
    font: `400 9.5px/1 ${font.mono}`,
    color: accent.neutral.ink,
  };
  const row: CSSProperties = {
    display: "flex",
    gap: 10,
    alignItems: "stretch",
    padding: "7px 0",
  };
  const timeStyle: CSSProperties = {
    width: tw,
    flex: "none",
    textAlign: "right",
    paddingTop: 1,
    font: `500 10.5px/1.5 ${font.mono}`,
    color: accent.neutral.ink,
  };
  const titleRow: CSSProperties = { display: "flex", alignItems: "baseline", gap: 8 };
  const titleStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    font: `500 12.5px/1.45 ${font.body}`,
    color: color.ink,
  };
  const detailStyle: CSSProperties = {
    marginTop: 3,
    font: `400 11px/1.55 ${font.body}`,
    color: accent.neutral.ink,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      {src.map((g, gi) => (
        <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={dayRow}>
            <span style={dayStyle}>{g.day}</span>
            {g.meta ? <span style={dayMetaStyle}>{g.meta}</span> : null}
          </div>
          {(g.items || []).map((it, i) => {
            const tone = it.tone || "neutral";
            const rail = RAILS[tone] || RAILS.neutral;
            // A conflict is gold whatever the item's own claim on you is.
            const conflict = it.tag === "conflict";
            const tagInk = conflict ? accent.gold.ink : rail;
            const tagBorder = conflict ? TAG_BORDERS.gold : TAG_BORDERS[tone] || TAG_BORDERS.neutral;
            return (
              <div key={i} style={row}>
                <span style={timeStyle}>{it.time}</span>
                <span
                  style={{ width: 2, flex: "none", borderRadius: 99, background: rail }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={titleRow}>
                    <span style={titleStyle}>{it.title}</span>
                    {it.tag ? (
                      <span
                        style={{
                          flex: "none",
                          border: `1px solid ${tagBorder}`,
                          color: tagInk,
                          borderRadius: 5,
                          padding: "2px 6px",
                          font: `500 9px/1.4 ${font.mono}`,
                        }}
                      >
                        {it.tag}
                      </span>
                    ) : null}
                  </div>
                  {it.detail ? <div style={detailStyle}>{it.detail}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
