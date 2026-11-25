import type { CSSProperties } from "react";

import { accent, color, font } from "../tokens.js";
import type { HistoryMarker } from "./history-geometry.js";

/**
 * The numbered legend under `HistoryChart` (#4543): one row per event, with
 * the same number as its marker.
 *
 * The chart may merge markers that sit too close into one `2–3` box; this list
 * never does. Every number is listed on its own, so the merged box always
 * resolves to separate rows here.
 *
 * The number is the event's identity. A tone only tints the number's edge, so
 * the meaning never rests on colour: the number and the words carry it.
 * With no events the list renders nothing, rather than an empty list.
 */
export interface EventListProps {
  events: readonly HistoryMarker[];
  /** Names the list for assistive technology, e.g. "Events on this chart". */
  label?: string;
}

const EDGES: Record<NonNullable<HistoryMarker["tone"]>, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: color.inkDim,
};

export function EventList({ events, label = "Events on this chart" }: EventListProps) {
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.n - b.n);
  const list: CSSProperties = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    width: "100%",
    minWidth: 0,
  };
  return (
    <ol aria-label={label} style={list} data-part="event-list">
      {sorted.map((event) => (
        <li
          key={event.n}
          data-event={event.n}
          style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, font: `400 12px/1.45 ${font.body}`, color: color.inkDim }}
        >
          <span
            aria-hidden="true"
            style={{
              flex: "none",
              minWidth: 16,
              boxSizing: "border-box",
              padding: "0 3px",
              textAlign: "center",
              borderRadius: 3,
              boxShadow: `inset 0 0 0 1px ${EDGES[event.tone ?? "neutral"] ?? color.inkDim}`,
              font: `600 10px/16px ${font.mono}`,
              color: color.ink,
            }}
          >
            {event.n}
          </span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <span className="bk-sr-only">{`Event ${event.n}: `}</span>
            {event.time ? <span style={{ color: color.inkMute }}>{event.time} {"·"} </span> : null}
            {event.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
