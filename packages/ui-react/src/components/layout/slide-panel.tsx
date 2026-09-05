import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils.js";

/** Matches the `duration-300` slide-out below. */
const SLIDE_OUT_MS = 300;

export function SlidePanel({
  open,
  onClose,
  title,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
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
   * A closed panel renders nothing.
   *
   * The shell (the sliding frame and its header) stays mounted so the CSS
   * transform still animates, but the contents do not: every panel here is a
   * child of the chat page, so a mounted panel re-rendered with it, and the
   * settings tabs and the session list are not cheap to re-render. Every panel
   * already rebuilds its state when it opens, so there is nothing to preserve
   * across a close.
   *
   * Unmounting is deferred by the length of the slide-out so the panel does not
   * empty itself on the way off screen.
   */
  const [showContent, setShowContent] = useState(open);
  useEffect(() => {
    if (open) {
      setShowContent(true);
      return;
    }
    const t = setTimeout(() => setShowContent(false), SLIDE_OUT_MS);
    return () => clearTimeout(t);
  }, [open]);

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
