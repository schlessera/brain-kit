import { useEffect, useState } from "react";

/**
 * True while a panel should render its contents: immediately when it opens,
 * and until `delayMs` after it closes.
 *
 * Panels slide out rather than disappearing, so their contents have to outlive
 * the `open` flag by the length of that transition — unmounting on the flag
 * would empty the panel on its way off screen. Everything after that is dead
 * weight: a panel is a child of the page it opens over, so a mounted one
 * re-renders with the page and keeps its whole subtree alive for nothing.
 */
export function useDeferredUnmount(open: boolean, delayMs: number): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), delayMs);
    return () => clearTimeout(timer);
  }, [open, delayMs]);
  return mounted;
}
