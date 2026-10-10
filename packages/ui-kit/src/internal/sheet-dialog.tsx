import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { BottomSheet } from "../chrome/BottomSheet.js";
import { color, z, token } from "../tokens.js";

/**
 * The modal bottom sheet a summary pill of the shared row opens (D52 §3): the
 * `Working` sheet of the left half and the `Pending follow-ups` sheet of the
 * right. The modal rule is the kit's own (`ModelPicker`, the handoff sheet):
 * focus moves to the first stop, Tab is trapped, and Esc or a press on the
 * scrim dismisses. Callers portal it to `<body>`, because each half is a size
 * container whose layout containment would otherwise become the fixed sheet's
 * containing block, and pass the nearest `data-theme` along with it.
 */
export interface SheetDialogProps {
  /** The dialog's accessible name and the sheet's title. */
  title: string;
  subtitle?: string;
  /** Matches the focus stops inside: rows that are activated or read. */
  stops: string;
  /**
   * Changes whenever the listed items do. A stop that leaves while focused
   * takes focus with it, and focus on `<body>` would escape the trap, so a
   * change re-seats focus inside. The dialog itself is the last resort.
   */
  itemsKey: string;
  theme?: string;
  onDismiss: () => void;
  /** `data-*` names that tests and styles address the two layers by. */
  scrimAttr: string;
  sheetAttr: string;
  className?: string;
  children: ReactNode;
}

export function SheetDialog(p: SheetDialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const here = panel.current;
    if (!here || here.contains(document.activeElement)) return;
    (here.querySelector<HTMLElement>(p.stops) ?? here).focus();
  }, [p.itemsKey, p.stops]);
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onDismiss();
      return;
    }
    if (e.key !== "Tab") return;
    const stops = [...(panel.current?.querySelectorAll<HTMLElement>(p.stops) ?? [])].filter((el) => el.tabIndex === 0);
    const first = stops[0];
    const last = stops.at(-1);
    // Focus on the dialog itself (a click on its title or padding) is inside
    // the trap too, with no stop to step from.
    if (!stops.includes(document.activeElement as HTMLElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first)?.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  return (
    <div
      {...{ [p.scrimAttr]: "" }}
      data-theme={p.theme}
      // Ink is set here, not inherited: the portal leaves the row's subtree,
      // and the page's foreground may belong to the other theme.
      style={{ position: "fixed", inset: 0, zIndex: z.modal, background: token("palette-shadow"), color: color.ink }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press would otherwise move focus to whatever is under the scrim
        // once it is gone, undoing the return to the opener.
        e.preventDefault();
        p.onDismiss();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={p.title}
        {...{ [p.sheetAttr]: "" }}
        className={p.className}
        onKeyDown={keys}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxWidth: 720, margin: "0 auto" }}
      >
        <BottomSheet title={p.title} subtitle={p.subtitle}>
          <div style={{ maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>{p.children}</div>
        </BottomSheet>
      </div>
    </div>
  );
}
