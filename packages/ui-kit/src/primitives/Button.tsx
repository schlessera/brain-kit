import type { CSSProperties, KeyboardEvent } from "react";

import { Icon, type IconName } from "./Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ButtonTone } from "../types.js";

/**
 * Decision buttons. `effect` is the mono chip naming what the tap actually does
 * (enqueue / snooze / write_policy) — "the design system's rule is: no unnamed
 * effects."
 *
 * Interaction states are ported as designed: hover lifts the same surface one
 * step and never changes the tone, pressed is `translateY(1px)` plus a
 * brightness drop with no colour change, focus is a 2px ink ring at +2 offset,
 * and disabled is dimmed and inert. The rules themselves live in `theme.css`,
 * because a pseudo-class cannot be expressed in a React `style` object; the
 * per-tone hover values reach them as `--hv-bg` / `--hv-bd` / `--hv-fg` on this
 * element's own inline style. Default rest paint also travels as private
 * `--hv-rest-*` values, read by the stylesheet rather than applied inline, so
 * hover can override it. Caller-owned paint stays inline and wins in every
 * state. The design uses that indirection because its
 * template engine compiles a bound hole to an empty rule. React has no such
 * constraint — it is kept anyway, because it is what makes the hover palette
 * tokens like everything else instead of a second stylesheet.
 *
 * **None of it appears unless a handler was passed.** A Button with no
 * `onClick` is not focusable, carries no role, and does not respond to a
 * pointer, so a decorative one never pretends to be pressable. Note the design
 * source sets `role` and `tabIndex` unconditionally; its own README states the
 * handler rule outright and `Toggle` follows it, so this follows the rule.
 *
 * Still a `<div>` rather than a `<button>`, as the source is — with the
 * keyboard activation a `role="button"` obliges, since the design's own table
 * specifies Enter and Space for it.
 */
export interface ButtonProps {
  label?: string;
  tone?: ButtonTone;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  /** The mono chip naming the effect of the tap. */
  effect?: string;
  /** A second, quieter line under the label. */
  subtitle?: string;
  /** Dimmed and inert. The design pairs this with a mono line saying *why*;
   * that line is the caller's `subtitle`, not something this can invent. */
  disabled?: boolean;
  /**
   * Announced as dimmed (`aria-disabled`) but still focusable and still
   * tappable, and painted with no opacity. For a control whose tap must never
   * be a silent no-op: the caller's `onClick` explains what is missing
   * instead of doing nothing. `disabled` wins when both are set.
   */
  ariaDisabled?: boolean;
  /**
   * The accessible name, when the visible label alone does not say what the
   * tap acts on: a list of identical "Approve" buttons is a list of guesses
   * to a screen reader, so a decision bar names each one after its target.
   */
  ariaLabel?: string;
  /** Full width. On by default. */
  block?: boolean;
  /** Centres the content even when `block`. */
  center?: boolean;
  onClick?: () => void;
  /** Read by the source's renderVals(), absent from its data-props. */
  radius?: number;
  /**
   * Merged onto this element's own root, last, so the caller wins.
   *
   * This is the seam wave 1 set aside for host positioning — "the component
   * gains a `style` prop merged onto its own root, never a wrapper" — and the
   * first thing it is needed for is sizing inside a flex row.
   *
   * `block` gives a Button `width: 100%` AND `flex: none`, so two of them in a
   * row each demand the whole row and neither yields. That was harmless under
   * the DC runtime, where the wrapper was the flex item and `width: 100%`
   * resolved against a shrink-to-fit box; dropping the wrapper made it live.
   * A row that wants an even split passes `{ flex: "1 1 0", width: "auto" }`;
   * a row that wants content-sized buttons passes `block={false}` and needs
   * nothing here.
   */
  style?: CSSProperties;
}

interface Skin {
  background: string;
  color: string;
  border: string;
}

const SKINS: Record<ButtonTone, Skin> = {
  // primary and affirm are filled surfaces taking near-black text, so they take
  // the `fill` role; the four outline tones are text, and take `ink`.
  primary: { background: accent.amber.fill, color: color.onFill, border: `1px solid ${token("button-border-primary")}` },
  affirm: { background: accent.teal.fill, color: color.onFill, border: `1px solid ${token("button-border-affirm")}` },
  ghost: { background: "transparent", color: color.inkDim, border: `1px solid ${color.edge}` },
  quiet: { background: "transparent", color: color.inkMute, border: `1px solid ${color.edge}` },
  danger: {
    background: "transparent",
    color: accent.red.ink,
    border: `1px solid ${token("button-border-danger")}`,
  },
  suggest: {
    background: token("button-tint-suggest"),
    color: accent.amber.ink,
    border: `1px solid ${token("button-border-suggest")}`,
  },
};

/**
 * Hover, per tone, as the three custom properties `theme.css` reads.
 *
 * The values are the design's: primary and affirm lift to the next step of
 * their own hue, the two quiet tones lift to `raised` with the hover border,
 * and danger and suggest deepen their own tint. No tone becomes another tone.
 */
// A custom property is not in React's CSSProperties, so each entry is cast.
const HOVERS: Record<ButtonTone, CSSProperties> = {
  primary: {
    "--hv-bg": token("button-hover-bg-primary"),
    "--hv-bd": token("button-hover-border-primary"),
    "--hv-fg": token("button-hover-fg-primary"),
  } as CSSProperties,
  affirm: {
    "--hv-bg": token("button-hover-bg-affirm"),
    "--hv-bd": token("button-hover-border-affirm"),
    "--hv-fg": token("button-hover-fg-affirm"),
  } as CSSProperties,
  ghost: {
    "--hv-bg": token("button-hover-bg-ghost"),
    "--hv-bd": token("button-hover-border-ghost"),
    "--hv-fg": token("button-hover-fg-ghost"),
  } as CSSProperties,
  quiet: {
    "--hv-bg": token("button-hover-bg-quiet"),
    "--hv-bd": token("button-hover-border-quiet"),
    "--hv-fg": token("button-hover-fg-quiet"),
  } as CSSProperties,
  danger: {
    "--hv-bg": token("button-hover-bg-danger"),
    "--hv-bd": token("button-hover-border-danger"),
    "--hv-fg": token("button-hover-fg-danger"),
  } as CSSProperties,
  suggest: {
    "--hv-bg": token("button-hover-bg-suggest"),
    "--hv-bd": token("button-hover-border-suggest"),
    "--hv-fg": token("button-hover-fg-suggest"),
  } as CSSProperties,
};

const PADS = { sm: "6px 12px", md: "9px 13px", lg: "13px 14px" };
const SIZES = { sm: 11.5, md: 12.5, lg: 13.5 };

export function Button(p: ButtonProps) {
  const tone = p.tone || "primary";
  // Note the source's own inconsistency, preserved: `data-props` defaults
  // `size` to "lg" for the editor, while renderVals() falls back to "md". The
  // fallback is the runtime default; "lg" is a story arg.
  const size = p.size || "md";
  const block = p.block !== false;
  const pads = PADS[size] || PADS.md;
  const fs = SIZES[size] || SIZES.md;
  const skin = SKINS[tone] || SKINS.primary;
  const solid = tone === "primary" || tone === "affirm";
  const centred = p.center || !block;
  const disabled = p.disabled === true;
  const interactive = Boolean(p.onClick);

  const box: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    boxSizing: "border-box",
    width: block ? "100%" : "auto",
    // Ported as written, and the ternary is a no-op: `none` and `0 0 auto` are
    // the same computed value. `width` is the whole of what `block` does, which
    // is why two block Buttons in a flex row overflow rather than sharing it.
    flex: block ? "none" : "0 0 auto",
    justifyContent: centred ? "center" : "flex-start",
    padding: pads,
    borderRadius: Number(p.radius) || (size === "lg" ? 14 : size === "sm" ? 9 : 12),
    font: `600 ${fs}px/1.25 ${font.body}`,
    cursor: p.onClick ? "pointer" : "default",
    userSelect: "none",
    ...({
      "--hv-rest-bg": skin.background,
      "--hv-rest-border": skin.border,
      "--hv-rest-fg": skin.color,
    } as CSSProperties),
    ...(HOVERS[tone] || HOVERS.primary),
    ...(disabled ? { opacity: 0.45, cursor: "not-allowed", pointerEvents: "none" } : null),
    ...p.style,
  };
  // `0 1 auto` rather than `none` for the centred case. Both are content-sized
  // when there is room, and they differ only under pressure -- which is exactly
  // when it matters: a centred Button sharing a row (`{ flex: "1 1 0" }`, the
  // even-split seam) is narrower than its own label plus its effect chip at
  // phone width, and `none` made the content spill out of the button's paint on
  // both sides rather than wrap inside it. Wave 5's suggestion card is where
  // that showed up; `minWidth: 0` was already here and was being overridden by
  // the refusal to shrink.
  const labelWrap: CSSProperties = { flex: centred ? "0 1 auto" : 1, minWidth: 0 };
  const subStyle: CSSProperties = {
    display: "block",
    // Weight 500 and opaque on-fill since the fourth drop: the .62-alpha
    // near-black it used to be sat under the floor on every fill (§7).
    font: `500 10.5px/1.4 ${font.body}`,
    color: solid ? token("button-ink-on-solid") : color.inkMute,
    marginTop: 2,
  };
  const effectStyle: CSSProperties = {
    flex: "none",
    borderRadius: 5,
    padding: "3px 6px",
    font: `600 9px/1.3 ${font.mono}`,
    background: solid ? token("button-effect-bg-on-solid") : "transparent",
    border: solid ? "none" : `1px solid ${color.edge}`,
    color: solid ? color.onFill : color.inkMute,
  };

  // A role="button" that cannot be activated from the keyboard is worse than no
  // role at all, and the design's own table specifies Enter and Space here.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      data-bk-button=""
      style={box}
      className={interactive ? "bk-control" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? (disabled ? -1 : 0) : undefined}
      aria-disabled={interactive && (disabled || p.ariaDisabled === true) ? true : undefined}
      aria-label={p.ariaLabel}
      // `pointer-events: none` stops a real pointer, not a programmatic
      // `.click()` or a test's synthetic event — and a disabled button that
      // still fires is worse than one that merely looks dim. Inert means
      // inert: no click, no key, from anywhere.
      onClick={disabled ? undefined : p.onClick}
      onKeyDown={interactive && !disabled ? onKeyDown : undefined}
    >
      {p.icon ? <Icon icon={p.icon} size={size === "lg" ? 18 : 15} /> : null}
      <span style={labelWrap}>
        {p.label ?? "Approve this edit"}
        {p.subtitle ? <span style={subStyle}>{p.subtitle}</span> : null}
      </span>
      {p.effect ? <span style={effectStyle}>{p.effect}</span> : null}
    </div>
  );
}
