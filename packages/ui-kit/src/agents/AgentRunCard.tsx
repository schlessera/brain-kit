import type { CSSProperties } from "react";

import { Meter } from "../primitives/Meter.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font } from "../tokens.js";
import type { RunState, RunToolState, Tone } from "../types.js";

/**
 * A single agent run.
 *
 * `running` is amber and breathing, `waiting` is teal because it is YOUR turn,
 * `done` is teal and still, `failed` is red. The tool strip is the shortest
 * honest answer to "is real work happening?" — named tools with check marks,
 * never a spinner.
 *
 * **The prop is `agent`, not `name`, and that resolves a real inconsistency in
 * the source.** Its `data-props` block declares `name` while `renderVals()`
 * reads `p.agent`, so the two disagree about what the card is called. `name`
 * was only ever reserved because `<dc-import name="…">` owns that attribute —
 * a DC constraint that does not exist in React — and `renderVals()` is the half
 * that actually renders, so `agent` wins. The design's own prose agrees:
 * "FileRow uses `label`, AgentRunCard uses `agent`".
 */
export interface AgentRunTool {
  label: string;
  state?: RunToolState;
}

export interface AgentRunCardProps {
  /** The agent's functional name. `name` is the design's reserved word. */
  agent?: string;
  state?: RunState;
  /** Steps, tokens, elapsed. Optional — it is a run's receipt, not its point. */
  meta?: string;
  /** The quoted task, in the words it was asked in. */
  task?: string;
  /** 0-100. Pass `null` to draw no meter at all. */
  progress?: number | null;
  tools?: AgentRunTool[];
}

/** State decides the dot, whether it breathes, and the meter's tone. */
const STATES: Record<RunState, { dot: Tone; pulse: boolean; meter: Tone }> = {
  running: { dot: "amber", pulse: true, meter: "amber" },
  waiting: { dot: "teal", pulse: true, meter: "teal" },
  done: { dot: "teal", pulse: false, meter: "teal" },
  failed: { dot: "red", pulse: false, meter: "red" },
  stopped: { dot: "neutral", pulse: false, meter: "neutral" },
};

/** The tool strip's own table. `idle` is the neutral accent — a tool not
 * reached yet is a value in the strip, not muted chrome. */
const TOOL_INK: Record<RunToolState, string> = {
  done: accent.teal.ink,
  active: accent.amber.ink,
  failed: accent.red.ink,
  idle: accent.neutral.ink,
};

/** Never colour alone: each tool state carries its own mark as well. */
const TOOL_MARK: Record<RunToolState, string> = {
  done: "✓ ",
  active: "▸ ",
  failed: "✕ ",
  idle: "",
};

/**
 * Both fallbacks are the source's, verbatim.
 *
 * A runtime fallback is a developer-facing default and a parity anchor, not
 * demo content: it renders only for a consumer who passes no props at all. So
 * D26's test is "would shipping this string name something REAL?", not "is this
 * in-world?" — a real airline or a plausible real person goes, a real city in a
 * task description stays, and this one stays for the same reason the nine wave-3
 * fallbacks mentioning a Lisbon workshop stay. Keeping it is what lets this
 * component be parity-compared on its defaults.
 *
 * The demo world is `stories/` and `fixtures/`, which is where screenshots,
 * website copy and demo videos come from, and which is Odyssey without
 * exception.
 */
const TASK = "\u201CCompare the three Lisbon venues against last year's notes\u201D";
const META = "7 steps \u00b7 41k tok \u00b7 1m 12s";

export function AgentRunCard(p: AgentRunCardProps) {
  const meta = p.meta ?? META;
  const task = p.task ?? TASK;
  const st = p.state || "running";
  const s = STATES[st] || STATES.running;
  const tools = (p.tools || []).map((t) => {
    const state = t.state || "idle";
    return { text: (TOOL_MARK[state] ?? "") + t.label, ink: TOOL_INK[state] || TOOL_INK.idle };
  });

  // `progress: null` and `progress: undefined` both mean "draw no meter"; the
  // source spells them as two cases and they reach the same place.
  //
  // THE SOURCE'S `?? 72` IS DELETED HERE BECAUSE IT CANNOT FIRE. Its
  // `renderVals()` writes `Number(p.progress ?? 72)` beside
  // `showProgress: p.progress !== undefined`, so the fallback is only ever
  // consulted when the prop is defined — dead code that reads as live. The
  // behaviour is unchanged and render parity is unaffected; only the source
  // text is. **Do not "fix" the gate to reach it** without reading
  // `docs/decisions/design-feedback.md` §3: whether a propless card should draw a meter
  // at 72 or no meter at all is a design question, and the answer decides
  // which of the two lines is the defect.
  const showProgress = p.progress !== null && p.progress !== undefined;
  const progress = Number(p.progress);

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 13,
    padding: "11px 12px",
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <StatusDot tone={s.dot} pulse={s.pulse} size={7} />
        <span style={{ font: `600 12.5px/1 ${font.body}`, flex: "none" }}>{p.agent ?? "researcher"}</span>
        {meta ? (
          <span style={{ marginLeft: "auto", font: `500 10px/1 ${font.mono}`, color: color.inkMute }}>{meta}</span>
        ) : null}
      </div>
      {task ? <div style={{ font: `400 11.5px/1.5 ${font.body}`, color: color.inkMute }}>{task}</div> : null}
      {showProgress ? <Meter value={progress} tone={s.meter} variant="bar" height={3} gradient /> : null}
      {tools.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, font: `400 10.5px/1 ${font.mono}` }}>
          {tools.map((t, i) => (
            <span key={i} style={{ color: t.ink, flex: "none" }}>
              {t.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
