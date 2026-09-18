import type { CSSProperties, KeyboardEvent } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ToastTone } from "../types.js";

/**
 * The receipt for a named effect.
 *
 * Every button in this kit declares what it will run; this is what confirms it
 * ran, in the same mono vocabulary and with the same effect name. Undo is the
 * point — an effect the user cannot reverse should never have been a one-tap
 * decision. It stays in the transcript rather than floating away, so it is a
 * receipt you can scroll back to.
 *
 * **`aria-live="polite"`** is one of the design's five non-negotiable rules.
 * A receipt appears without the user doing anything to make it appear, so a
 * screen-reader user otherwise learns nothing happened. `polite`, so it waits
 * for a pause rather than cutting across whatever is being read.
 *
 * **Undo's hit target.** The word is text-sized and must be a 44px-tall
 * target, so `theme.css`'s `.bk-undo::before` reaches 16px above and below and
 * 10px either side: **45 x 45.65** from a 25 x 13.65 word. The underline is
 * `text-decoration`, not `border-bottom`, because a border would offset the
 * pseudo-element's containing block and cost the target its last fraction of
 * a pixel — which is exactly how it shipped at 43.65 for three waves
 * (design-feedback §1). It is the only interactive thing in the toast, so it
 * has no neighbour to steal a click from — but it does reach past the toast's
 * own 9px padding, which is a real property of an expanded target and is why
 * a caller must not stack two toasts flush against each other.
 */
export interface InlineToastProps {
  /** The verb. One word where one word will do: "Filed", "Queued". */
  text?: string;
  /** What it happened to. Dim, so the verb reads first. */
  target?: string;
  /** The effect name, in the same vocabulary the button used. */
  effect?: string;
  tone?: ToastTone;
  /** Pass `""` to render no undo. */
  undoLabel?: string;
  /** Breathes, and swaps the glyph to `later`: the effect is still running. */
  pending?: boolean;
  icon?: IconName;
  onUndo?: () => void;
}

const INKS: Record<ToastTone, string> = {
  teal: accent.teal.ink,
  amber: accent.amber.ink,
  purple: accent.purple.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

const BORDERS: Record<ToastTone, string> = {
  teal: token("toast-border-teal"),
  amber: token("toast-border-amber"),
  purple: token("toast-border-purple"),
  red: token("toast-border-red"),
  neutral: token("toast-border-neutral"),
};

const TINTS: Record<ToastTone, string> = {
  teal: token("toast-tint-teal"),
  amber: token("toast-tint-amber"),
  purple: token("toast-tint-purple"),
  red: token("toast-tint-red"),
  neutral: token("toast-tint-neutral"),
};

export function InlineToast(p: InlineToastProps) {
  const tone = p.tone || "teal";
  const ink = INKS[tone] || INKS.teal;
  const border = BORDERS[tone] || BORDERS.teal;
  const tint = TINTS[tone] || TINTS.teal;
  const pending = p.pending === true;
  const undoLabel = p.undoLabel === "" ? null : (p.undoLabel ?? "Undo");
  const act = Boolean(p.onUndo);

  const box: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    boxSizing: "border-box",
    width: "100%",
    border: `1px solid ${border}`,
    background: tint,
    borderRadius: 11,
    padding: "9px 11px",
    animation: pending ? "breathe 2s ease-in-out infinite" : undefined,
  };
  const undoStyle: CSSProperties = {
    flex: "none",
    // Anchors the expanded hit target. See the note at the top.
    position: "relative",
    font: `600 10.5px/1.3 ${font.mono}`,
    color: color.inkDim,
    textDecoration: "underline dotted",
    textDecorationColor: accent.neutral.ink,
    textUnderlineOffset: 3,
    cursor: act ? "pointer" : "default",
    ...({
      "--hv-bg": "transparent",
      "--hv-bd": color.ink,
      "--hv-fg": color.ink,
    } as CSSProperties),
  };

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onUndo?.();
  }

  return (
    <div style={box} aria-live="polite">
      <Icon icon={p.icon || (pending ? "later" : "confirm")} size={14} color={ink} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: `500 11px/1.45 ${font.mono}`,
          color: ink,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {p.text ?? "Filed"}
        {(p.target ?? "life/health/appointments.md") ? (
          <span style={{ marginLeft: 6, color: accent.neutral.ink, fontWeight: 400 }}>
            {p.target ?? "life/health/appointments.md"}
          </span>
        ) : null}
      </span>
      {(p.effect ?? "write_note") ? (
        <span
          style={{
            flex: "none",
            border: `1px solid ${border}`,
            borderRadius: 5,
            padding: "3px 6px",
            font: `600 9px/1.3 ${font.mono}`,
            color: ink,
          }}
        >
          {p.effect ?? "write_note"}
        </span>
      ) : null}
      {undoLabel ? (
        <span
          style={undoStyle}
          className={act ? "bk-control bk-undo" : undefined}
          role={act ? "button" : undefined}
          tabIndex={act ? 0 : undefined}
          onClick={p.onUndo}
          onKeyDown={act ? onKeyDown : undefined}
        >
          {undoLabel}
        </span>
      ) : null}
    </div>
  );
}
