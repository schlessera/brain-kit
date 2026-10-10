import type { CSSProperties, ReactNode } from "react";

import { IconButton } from "../primitives/IconButton.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { color, font, accent } from "../tokens.js";

/**
 * The modal surface for a single decision: a dismissal reason, a share intake,
 * a snooze picker.
 *
 * `docked` is the positioning switch, and it is the whole component. Docked, the
 * sheet is `position: absolute` against its nearest positioned ancestor — the
 * `PhoneFrame` decorator, in the Storybook — and sits over a dimmed screen.
 * Undocked it is `position: static` and takes part in normal flow, which is how
 * it is documented and how a story shows one without a frame around it.
 *
 * It renders no scrim and traps no focus. Both belong to whatever decides the
 * sheet is open, which this component does not know; it is a surface, and D13
 * keeps surfaces free of state.
 */
export interface BottomSheetProps {
  title?: string;
  /** Id for an overlay’s accessible heading. */
  titleId?: string;
  /** Optional 44px dismissal control; existing surfaces omit it. */
  onDismiss?: () => void;
  closeLabel?: string;
  /** The sentence under the title. Its presence tightens the title's margin. */
  subtitle?: string;
  /** Mono, right-aligned on the title row. */
  meta?: string;
  icon?: IconName;
  /** Absolutely positioned over a screen, rather than in flow. */
  docked?: boolean;
  /** Overrides the serif title size. */
  titleSize?: number;
  children?: ReactNode;
}

export function BottomSheet(p: BottomSheetProps) {
  const sheet: CSSProperties = {
    position: p.docked === true ? "absolute" : "static",
    left: 0,
    right: 0,
    bottom: 0,
    background: color.surface,
    borderTop: `1px solid ${color.edge}`,
    borderRadius: "26px 26px 0 0",
    padding: "14px 18px 10px",
    boxSizing: "border-box",
    width: "100%",
  };

  return (
    <div data-bk-bottom-sheet="" style={sheet}>
      <div data-bk-grabber="" aria-hidden="true" style={{ width: 44, height: 4, borderRadius: 99, background: color.edge, margin: "0 auto 14px" }} />
      {p.title || p.onDismiss ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: p.subtitle ? 4 : 12 }}>
          {p.icon ? <Icon icon={p.icon} size={17} color={accent.amber.ink} /> : null}
          <span id={p.titleId} style={{ font: `400 ${Number(p.titleSize) || 18}px/1.2 ${font.display}`, flex: 1, minWidth: 0 }}>
            {p.title}
          </span>
          {p.onDismiss ? <IconButton size="md" tone="mute" style={{ position: "relative" }} glyph={<><Icon icon="dismiss" size={16} /><span style={{ position: "absolute", inset: 0 }} /></>} name={p.closeLabel ?? (p.title ? `Close ${p.title}` : "Close")} onClick={p.onDismiss} /> : null}
          {p.meta ? (
            <span style={{ flex: "none", font: `400 10px/1 ${font.mono}`, color: color.inkMute }}>{p.meta}</span>
          ) : null}
        </div>
      ) : null}
      {p.subtitle ? (
        <div style={{ font: `400 11.5px/1.55 ${font.body}`, color: color.inkMute, marginBottom: 13 }}>{p.subtitle}</div>
      ) : null}
      {p.children ?? null}
      {/* The home-indicator gutter. A fixed 20px rather than `env(safe-area-
       * inset-bottom)`, because the design draws a device mock at a fixed size
       * and a real viewport inset would make the mock disagree with itself. */}
      <div data-bk-sheet-gutter="" style={{ height: 20 }} />
    </div>
  );
}
