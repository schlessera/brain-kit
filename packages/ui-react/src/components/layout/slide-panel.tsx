import { useEffect, type ReactNode, type Ref } from "react";
import { openModal } from "../../lib/destination-start.js";
import { Overlay } from "@schlessera/brain-ui-kit";

/** Drawers use Overlay; panes are fixed regions beside the rail. */
export type SlidePanelMode = "drawer" | "pane";
/** Native dialog dismissal vocabulary, implemented by Overlay. */
export type SlidePanelClosedBy = "any" | "closerequest" | "none";

export function SlidePanel({
  open,
  onClose,
  title,
  wide,
  mode = "drawer",
  closedBy = "any",
  destination = false,
  panelRef,
  returnFocus,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  mode?: SlidePanelMode;
  closedBy?: SlidePanelClosedBy;
  /**
   * A bar or rail destination (Sessions, Settings): the phone bar and the
   * rail stay uncovered and operable. An act's panel (Search, a running
   * Sync) keeps covering them.
   */
  destination?: boolean;
  /**
   * The panel itself (the drawer, or the pane's section), for a destination
   * that answers a press of itself (D52 N3): its scroll containers reset,
   * and a drawer's heading is the last focus stop.
   */
  panelRef?: Ref<HTMLElement>;
  returnFocus?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open || mode !== "pane" || closedBy === "none") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || openModal()) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, mode, closedBy, onClose]);

  if (mode === "pane") {
    if (!open) return null;
    return (
      <section
        ref={panelRef}
        aria-label={title}
        className="fixed top-0 bottom-0 right-0 tablet:left-[60px] laptop:left-[208px] z-panel flex flex-col overflow-hidden bg-surface"
      >
        {children}
      </section>
    );
  }

  return (
    <Overlay open={open} variant="panel" modal={!destination} size={wide ? "md" : "sm"}
      title={title} data-panel={title} closedBy={closedBy} onClose={onClose} surfaceRef={panelRef} returnFocus={returnFocus}>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </Overlay>
  );
}
