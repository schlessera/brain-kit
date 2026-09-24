import type { CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { warnOnce } from "../internal/dev.js";
import { SCHEDULE_CUE } from "../internal/tone-cue.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

type RailTone = Tone | "edge";

/**
 * Time-of-day agenda inside an answer — appointments, deadlines, scheduled
 * runs.
 *
 * The left rail's colour is the item's claim on you: amber a commitment, red a
 * deadline, teal something the agent will handle, neutral an FYI. A conflict
 * gets the gold tag whatever its rail says, because a clash is a clash.
 *
 * **An UNTONED item draws the `edge` hairline as its rail** — an FYI is a
 * rule, not a grey bar — and its tag border follows, at 40% of that hairline.
 * `neutral` is the grey accent, as everywhere else (D33); before the
 * 2026-09-18 drop this table resolved it to the hairline, ported as found.
 *
 * A 2px rail cannot hold a shape, so the claim also draws as an 11px glyph
 * leading the title (`internal/tone-cue.ts`, #309): a clock for a deadline, a
 * hand for what is yours, the bot for what the agent will handle. The FYI is
 * the unmarked item and gets none; a conflict is already the word.
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

/** The tag's ink: an accent's INK, because a tag is text. The rail below uses
 * the MARK value — the same colour in the dark, a different one on paper,
 * where a 2px rail keeps its hue at the dot value and text needs the ink. */
const TAG_INKS: Record<RailTone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
  edge: color.edge,
};

/** The rail. `edge` is the untoned hairline — see the note above. */
const RAILS: Record<RailTone, string> = {
  amber: accent.amber.mark,
  gold: accent.gold.mark,
  teal: accent.teal.mark,
  purple: accent.purple.mark,
  blue: accent.blue.mark,
  red: accent.red.mark,
  neutral: accent.neutral.mark,
  edge: color.edge,
};

const TAG_BORDERS: Record<RailTone, string> = {
  amber: token("schedule-tag-border-amber"),
  gold: token("schedule-tag-border-gold"),
  teal: token("schedule-tag-border-teal"),
  purple: token("schedule-tag-border-purple"),
  blue: token("schedule-tag-border-blue"),
  red: token("schedule-tag-border-red"),
  neutral: token("schedule-tag-border-accent-neutral"),
  edge: token("schedule-tag-border-neutral"),
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
            const tone: RailTone = it.tone || "edge";
            const rail = RAILS[tone] || RAILS.edge;
            // A conflict is gold whatever the item's own claim on you is.
            const conflict = it.tag === "conflict";
            const tagInk = conflict ? accent.gold.ink : TAG_INKS[tone] || TAG_INKS.edge;
            const tagBorder = conflict ? TAG_BORDERS.gold : TAG_BORDERS[tone] || TAG_BORDERS.edge;
            const cue = tone === "edge" ? null : SCHEDULE_CUE[tone];
            return (
              <div key={i} style={row}>
                <span style={timeStyle}>{it.time}</span>
                <span
                  style={{ width: 2, flex: "none", borderRadius: 99, background: rail }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={titleRow}>
                    <span data-tone={tone} style={titleStyle}>
                      {cue ? <Cue icon={cue} size={11} color={TAG_INKS[tone]} inline /> : null}
                      {it.title}
                    </span>
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
