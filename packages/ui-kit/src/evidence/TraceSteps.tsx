import { Fragment } from "react";
import type { CSSProperties } from "react";

import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font } from "../tokens.js";
import type { Tone, TraceState } from "../types.js";

/**
 * The agent's work, shown as fact.
 *
 * `rail` is the evidence behind a decision — "why it stopped" — drawn against a
 * left rule with a glyph per step. `list` is a live tool timeline with
 * durations and tool output, drawn with status dots instead.
 *
 * No interaction states: a trace is a record. Only the `active` step moves, and
 * it moves because the run is moving.
 */
export interface TraceStep {
  state?: TraceState;
  tool: string;
  text?: string;
  time?: string;
  /** Tool output, in its own inset block under the step. */
  output?: string;
}

export interface TraceStepsProps {
  variant?: "rail" | "list";
  steps?: TraceStep[];
}

/** Step colours, which are states rather than tones: done is teal, anything
 * still open is amber, failed is red, skipped is the muted accent. */
const STATES: Record<TraceState, string> = {
  done: accent.teal.ink,
  active: accent.amber.ink,
  paused: accent.amber.ink,
  failed: accent.red.ink,
  skipped: accent.neutral.ink,
};

/** The rail's glyphs. Never colour alone: a monochrome screenshot still parses. */
const MARKS: Record<TraceState, string> = {
  done: "✓",
  active: "▸",
  paused: "⏸",
  failed: "✕",
  skipped: "·",
};

const DOTS: Record<TraceState, Tone> = {
  done: "teal",
  active: "amber",
  paused: "amber",
  failed: "red",
  skipped: "neutral",
};

/** Wave 2 replaced `DataTable`'s and `SearchResultCard`'s brand-carrying
 * fallbacks and missed this one: the source's middle step reads a path naming a
 * plausible real person. Caught by wave 3's package-wide brand grep, and
 * replaced for the same reason as the other two (D19). The consequence is the
 * same as well — this component can no longer be parity-compared on its
 * defaults, because the two sides now render different content by design. */
const FALLBACK: TraceStep[] = [
  { state: "done", tool: "brain_search", text: "found both figures" },
  { state: "done", tool: "Read", text: "knowledge/teiresias-forecast.md" },
  { state: "paused", tool: "Edit", text: "outside the autonomous envelope — checkpointed" },
];

export function TraceSteps(p: TraceStepsProps) {
  const rail = (p.variant || "rail") === "rail";
  const src = p.steps || FALLBACK;

  const box: CSSProperties = rail
    ? {
        borderLeft: `2px solid ${color.edge}`,
        paddingLeft: 11,
        display: "flex",
        flexDirection: "column",
        gap: 7,
        boxSizing: "border-box",
        width: "100%",
      }
    : { display: "flex", flexDirection: "column", gap: 1, boxSizing: "border-box", width: "100%" };

  return (
    <div style={box}>
      {src.map((s, i) => {
        const st = s.state || "done";
        const c = STATES[st] || STATES.done;
        const live = st === "active";
        const rowStyle: CSSProperties = rail
          ? { display: "flex", gap: 6, alignItems: "baseline", font: `400 11.5px/1.5 ${font.body}`, color: color.inkMute }
          : {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 2px",
              font: `400 11px/1.4 ${font.mono}`,
              color: color.inkMute,
            };
        const markerStyle: CSSProperties = { color: c, font: `500 11px/1.4 ${font.mono}`, flex: "none" };
        const toolStyle: CSSProperties = {
          color: rail ? c : live ? color.ink : color.inkDim,
          fontWeight: 500,
          font: rail ? `500 11px/1.5 ${font.mono}` : undefined,
          flex: "none",
        };
        const textStyle: CSSProperties = {
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: rail ? "normal" : "nowrap",
        };
        const outputStyle: CSSProperties = {
          background: color.surface,
          borderRadius: 8,
          padding: "8px 10px",
          margin: "2px 0 4px",
          font: `400 10.5px/1.6 ${font.body}`,
          color: color.inkDim,
        };
        return (
          // A Fragment, not a wrapper div: the output block is a SIBLING of the
          // row in the source, so the rail's `gap` applies to both. A wrapper
          // would make them one flex item and collapse the gap between them.
          <Fragment key={`${s.tool}-${i}`}>
            <div style={rowStyle}>
              {rail ? <span style={markerStyle}>{MARKS[st] || MARKS.done}</span> : null}
              {rail ? null : <StatusDot tone={DOTS[st] || "teal"} pulse={live} size={6} />}
              <b style={toolStyle}>{s.tool}</b>
              <span style={textStyle}>{s.text ? ` ${s.text}` : ""}</span>
              {s.time ? <span style={{ flex: "none", color: color.inkMute }}>{s.time}</span> : null}
            </div>
            {s.output ? <div style={outputStyle}>{s.output}</div> : null}
          </Fragment>
        );
      })}
    </div>
  );
}
