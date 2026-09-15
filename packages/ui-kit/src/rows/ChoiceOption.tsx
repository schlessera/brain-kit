import type { CSSProperties, KeyboardEvent } from "react";

import { focusSibling } from "../internal/roving.js";
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
 *
 * ## The roving tabindex is the caller's, and `tabStop` is how it says so
 *
 * A radio group is meant to be ONE tab stop with ↑↓ inside it. `FilterRow`,
 * `TabBar` and `SideRail` own their whole group and can hold that state
 * themselves ({@link useRoving}); this component cannot — it is a single option
 * and the group is its caller's markup, which is the same fact that stops it
 * rendering the `radiogroup`.
 *
 * So the group owner passes `tabStop`, and {@link AskUserCard} does. When it is
 * omitted the option is a tab stop, which is the status quo and is the only
 * safe default: a component that cannot see its siblings must not assume one of
 * them is reachable, and the failure it would cause — a whole group at
 * `tabIndex={-1}` — is not a group that is harder to reach but one that is
 * **unreachable from the keyboard entirely**.
 *
 * ↑↓ work either way. Arrow navigation uses `focus()`, which does not care
 * about `tabIndex`, so a hand-rolled group that never passes `tabStop` keeps
 * every key the design's table specifies and pays only the extra tab stops.
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
  /**
   * `false` takes this option OUT of the tab order, leaving it reachable by
   * ↑↓ only. Set by whoever renders the `radiogroup`, for exactly one option
   * per group. Omitted means "nobody is running a roving tabindex here", and
   * the option is its own stop.
   */
  tabStop?: boolean;
  radius?: number;
  onClick?: () => void;
  /**
   * Fires when the option takes focus, by Tab or by an arrow key. The group
   * owner uses it to keep `tabStop` on the option the caret is actually on, so
   * that leaving the group and coming back returns you there.
   */
  onFocus?: () => void;
}

/** Scoped to the enclosing group, so two groups on one screen stay separate. */
const GROUP = '[role="radiogroup"]';
const OPTION = '[role="radio"][tabindex]';

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
      focusSibling(event.currentTarget, 1, OPTION, GROUP);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusSibling(event.currentTarget, -1, OPTION, GROUP);
    }
  }

  return (
    <div
      style={box}
      className={act ? "bk-row bk-row-border" : undefined}
      role={act ? "radio" : undefined}
      aria-checked={act ? sel : undefined}
      tabIndex={act ? (p.tabStop === false ? -1 : 0) : undefined}
      onClick={p.onClick}
      onFocus={act ? p.onFocus : undefined}
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
