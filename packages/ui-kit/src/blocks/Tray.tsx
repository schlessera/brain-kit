import { forwardRef, type CSSProperties, type ReactNode } from "react";

import { useExpansion } from "../internal/expansion.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";

/**
 * A bounded panel — a list or a tray — whose collapsed header is useful on its
 * own because it carries the counts or totals (#3253, pattern "Panel").
 *
 * `On this device · 3 recordings · 1.2 MB`. The header names what the panel
 * holds and how much of it, exactly like `Disclosure`'s summary, but it is a
 * full-width 44px row on its own surface, and the body scrolls under it.
 *
 * ── Not a `Disclosure` variant ──────────────────────────────────────────
 *
 * The maintainer chose a separate component over `Disclosure variant="panel"`.
 * The two share the internal expansion primitive (`internal/expansion.ts`):
 * the same uncontrolled / seeded / controlled modes, the same `onOpenChange`
 * contract, the same ARIA wiring. They differ in what they are FOR, and in one
 * behaviour that follows from it:
 *
 * **A closed Tray keeps its body mounted**, hidden. `Disclosure` unmounts its
 * body, which is right for evidence; a tray of recordings would lose playback
 * position, scroll offset and any half-typed transcript the moment it closed.
 *
 * Actions live in the body, never in the header: the header is one target.
 */
export interface TrayProps {
  /** What the panel holds and how much of it: `{what} · {count} · {size}`. */
  label: string;
  icon?: IconName;
  /** A CSS colour for a small leading mark. The label still names the group,
   *  because a colour alone is not an accessible name. */
  swatch?: string;
  /** Seeds alone; with `onOpenChange` it is the live value. See `Disclosure`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Caps the whole panel; the body scrolls under the fixed header. */
  maxHeight?: CSSProperties["maxHeight"];
  children?: ReactNode;
}

/** The forwarded ref is the header button, so a host can return focus to it
 *  after the item that held focus leaves the tray. */
export const Tray = forwardRef<HTMLButtonElement, TrayProps>(function Tray(
  { label, icon, swatch, open: seed, onOpenChange, maxHeight, children },
  ref,
) {
  const expansion = useExpansion({ open: seed, onOpenChange });
  const open = expansion.open;
  return (
    <div
      data-tray=""
      style={{
        boxSizing: "border-box",
        width: "100%",
        maxHeight,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        border: `1px solid ${color.line}`,
        borderRadius: 12,
        background: color.surface,
      }}
    >
      <button
        ref={ref}
        type="button"
        className="bk-row"
        data-tray-header=""
        {...expansion.buttonProps({ bodyMounted: true })}
        style={{
          appearance: "none",
          boxSizing: "border-box",
          flex: "none",
          width: "100%",
          minHeight: 44,
          margin: 0,
          padding: "10px 12px",
          border: "none",
          borderRadius: open ? "11px 11px 0 0" : 11,
          background: "transparent",
          display: "flex",
          alignItems: "center",
          gap: 8,
          textAlign: "start",
          font: `500 11px/1.4 ${font.mono}`,
          color: color.ink,
          cursor: "pointer",
          ...({ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties),
        }}
      >
        {swatch ? (
          <span aria-hidden="true" style={{ flex: "none", width: 8, height: 8, borderRadius: 999, background: swatch }} />
        ) : icon ? (
          <Icon icon={icon} size={13} color={accent.neutral.ink} />
        ) : null}
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{label}</span>
        <Icon icon={open ? "collapse" : "next"} size={13} color={accent.neutral.ink} />
      </button>
      <div
        id={expansion.bodyId}
        data-tray-body=""
        hidden={!open}
        style={{
          display: open ? "flex" : "none",
          flexDirection: "column",
          gap: 8,
          minHeight: 0,
          overflowY: "auto",
          padding: "0 8px 8px",
        }}
      >
        {children}
      </div>
    </div>
  );
});
