import type { CSSProperties, KeyboardEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * One candidate answer. Used by ask-user cards, share intake and Choose
 * actions. Selection is teal because the choice belongs to the user, never to
 * the agent.
 *
 * The role is `radio`, not `button`, and that has two consequences the design's
 * key table spells out and this implements:
 *
 *   **↑↓ moves between options, space picks one.** A radio group is a single
 *   tab stop with arrow keys inside it, so the arrows are handled here rather
 *   than by the caller. Navigation is scoped to the nearest
 *   `[role="radiogroup"]` ancestor — `AskUserCard` renders one — and falls back
 *   to this element's own parent, so a bare column of options still works.
 *
 *   **A `radio` needs a `radiogroup` around it to be valid ARIA.** This
 *   component cannot render one: it is a single option and the group is the
 *   caller's. Compose it inside `AskUserCard`, or wrap a hand-rolled list in
 *   `role="radiogroup"` with a label.
 *
 * Everything — role, `aria-checked`, the tab stop, hover and the ring — is
 * gated on a handler. A list of options with no callbacks is a summary of what
 * was chosen, not a control, and reads as one.
 */
export interface ChoiceOptionProps {
  title?: string;
  subtitle?: string;
  selected?: boolean;
  /** Title in mono AND in teal: the source couples the two, because a mono
   * title here is always a path. */
  mono?: boolean;
  /** Set false to drop the radio mark and keep only the text. */
  mark?: boolean;
  italic?: boolean;
  /** Title in muted ink. The design pairs it with `italic` for "Other". */
  dim?: boolean;
  radius?: number;
  onClick?: () => void;
}

/** Walks to the previous or next option inside the group and focuses it. */
function moveFocus(from: HTMLElement, delta: number) {
  const group = from.closest('[role="radiogroup"]') ?? from.parentElement;
  if (!group) return;
  const options = [...group.querySelectorAll<HTMLElement>('[role="radio"][tabindex]')];
  const here = options.indexOf(from);
  if (here === -1 || options.length < 2) return;
  // Wraps, which is what a radio group does: ↓ on the last option returns to
  // the first rather than silently doing nothing.
  options[(here + delta + options.length) % options.length].focus();
}

export function ChoiceOption(p: ChoiceOptionProps) {
  const sel = p.selected === true;
  const mono = p.mono === true;
  const act = Boolean(p.onClick);

  const box: CSSProperties = {
    display: "flex",
    gap: 9,
    alignItems: p.subtitle ? "flex-start" : "center",
    boxSizing: "border-box",
    width: "100%",
    border: `1px solid ${sel ? token("choice-border-selected") : color.edge}`,
    background: sel ? token("choice-tint-selected") : "transparent",
    borderRadius: Number(p.radius) || 11,
    padding: "9px 11px",
    cursor: act ? "pointer" : "default",
    // The selected option does not lift on hover — it is already lit, and the
    // design holds its rest values. A custom property is not in React's
    // CSSProperties, so the two entries are cast.
    ...({
      "--hv-bg": sel ? token("choice-tint-selected") : act ? token("hover-veil-soft") : "transparent",
      "--hv-bd": sel ? token("choice-border-selected") : act ? token("hover-border") : color.edge,
    } as CSSProperties),
  };
  /** The mark is a 16px filled disc taking a near-black glyph: the `fill` role. */
  const mark: CSSProperties = {
    width: 16,
    height: 16,
    borderRadius: "50%",
    flex: "none",
    marginTop: p.subtitle ? 1 : 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: sel ? accent.teal.fill : "transparent",
    border: sel ? "none" : `1px solid ${color.edge}`,
  };
  const textWrap: CSSProperties = { minWidth: 0, flex: 1 };
  const titleStyle: CSSProperties = {
    display: "block",
    font: `600 12.5px/1.3 ${mono ? font.mono : font.body}`,
    color: mono ? accent.teal.ink : p.dim ? color.inkMute : color.ink,
    fontStyle: p.italic ? "italic" : "normal",
  };
  const subStyle: CSSProperties = {
    display: "block",
    marginTop: 4,
    font: `400 11px/1.45 ${font.body}`,
    color: color.inkMute,
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === " ") {
      event.preventDefault();
      p.onClick?.();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(event.currentTarget, 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(event.currentTarget, -1);
    }
  }

  return (
    <div
      style={box}
      className={act ? "bk-row bk-row-border" : undefined}
      role={act ? "radio" : undefined}
      aria-checked={act ? sel : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      {p.mark !== false ? (
        <span style={mark}>{sel ? <Icon icon="confirm" size={10} color={color.canvas} /> : null}</span>
      ) : null}
      <span style={textWrap}>
        <b style={titleStyle}>{p.title ?? "life/health/appointments.md"}</b>
        {p.subtitle ? <span style={subStyle}>{p.subtitle}</span> : null}
      </span>
    </div>
  );
}
