import { forwardRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";

export interface IconButtonProps {
  /** Accessible name in every state, also used as the title. */
  name: string;
  /** Exactly one of icon or glyph supplies the drawing. */
  icon?: IconName;
  glyph?: ReactNode;
  tone?: "mute" | "danger" | "overlay";
  size?: "md" | "sm";
  disabled?: boolean;
  expanded?: boolean;
  haspopup?: "menu" | "dialog";
  controls?: string;
  tabIndex?: number;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Host positioning only, merged last. Wrap the control for host visibility rules. */
  style?: CSSProperties;
  [data: `data-${string}`]: string | undefined;
}

/** A native icon control; DiscButton remains reserved for transcript discs. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { name, icon, glyph, tone = "mute", size = "md", disabled, expanded, haspopup, controls, tabIndex, onClick, style, ...data },
  ref,
) {
  if ((icon !== undefined) === (glyph !== undefined)) {
    throw new Error("IconButton requires exactly one of icon or glyph");
  }
  return (
    <button
      {...data}
      ref={ref}
      type="button"
      className="bk-control bk-icon-btn"
      data-tone={tone}
      data-size={size}
      aria-label={name}
      title={name}
      disabled={disabled}
      aria-expanded={expanded}
      aria-haspopup={haspopup}
      aria-controls={controls}
      tabIndex={tabIndex}
      onClick={onClick}
      style={style}
    >
      <span className="bk-icon-btn-glyph" aria-hidden="true">
        {icon ? <Icon icon={icon} size={size === "sm" ? 14 : 16} /> : glyph}
      </span>
    </button>
  );
});
