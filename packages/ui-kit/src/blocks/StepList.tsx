import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { StepListVariant, StepState } from "../types.js";

/**
 * Step-by-step instructions inside a chat answer.
 *
 * `numbered` is a recipe you follow, `checklist` is things to tick off, and
 * `progress` is something being executed for you — where exactly one step is
 * `current` (amber, breathing) and everything above it is `done` (teal).
 *
 * The gutter rail is what makes a long list scannable, and the design says so
 * outright: never drop it for tighter spacing.
 */
export interface Step {
  title: string;
  detail?: string;
  meta?: string;
  /** A mono line under the detail, for a command or a bearing. */
  code?: string;
  state?: StepState;
}

export interface StepListProps {
  steps?: Step[];
  variant?: StepListVariant;
  /** The current step breathes. On by default, unlike `StatusDot`. */
  pulse?: boolean;
}

/**
 * THE SOURCE'S FALLBACK, VERBATIM. Nine of wave 3's twenty components keep the
 * design's own stand-in content because it carries no brand; the other eleven
 * had to be replaced under D19 and can no longer be parity-compared on their
 * defaults. Keeping this one as the source wrote it is what lets the DC parity
 * harness compare this component with no arguments on either side.
 */
const FALLBACK: Step[] = [
  {
    title: "Pull the exercise deck from last year",
    detail: "talks/lisbon-2025 — drop the theory half.",
    state: "done",
  },
  {
    title: "Cut materials to 24 seats",
    detail: "Frontmatter still says 40; print run follows it.",
    state: "current",
    meta: "blocked on you",
  },
  { title: "Confirm power strips with the venue", state: "todo" },
  { title: "Ship the deck", state: "todo", meta: "Sep 7" },
];

export function StepList(p: StepListProps) {
  const v = p.variant || "numbered";
  if (p.steps && !Array.isArray(p.steps)) warnOnce("StepList: `steps` is not an array; no steps will render.");
  // `p.steps || FALLBACK`, exactly as the source spells it: an EMPTY array is
  // truthy, so a caller who passes `[]` gets an empty list rather than the
  // fallback. That distinction is the whole point of a fallback — it stands in
  // for content the component cannot be understood without, not for a list the
  // caller deliberately emptied.
  const src = p.steps || FALLBACK;
  const last = src.length - 1;

  const box: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: "100%",
  };
  const row: CSSProperties = { display: "flex", gap: 11, alignItems: "stretch" };
  const gutter: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flex: "none",
    gap: 5,
  };
  const titleRow: CSSProperties = { display: "flex", alignItems: "baseline", gap: 8 };
  const detailStyle: CSSProperties = {
    marginTop: 3,
    font: `400 11.5px/1.6 ${font.body}`,
    color: color.inkMute,
  };
  const codeStyle: CSSProperties = {
    marginTop: 7,
    background: token("inset-well-bg"),
    border: `1px solid ${color.line}`,
    borderRadius: 8,
    padding: "8px 10px",
    font: `400 10.5px/1.6 ${font.mono}`,
    color: color.inkDim,
    whiteSpace: "pre-wrap",
  };

  return (
    <div style={box}>
      {src.map((s, i) => {
        const st = s.state || "todo";
        const done = st === "done";
        const current = st === "current";
        // Ink: the bubble's number, its border and the meta all read as text.
        const ink = done ? accent.teal.ink : current ? accent.amber.ink : accent.neutral.ink;

        const bubble: CSSProperties = {
          width: 22,
          height: 22,
          borderRadius: "50%",
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: `600 10.5px/1 ${font.mono}`,
          // A solid disc taking near-black ink on top is the `fill` role.
          background: done
            ? accent.teal.fill
            : current
              ? token("step-bubble-tint-current")
              : "transparent",
          border: done ? "none" : `1px solid ${current ? accent.amber.ink : color.edge}`,
          color: done ? color.canvas : ink,
          animation: current && p.pulse !== false ? "breathe 2s ease-in-out infinite" : undefined,
        };
        const connectorStyle: CSSProperties = {
          flex: 1,
          width: 1,
          minHeight: 10,
          background: done ? token("step-rail-done") : color.edge,
        };
        const titleStyle: CSSProperties = {
          flex: 1,
          minWidth: 0,
          font: `${current ? 600 : done ? 400 : 500} 13px/1.5 ${font.body}`,
          color: done ? color.inkMute : color.ink,
          textDecoration: done && v === "checklist" ? "line-through" : "none",
        };

        return (
          <div key={i} style={row}>
            <div style={gutter}>
              <span style={bubble}>
                {done ? <Icon icon="confirm" size={11} color={color.canvas} /> : null}
                {/* `checklist` numbers nothing: a tick box is not an ordinal. */}
                {!done && v !== "checklist" ? String(i + 1) : null}
              </span>
              {i !== last ? <span style={connectorStyle} /> : null}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingBottom: i === last ? 0 : 14 }}>
              <div style={titleRow}>
                <span style={titleStyle}>{s.title}</span>
                {s.meta ? (
                  <span
                    style={{
                      flex: "none",
                      font: `500 9.5px/1.4 ${font.mono}`,
                      color: current ? accent.amber.ink : accent.neutral.ink,
                    }}
                  >
                    {s.meta}
                  </span>
                ) : null}
              </div>
              {s.detail ? <div style={detailStyle}>{s.detail}</div> : null}
              {s.code ? <div style={codeStyle}>{s.code}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
