import { GhostBand } from "../internal/GhostBand.js";
import type { CSSProperties, KeyboardEvent } from "react";

import { GhostText, INCOMING, useArrival } from "../internal/GhostText.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font, token } from "../tokens.js";
import type { StreamPhase } from "../types.js";

/**
 * The answer while it is still arriving.
 *
 * Two things are non-negotiable and both are in the design's own list: the
 * phase line names what is happening RIGHT NOW in the agent's own vocabulary
 * (`brain_search`, `WebFetch`, `drafting answer`). Identity, elapsed and cost
 * come from the caller; absent facts never inherit prototype examples.
 *
 * Before the first token the answer is ghost text (#1116): `lines` blurred
 * prose lines at the answer's own size, the spectrum sweeping through them.
 * The ghost sits BEHIND the text rather than below it — the first token lands
 * where the ghost was, and the ghost fades out under it over 600ms. The answer
 * still grows downward and never reflows upward. While it streams, its newest
 * ~9 characters settle from 0.2 to full opacity, and keep settling after the
 * last token, so a word arriving reads as arriving rather than as a jump.
 *
 * **`aria-live="polite"` on the phase word** is one of the design's five
 * non-negotiable rules, not a nicety: the phase is the only thing on screen
 * that changes without the user doing anything, so a screen-reader user who
 * cannot see it has no signal that anything is happening. `polite`, not
 * `assertive` — a phase change should not interrupt the answer being read.
 *
 * **Stop became a real control in wave 1b.** Untoned and small, so it takes
 * `.bk-control` with D20's literal values: `raised` background, `#3a3e47`
 * border, ink foreground, ring at +2. Gated on `onStop`, so a transcript
 * replaying a finished run shows the word without offering a tab stop for an
 * action that cannot happen.
 */
export interface StreamingAnswerProps {
  phase?: StreamPhase;
  /** Overrides the phase's own vocabulary word. */
  phaseLabel?: string;
  /** What the phase is acting on, and how far through the tools it is. */
  target?: string;
  elapsed?: string;
  /** Pulse while working; false when waiting for a user decision. */
  pulse?: boolean;
  /** The answer so far. The caret sits at its end. */
  text?: string;
  cost?: string;
  /** Ghost lines before the first token, 1-4. */
  lines?: number;
  /** Show the ghost before the first token, and hold its height while the
   * answer streams. On by default. */
  bars?: boolean;
  /** Show the Stop control. On by default. */
  stoppable?: boolean;
  onStop?: () => void;
}

/** The agent's own word for each phase. Not a user-facing euphemism. */
const PHASES: Record<StreamPhase, string> = {
  thinking: "thinking",
  searching: "brain_search",
  reading: "reading",
  fetching: "WebFetch",
  writing: "drafting answer",
};

/** Four widths, cycled, so the ghost reads as prose rather than as a table. */
const WIDTHS = ["92%", "74%", "58%", "84%"];

/** How many of the newest characters are still settling. */
const TAIL = 9;

export function StreamingAnswer(p: StreamingAnswerProps) {
  const phase = p.phase;
  const lines = Math.max(1, Number(p.lines) || 3);
  const text = p.text ?? "";
  const canStop = p.stoppable !== false;
  const act = Boolean(p.onStop);
  const waiting = p.bars !== false && !text;
  const arriving = useArrival(waiting);
  // Code points, not UTF-16 units, so the tail never splits a character.
  const chars = Array.from(text);
  const split = Math.max(0, chars.length - TAIL);
  const head = chars.slice(0, split).join("");
  const tail = chars.slice(split);

  function onStopKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onStop?.();
  }

  const statusRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    font: `500 11px/1.3 ${font.mono}`,
  };

  return (
    <div
      data-kit-streaming-answer=""
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 11,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      {/* Only phase changes are announced; elapsed ticks and targets are not. */}
      <div style={statusRow}>
        <StatusDot tone="amber" pulse={p.pulse !== false} size={6} />
        <span aria-live="polite" aria-atomic="true" style={{ flex: 1, minWidth: 0, color: accent.amber.ink, fontWeight: 600, overflowWrap: "anywhere" }}>
          {p.phaseLabel || (phase ? PHASES[phase] || phase : "")}
        </span>
        {p.elapsed ? (
          <span data-stream-elapsed="" style={{ flex: "none", color: accent.neutral.ink }}>{p.elapsed}</span>
        ) : null}
      </div>
      {p.target ? <div style={{ ...statusRow, color: accent.neutral.ink, overflowWrap: "anywhere" }}>{p.target}</div> : null}
      {p.bars !== false || text ? (
        <div
          style={{
            position: "relative",
            // While it streams the answer holds at least the ghost's lines, so
            // the first token, which is shorter than the ghost, moves nothing
            // below it; past that height it grows downward.
            minHeight: p.bars !== false ? `${(lines * 1.7).toFixed(2)}em` : undefined,
            font: `400 13.5px/1.7 ${font.body}`,
            color: color.ink,
          }}
          aria-busy={waiting ? true : undefined}
        >
          {waiting || arriving ? (
            <div
              aria-hidden="true"
              className={arriving ? "bk-ghost-out" : undefined}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              {Array.from({ length: lines }).map((_, i) => (
                <div key={i}>
                  <GhostText role="sans" size={13.5} length={160} seed={`answer:${i}`} width={WIDTHS[i % WIDTHS.length]} />
                </div>
              ))}
            </div>
          ) : null}
          <GhostBand loading={waiting} arriving={arriving} />
          {/* Positioned, so the text paints over the ghost that precedes it.
              The first chunk fades in over the same 600ms the ghost fades out
              in; the tail ramp settles the newest characters on top of that. */}
          <span className={arriving ? "bk-ghost-in" : undefined} style={INCOMING}>
            {text ? head : null}
            {text
              ? tail.map((ch, i) => (
                  // Keyed by position in the answer, so a character keeps its
                  // ramp as later tokens push it out of the tail.
                  <span key={split + i} className="bk-ghost-tail">
                    {ch}
                  </span>
                ))
              : null}
            {text ? (
              <span
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 14,
                  marginLeft: 3,
                  verticalAlign: "text-bottom",
                  background: accent.amber.fill,
                  animation: "breathe 2s ease-in-out infinite",
                }}
              />
            ) : null}
          </span>
        </div>
      ) : null}
      {canStop ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              flex: "none",
              border: `1px solid ${color.edge}`,
              borderRadius: 8,
              padding: "5px 11px",
              font: `600 10.5px/1.3 ${font.mono}`,
              color: color.inkDim,
              cursor: act ? "pointer" : "default",
              ...({
                "--hv-bg": color.raised,
                "--hv-bd": token("hover-border"),
                "--hv-fg": color.ink,
              } as CSSProperties),
            }}
            className={act ? "bk-control" : undefined}
            role={act ? "button" : undefined}
            tabIndex={act ? 0 : undefined}
            onClick={p.onStop}
            onKeyDown={act ? onStopKeyDown : undefined}
          >
            Stop
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              font: `400 10px/1.4 ${font.mono}`,
              color: accent.neutral.ink,
            }}
          >
            {p.cost}
          </span>
        </div>
      ) : null}
    </div>
  );
}
