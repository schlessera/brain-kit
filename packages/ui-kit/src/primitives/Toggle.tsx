import type { CSSProperties, KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { accent, color, token } from "../tokens.js";
import type { ToggleTone } from "../types.js";

/**
 * A read-and-tap switch. `on` defaults to true (`p.on !== false`), which is the
 * source's fallback, not the editor's default.
 *
 * Two things here are easy to get wrong and are load-bearing.
 *
 * **The hit target is not the visual.** The switch is drawn 38x22 and must be
 * hittable at 44x44, so a transparent pseudo-element extends the target past
 * the paint rather than inflating the box — `theme.css`'s `.bk-switch::before`,
 * reaching 11px above and below and 3px either side. The design's constraint on
 * that: expansion per side must be no more than half the distance to the
 * nearest interactive neighbour, so a column of switches needs at least 22px of
 * vertical gap. Get it wrong and a neighbour's invisible pseudo-element sits on
 * top of this one's visual and takes the click, because the later sibling wins
 * the hit test. `Toggle.stories.tsx` asserts it with `elementFromPoint` at the
 * EDGES of two adjacent switches, which is the only place it fails.
 *
 * **Everything is gated on a handler.** No `onClick` means no class, so no hit
 * expansion, no hover, no focus ring, no role and no tab stop — a decorative
 * switch neither pretends to be operable nor grows an invisible target that
 * could steal a real neighbour's click.
 *
 * **`label` is required once a handler is passed**, and that is net-new: the
 * design draws a switch as pure geometry and gives it no text of any kind, so
 * the ported `role="switch"` arrived with no accessible name and axe failed it
 * (`aria-toggle-field-name`). A switch is the one control whose visual carries
 * no words to fall back on — a button at least has its label — so the name has
 * to be given. It is optional in the type because a decorative switch needs
 * none, and a dev warning covers the combination the type cannot: a handler
 * with no label.
 */
export interface ToggleProps {
  on?: boolean;
  tone?: ToggleTone;
  /** The switch's accessible name — what it switches, not its state, which
   * `aria-checked` already carries. Required in practice whenever `onClick` is
   * passed; see the note above. */
  label?: string;
  /** Points at existing visible text instead, for a switch that sits beside its
   * own label in a row. Wins over `label` when both are given, because a name
   * the user can see beats one only the screen reader hears. */
  labelledBy?: string;
  /** The design's fourth state for every interactive component: dimmed to
   * .45, inert, `aria-disabled`, out of the tab order. Same implementation
   * as `Button`'s. A switch mid-flight (a push subscription being created)
   * is this, not "no handler" — it keeps its role and its name. */
  disabled?: boolean;
  onClick?: () => void;
}

/** The track is a filled surface, so each tone takes the `fill` role. */
const TONES: Record<ToggleTone, string> = {
  amber: accent.amber.fill,
  teal: accent.teal.fill,
  purple: accent.purple.fill,
};

export function Toggle(p: ToggleProps) {
  const on = p.on !== false;
  const interactive = Boolean(p.onClick);
  const disabled = p.disabled === true;
  const named = Boolean(p.labelledBy || p.label);

  if (interactive && !named) {
    warnOnce("Toggle: an operable switch needs `label` or `labelledBy` — role=\"switch\" with no accessible name is unusable and axe fails it.");
  }

  const track: CSSProperties = {
    width: 38,
    height: 22,
    borderRadius: 99,
    position: "relative",
    flex: "none",
    display: "inline-block",
    background: on ? TONES[p.tone || "amber"] || TONES.amber : color.edge,
    cursor: p.onClick ? "pointer" : "default",
    transition: "background .18s ease",
    ...(disabled ? { opacity: 0.45, cursor: "not-allowed", pointerEvents: "none" } : null),
  };
  const knob: CSSProperties = {
    position: "absolute",
    top: 2,
    left: on ? 18 : 2,
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: on ? token("toggle-knob-on") : token("toggle-knob-off"),
    transition: "left .18s ease",
  };

  // The design's key table gives Toggle space, not Enter.
  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <span
      style={track}
      className={interactive ? "bk-switch" : undefined}
      role={interactive ? "switch" : undefined}
      aria-checked={interactive ? on : undefined}
      aria-label={interactive && !p.labelledBy ? p.label : undefined}
      aria-labelledby={interactive ? p.labelledBy : undefined}
      aria-disabled={interactive && disabled ? true : undefined}
      tabIndex={interactive ? (disabled ? -1 : 0) : undefined}
      onClick={disabled ? undefined : p.onClick}
      onKeyDown={interactive && !disabled ? onKeyDown : undefined}
    >
      <span style={knob} />
    </span>
  );
}
