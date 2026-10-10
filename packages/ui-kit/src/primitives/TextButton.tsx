import { forwardRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";

export interface TextButtonProps {
  label: string;
  tone?: "link" | "meta" | "inherit";
  /** Text-sized paint with a 44px target; inline neighbours need at least 8px separation. */
  inline?: boolean;
  icon?: IconName;
  glyph?: ReactNode;
  iconEnd?: IconName;
  ariaLabel?: string;
  disabled?: boolean;
  expanded?: boolean;
  haspopup?: "menu" | "dialog";
  controls?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Host positioning only, merged last. */
  style?: CSSProperties;
  [data: `data-${string}`]: string | undefined;
}

/** An inline text action, with native keyboard and disabled behaviour. */
export const TextButton = forwardRef<HTMLButtonElement, TextButtonProps>(function TextButton(
  { label, tone = "link", inline = false, icon, glyph, iconEnd, ariaLabel, disabled, expanded, haspopup, controls, onClick, style, ...data },
  ref,
) {
  return (
    <button
      {...data}
      ref={ref}
      type="button"
      className="bk-text-btn"
      data-tone={tone}
      data-inline={inline}
      aria-label={ariaLabel}
      disabled={disabled}
      aria-expanded={expanded}
      aria-haspopup={haspopup}
      aria-controls={controls}
      onClick={onClick}
      style={style}
    >
      {icon || glyph ? <span className="bk-text-btn-glyph" aria-hidden="true">{icon ? <Icon icon={icon} size={12} /> : glyph}</span> : null}
      {label}
      {iconEnd ? <span aria-hidden="true"><Icon icon={iconEnd} size={12} /></span> : null}
    </button>
  );
});
