import type { CSSProperties } from "react";

import { accent } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Status semantics, from the design: amber = agent acting or your approval
 * needed, teal = ok or your turn, red = failed, gold = caution, purple =
 * untrusted, neutral = idle or scheduled.
 *
 * `pulse` has no runtime fallback in the source — `p.pulse ? … : undefined` —
 * so an unset dot does NOT breathe, even though `data-props` seeds the editor
 * control at `true`. A `data-props` default is a Storybook arg, never a React
 * default (`runtime-to-react.md` §5), and the distinction matters here: a dot
 * that breathes when nobody asked it to says an agent is working.
 */
export interface StatusDotProps {
  tone?: Tone;
  /** Breathes on the kit's one ambient keyframe. Off unless asked. */
  pulse?: boolean;
  /** Diameter in px, 4-14. */
  size?: number;
}

/** The `mark` role: this is the 4-14px dot the design sizes that step for. */
const TONES: Record<Tone, string> = {
  amber: accent.amber.mark,
  gold: accent.gold.mark,
  teal: accent.teal.mark,
  purple: accent.purple.mark,
  blue: accent.blue.mark,
  red: accent.red.mark,
  neutral: accent.neutral.mark,
};

export function StatusDot(p: StatusDotProps) {
  const s = Number(p.size) || 7;
  const dot: CSSProperties = {
    width: s,
    height: s,
    borderRadius: "50%",
    flex: "none",
    display: "inline-block",
    background: TONES[p.tone || "amber"] || TONES.amber,
    animation: p.pulse ? "breathe 2s ease-in-out infinite" : undefined,
  };
  return <span style={dot} />;
}
