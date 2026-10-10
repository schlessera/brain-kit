import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { BottomSheet } from "../chrome/BottomSheet.js";
import { Overlay } from "../chrome/Overlay.js";

/** The Working and Pending follow-up sheet adapter; Overlay owns modality. */
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
  return (
    <Overlay open variant="sheet" size="xl" label={p.title} theme={p.theme}
      data-bk-sheet-adapter="summary"
      {...{ [p.scrimAttr]: "", [p.sheetAttr]: "" }}
      // The summary owns return focus, including a composer's selection and
      // the fallback when a live update removes the summary that opened it.
      returnFocus={false} onClose={p.onDismiss}>
      <div ref={panel} className={p.className}>
        <BottomSheet title={p.title} subtitle={p.subtitle}>
          <div style={{ maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>{p.children}</div>
        </BottomSheet>
      </div>
    </Overlay>
  );
}
