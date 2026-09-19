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

export function SlidePanel({
  open,
  onClose,
  title,
  wide,
  mode = "drawer",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  mode?: SlidePanelMode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

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
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 transition-opacity md:bg-black/20"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full flex-col border-l border-border bg-surface shadow-[0_16px_48px_rgba(0,0,0,0.5)]",
          "transform transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
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
