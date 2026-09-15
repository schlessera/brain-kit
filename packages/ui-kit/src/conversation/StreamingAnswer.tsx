import type { CSSProperties, KeyboardEvent } from "react";

import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font, token } from "../tokens.js";
import type { StreamPhase } from "../types.js";

/**
 * The answer while it is still arriving.
 *
 * Two things are non-negotiable and both are in the design's own list: the
 * phase line names what is happening RIGHT NOW in the agent's own vocabulary
 * (`brain_search`, `WebFetch`, `drafting answer`), and the cost keeps counting
 * — a run that is spending money says so while it spends it.
 *
 * Partial text streams ABOVE the skeleton so the answer grows downward and
 * never reflows upward, which is what makes a long answer readable while it is
 * still being written.
 *
 * **`aria-live="polite"` on the phase line** is one of the design's five
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
  /** The answer so far. The caret sits at its end. */
  text?: string;
  cost?: string;
  /** Skeleton bars below the partial text, 1-4. */
  lines?: number;
  /** Show the skeleton. On by default. */
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

/** Four widths, cycled, so a skeleton reads as prose rather than as a table. */
const WIDTHS = ["92%", "74%", "58%", "84%"];

export function StreamingAnswer(p: StreamingAnswerProps) {
  const phase = p.phase || "searching";
  const lines = Math.max(1, Number(p.lines) || 3);
  const text = p.text ?? "Three venues are in the corpus. Two have notes from last year";
  const canStop = p.stoppable !== false;
  const act = Boolean(p.onStop);

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
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 11,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      {/* The one live region in the kit. See the note at the top. */}
      <div style={statusRow} aria-live="polite">
        <StatusDot tone="amber" pulse size={6} />
        <span style={{ flex: "none", color: accent.amber.ink, fontWeight: 600 }}>
          {p.phaseLabel || PHASES[phase] || phase}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: accent.neutral.ink,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.target ?? "venues lisbon · 3 of 4 tools done"}
        </span>
        {(p.elapsed ?? "1.4s") ? (
          <span style={{ flex: "none", color: accent.neutral.ink }}>{p.elapsed ?? "1.4s"}</span>
        ) : null}
      </div>
      {text ? (
        <div style={{ font: `400 13.5px/1.7 ${font.body}`, color: color.ink }}>
          {text}
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
        </div>
      ) : null}
      {p.bars !== false ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: lines }).map((_, i) => (
            <span
              key={i}
              style={{
                display: "block",
                height: 9,
                borderRadius: 5,
                width: WIDTHS[i % WIDTHS.length],
                background: color.line,
                animation: "breathe 2s ease-in-out infinite",
                animationDelay: `${(i * 0.18).toFixed(2)}s`,
              }}
            />
          ))}
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
            {p.cost ?? "~$0.03 so far"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
