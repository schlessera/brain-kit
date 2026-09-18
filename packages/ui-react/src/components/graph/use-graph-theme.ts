import { useMemo } from "react";

export interface GraphTheme {
  background: string;
  /** Raised surface used for the hover-label plate (sigma's default is #FFF,
   * unreadable under our near-white label text). */
  surfaceOverlay: string;
  node: string;
  nodeSelected: string;
  edge: string;
  edgeHighlight: string;
  label: string;
  labelMuted: string;
}

const FALLBACK: GraphTheme = {
  background: "#0c0e12",
  surfaceOverlay: "#1e2128",
  node: "#9a96a1",
  nodeSelected: "#e09f3e",
  edge: "#2a2d35",
  edgeHighlight: "#5bb5a2",
  label: "#e8e4df",
  labelMuted: "#9a96a1",
};

/**
 * Resolve the Tailwind theme tokens into concrete colors for the canvas —
 * WebGL cannot read CSS custom properties itself. Read once per mount; the
 * app is dark-only, so tokens do not change at runtime.
 */
export function useGraphTheme(): GraphTheme {
  return useMemo(() => {
    if (typeof window === "undefined") return FALLBACK;
    const style = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => {
      const value = style.getPropertyValue(name).trim();
      return value || fallback;
    };
    return {
      background: token("--color-background", FALLBACK.background),
      surfaceOverlay: token("--color-surface-overlay", FALLBACK.surfaceOverlay),
      node: token("--color-muted-foreground", FALLBACK.node),
      nodeSelected: token("--color-primary", FALLBACK.nodeSelected),
      edge: token("--color-border", FALLBACK.edge),
      edgeHighlight: token("--color-accent", FALLBACK.edgeHighlight),
      label: token("--color-foreground", FALLBACK.label),
      labelMuted: token("--color-muted-foreground", FALLBACK.labelMuted),
    };
  }, []);
}
