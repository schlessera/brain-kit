import { createContext, useContext, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/**
 * The overlay placement: top right of a `group/copy` ancestor. A fine pointer
 * reveals it on hover or keyboard focus. A coarse pointer has no hover, so
 * there it is always visible, or a phone could never reach it.
 */
export const COPY_OVERLAY_CLASS =
  "absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-surface-raised/80 text-muted-foreground opacity-0 transition-all hover:bg-surface-overlay hover:text-foreground group-hover/copy:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100";

/**
 * The one copy control for raw text: code and diagram blocks, JSON dumps,
 * payloads, tool input and output. `getText` is read on click, so it can
 * return the full text even when the rendering is clamped or truncated.
 * `className` replaces the overlay placement; `showLabel` prints the name
 * next to the icon for a toolbar.
 */
export function CopyButton({
  getText,
  label = "Copy",
  showLabel = false,
  className,
}: {
  getText: () => string;
  /** Accessible name before copying; "Copied" replaces it for two seconds. */
  label?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const name = copied ? "Copied" : label;
  const icon = showLabel ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <button
      type="button"
      // Icon-only: without these it has no accessible name at all.
      title={name}
      aria-label={name}
      onClick={() => {
        navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={className ?? COPY_OVERLAY_CLASS}
    >
      {copied ? <Check className={icon} /> : <Copy className={icon} />}
      {showLabel && (copied ? "Copied" : "Copy")}
    </button>
  );
}

const EnclosingCopy = createContext(false);

/**
 * Marks a subtree whose text an enclosing copy control already copies, so a
 * block inside it (`ClampedPre`) does not draw a second button on top of it.
 */
export function EnclosingCopyControl({ children }: { children: ReactNode }) {
  return <EnclosingCopy.Provider value={true}>{children}</EnclosingCopy.Provider>;
}

export function useEnclosingCopy(): boolean {
  return useContext(EnclosingCopy);
}
