import type { CSSProperties, KeyboardEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { FeedbackValue } from "../types.js";

/**
 * "Was this right?" — asked about a specific act (a filing, an answer), never
 * about the app. A thumb here is training signal, which is why the question
 * names what it is judging.
 *
 * ── The hit target, which is the whole reason this component is careful ───
 *
 * A thumb is drawn 30x26 and reaches **46x44**: a transparent pseudo-element
 * extends the target 9px above and below and 8px either side of the paint
 * rather than inflating the box (`theme.css`'s `.bk-thumb::before`). Two rules
 * from the design make those numbers true, and both were learned here:
 *
 *   - **The hairline is an inset box-shadow, not a border.** An absolutely
 *     positioned pseudo-element is offset from its containing block's PADDING
 *     box, so a 1px border silently eats 1px of reach per side — which is how
 *     this row shipped at 46x42, under the 44px floor, for three waves
 *     (design-feedback §1). A shadow touches nothing in the box model, so the
 *     stated reach is the real reach.
 *   - **Expansion is constrained per axis.** Per side it must be no more than
 *     half the distance to the nearest interactive neighbour ON THAT AXIS. Only
 *     the horizontal has one: 8px against the `gap: 18` below leaves 2px spare,
 *     and the vertical reaches its full 9px. At the original `gap: 6` the
 *     second thumb's invisible target sits on top of the first thumb's visual
 *     and wins the hit test, because the later sibling wins: **the row
 *     recorded thumbs-down for a thumbs-up.**
 *
 * `FeedbackRow.stories.tsx` asserts the targets with `elementFromPoint` at
 * each thumb's EDGES — centres always pass — and a second story narrows the
 * gap to 10px to prove the assertion has teeth.
 *
 * Both thumbs are gated on their own handler, so a read-only feedback row
 * grows no invisible targets.
 */
export interface FeedbackRowProps {
  /** Names the act being judged. Never "Was this helpful?". */
  question?: string;
  /** The recorded answer. `null` is "not asked yet", not "no". */
  value?: FeedbackValue;
  onUp?: () => void;
  onDown?: () => void;
  /** The gap between the two thumbs. Must stay at or above 2x the 8px
   * horizontal expansion; the design's value is 18. Exposed only so a story
   * can narrow it and prove the hit-target assertion fails. */
  gap?: number;
}

export function FeedbackRow(p: FeedbackRowProps) {
  const v = p.value || null;

  /** 30x26 drawn. `position: relative` is what anchors the expanded target. */
  const pad: CSSProperties = {
    width: 30,
    height: 26,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    position: "relative",
  };

  function keys(fire?: () => void) {
    return (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      fire?.();
    };
  }

  // A selected thumb is a SOLID accent taking `on-fill`, which is the `fill`
  // role; its hairline is the same accent as ink. Hover moves the hairline
  // only (`.bk-thumb:hover` in theme.css reads --hv-bd into the shadow), so
  // --hv-bg and --hv-fg resolve to the rest values.
  function thumb(
    side: "up" | "down",
    on: boolean,
    fillColour: string,
    inkColour: string,
    handler?: () => void,
  ): CSSProperties {
    const act = Boolean(handler);
    return {
      ...pad,
      boxShadow: `inset 0 0 0 1px ${on ? inkColour : color.edge}`,
      background: on ? fillColour : "transparent",
      ...({
        "--hv-bg": on ? fillColour : "transparent",
        "--hv-bd": inkColour,
        "--hv-fg": on ? color.onFill : side === "up" ? accent.teal.ink : accent.neutral.ink,
      } as CSSProperties),
      cursor: act ? "pointer" : "default",
    };
  }

  const up = v === "up";
  const down = v === "down";
  const upAct = Boolean(p.onUp);
  const downAct = Boolean(p.onDown);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: `400 11.5px/1.4 ${font.body}`,
          color: accent.neutral.ink,
        }}
      >
        {p.question ?? "Was this filing right?"}
      </span>
      {/* See the note at the top: this gap is a hit-target constraint, not
          spacing taste. 18 >= 2 x 8, with 2px to spare. */}
      <div style={{ display: "flex", gap: Number(p.gap) || 18, flex: "none" }}>
        <span
          style={thumb("up", up, accent.teal.fill, accent.teal.ink, p.onUp)}
          className={upAct ? "bk-control bk-thumb" : undefined}
          role={upAct ? "button" : undefined}
          tabIndex={upAct ? 0 : undefined}
          aria-label={upAct ? "Yes, that was right" : undefined}
          aria-pressed={upAct ? up : undefined}
          onClick={p.onUp}
          onKeyDown={upAct ? keys(p.onUp) : undefined}
        >
          <Icon icon="up" size={13} color={up ? color.onFill : accent.teal.ink} />
        </span>
        <span
          style={thumb("down", down, accent.red.fill, accent.red.ink, p.onDown)}
          className={downAct ? "bk-control bk-thumb" : undefined}
          role={downAct ? "button" : undefined}
          tabIndex={downAct ? 0 : undefined}
          aria-label={downAct ? "No, that was wrong" : undefined}
          aria-pressed={downAct ? down : undefined}
          onClick={p.onDown}
          onKeyDown={downAct ? keys(p.onDown) : undefined}
        >
          <Icon icon="down" size={13} color={down ? color.onFill : accent.neutral.ink} />
        </span>
      </div>
    </div>
  );
}
