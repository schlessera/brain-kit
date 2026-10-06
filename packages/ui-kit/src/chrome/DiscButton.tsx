import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { color, font } from "../tokens.js";

/**
 * The overlay disc: a 32px paint inside a 44px button (D52 §7).
 *
 * It draws exactly three controls, all of them over the transcript: the phone
 * Search disc, New chat below 1280, and scroll-to-latest. It is not for rail
 * rows, pills or chips, which have their own components.
 *
 * **The paint is not the target.** The button is a 44px box; the disc is
 * painted inside it. `anchor="end"` (the default) puts the paint against the
 * box's right edge, so the box reaches 12px left and 6px up and down but not
 * right, and never sits over a classic scrollbar. `anchor="center"` centres
 * the paint, reaching 6px on every side.
 *
 * **Tone is rest ink.** `ink` marks the primary action (New chat); `mute`
 * the secondary one (Search) and the navigation aid (scroll-to-latest). The
 * fill, edge and shadow are the same in both, so the discs read as one family.
 *
 * **The label is the act's name, never its state, effect or cost.** With a
 * pointer hovering or keyboard focus on it, the disc expands leftward into a
 * pill printing `label`. That is the one hover in the family, and it reveals
 * a word the accessible name already carries, so D22's rule holds: anything a
 * user needs to decide (state, effect, cost) must be printed at rest by
 * whatever owns it, not put here. There is no confirmation state: New chat
 * keeps every session's draft (D52 §5), so there is nothing to confirm. The
 * word is `aria-hidden`; `name` is the accessible name in every state. Under
 * `prefers-reduced-motion` the pill opens without a transition.
 *
 * A labelled disc carries no `title`: the expanded word is the same word, and
 * a delayed tooltip would print it twice. An unlabelled one keeps `title` set
 * to `name`, as the scroll disc always had.
 *
 * Positioning is the caller's: pass `style` (for one disc) or put discs in a
 * `DiscRow`, which a caller positions instead.
 */
export interface DiscButtonProps {
  /** The accessible name, in every state. */
  name: string;
  icon: IconName;
  tone?: "ink" | "mute";
  /** The word the disc expands to on hover and keyboard focus. */
  label?: string;
  anchor?: "end" | "center";
  onClick: () => void;
  /** Merged onto the button, last, for host positioning. */
  style?: CSSProperties;
}

export function DiscButton(p: DiscButtonProps) {
  const anchor = p.anchor ?? "end";
  const ink = p.tone === "ink" ? color.ink : color.inkMute;
  const box: CSSProperties = {
    // A button's UA font, border and padding are not the kit's.
    appearance: "none",
    margin: 0,
    border: "none",
    background: "transparent",
    font: "inherit",
    color: ink,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: anchor === "end" ? "flex-end" : "center",
    flex: "none",
    boxSizing: "border-box",
    height: 44,
    minWidth: 44,
    padding: anchor === "end" ? "0 0 0 12px" : "0 6px",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    ...p.style,
  };
  // Geometry, fill, edge and the hover/focus expansion live in `tokens.css`
  // (`.bk-disc`): a pseudo-class cannot be written in a `style` object, and an
  // inline fill or padding would beat the stylesheet's expanded state.
  const paint: CSSProperties = { color: ink };
  return (
    <button
      type="button"
      className="bk-disc"
      data-tone={p.tone ?? "mute"}
      aria-label={p.name}
      title={p.label ? undefined : p.name}
      onClick={p.onClick}
      style={box}
    >
      <span className="bk-disc-paint" style={paint}>
        <Icon icon={p.icon} size={16} color={ink} />
        {p.label ? (
          <span
            className="bk-disc-label"
            aria-hidden="true"
            style={{ font: `500 12px/1 ${font.body}`, color: ink }}
          >
            {p.label}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The right-anchored row the overlay discs share (D52 §8).
 *
 * Children render left to right in DOM order, which is also their tab order:
 * Search before New chat. The row is anchored at its right edge, so when a
 * disc expands into its pill the row grows leftward and pushes the discs
 * before it. Boxes sit edge to edge, so two end-anchored paints are 12px
 * apart and no box covers another's paint: they cannot overlap at any width.
 *
 * `style` is merged last, for host positioning (`position: absolute` and its
 * offsets in the message area).
 */
export interface DiscRowProps {
  /** Names the group for assistive technology. */
  label?: string;
  children?: ReactNode;
  style?: CSSProperties;
}

export function DiscRow(p: DiscRowProps) {
  return (
    <div
      role={p.label ? "group" : undefined}
      aria-label={p.label}
      className="bk-disc-row"
      style={{
        display: "flex",
        flexDirection: "row",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 0,
        ...p.style,
      }}
    >
      {p.children}
    </div>
  );
}
