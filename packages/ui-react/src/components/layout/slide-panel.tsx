import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDeferredUnmount } from "../../hooks/use-deferred-unmount.js";
import { cn } from "../../lib/utils.js";

/** Matches the `duration-300` slide-out below. */
const SLIDE_OUT_MS = 300;

/**
 * `drawer` slides in from the right over a backdrop and draws its own header.
 * `pane` (D5, from `laptop:` up) is the design's settings PANE: a fixed layer
 * over the content area, offset by the rail's width, with no backdrop and no
 * header of its own — the children draw the header row, because a pane's
 * chrome is a `ScreenHeader`, not a drawer's title bar. It renders nothing
 * while closed: there is no slide to outlive.
 */
export type SlidePanelMode = "drawer" | "pane";

/**
 * What dismisses the panel besides its own close control, in `<dialog
 * closedby>`'s vocabulary so a later move to the element is a rename-free
 * step. `any` (the default) is light dismiss: a click on the backdrop or
 * Escape — right for a preview you glance at and leave. `closerequest`
 * keeps the backdrop inert but honours Escape — for a panel holding
 * something a stray click must not discard, like a finished log. `none`
 * ignores both — for a panel running a job, where a reflexive Escape would
 * cancel it. The header's X closes the drawer under every value: a rendered
 * close control is never inert.
 */
export type SlidePanelClosedBy = "any" | "closerequest" | "none";

/**
 * Below `tablet:`, a destination's drawer and its backdrop stop at the top of
 * the phone bar (60px plus the safe area, `MobileTabBar`), so every slot stays
 * one tap away while it is open (D52 §2, N1: a panel is not a place). A
 * literal class, so Tailwind's scan finds it.
 */
export const ABOVE_PHONE_BAR = "max-tablet:bottom-[calc(60px+env(safe-area-inset-bottom))]";

/**
 * From `tablet:` up, the same rule for the rail: a destination's backdrop
 * starts beside it (60px collapsed, 208px expanded from `laptop:`, as
 * `SideRail`) and the drawer never grows over it, so every rail tab stays
 * one press away while the drawer is open (D52 §2, "Panel open: 1"; #1075).
 * Literal classes, so Tailwind's scan finds them.
 */
export const BESIDE_RAIL_BACKDROP = "tablet:left-[60px] laptop:left-[208px]";
export const BESIDE_RAIL_DRAWER = "tablet:max-w-[calc(100%-60px)] laptop:max-w-[calc(100%-208px)]";

export function SlidePanel({
  open,
  onClose,
  title,
  wide,
  mode = "drawer",
  closedBy = "any",
  destination = false,
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
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open || closedBy === "none") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, closedBy]);

  /**
   * A closed panel renders nothing. The shell (the sliding frame and its
   * header) stays mounted so the CSS transform still animates; the contents do
   * not. Every panel already rebuilds its state when it opens, so a close never
   * preserved anything worth keeping.
   */
  const showContent = useDeferredUnmount(open, SLIDE_OUT_MS);

  if (mode === "pane") {
    if (!open) return null;
    return (
      <section
        aria-label={title}
        className="fixed top-0 bottom-0 right-0 tablet:left-[60px] laptop:left-[208px] z-40 flex flex-col overflow-hidden bg-surface"
      >
        {children}
      </section>
    );
  }

  return (
    <>
      {/* Backdrop: a click on it dismisses only a light-dismiss drawer. */}
      {open && (
        <div
          className={cn("fixed inset-0 z-40 bg-black/40 transition-opacity md:bg-black/20", destination && [ABOVE_PHONE_BAR, BESIDE_RAIL_BACKDROP])}
          onClick={closedBy === "any" ? onClose : undefined}
        />
      )}

      {/* Panel */}
      <div
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full flex-col border-l border-border bg-surface shadow-[0_16px_48px_rgba(0,0,0,0.5)]",
          destination && ["max-tablet:h-auto", ABOVE_PHONE_BAR, BESIDE_RAIL_DRAWER],
          "transform transition-[transform,box-shadow] duration-300 ease-out",
          // A closed drawer sits just past the right edge, and its 48px shadow
          // would still bleed into the viewport: the shadow fades with the
          // slide, and a closed drawer takes no clicks.
          open ? "translate-x-0" : "translate-x-full shadow-none pointer-events-none",
          wide ? "w-full md:w-[480px]" : "w-full md:w-80"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-[family-name:var(--font-display)] text-lg text-foreground">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded-lg p-2.5 md:p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <X className="h-5 w-5 md:h-4 md:w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">{showContent ? children : null}</div>
      </div>
    </>
  );
}
