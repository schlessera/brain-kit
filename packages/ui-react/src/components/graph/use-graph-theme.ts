import { useMemo } from "react";
import type { TokenName } from "@schlessera/brain-ui-kit";

import { useColorScheme } from "../../hooks/use-color-scheme.js";
import { readToken, type ColorScheme } from "../../lib/light-dark.js";
import type { CanvasPalette } from "./lib/graph-helpers.js";

export interface GraphTheme {
  background: string;
  /** Raised surface used for the hover-label plate (sigma's default is #FFF,
   * unreadable under the dark theme's near-white label text). */
  surfaceOverlay: string;
  node: string;
  nodeSelected: string;
  edge: string;
  edgeHighlight: string;
  /** Every label is drawn in the ink — never in its node's colour, which is
   * a value tuned for a 7px mark, not for the one thing you must read. */
  label: string;
  labelMuted: string;
  /**
   * The kit's entity colours (its `GraphView`, `PathRef` and inline
   * mentions): teal a person, blue a company, purple a project, amber the
   * focus node, and the neutral for any other document type. The three kinds
   * take the MARK weight, which is the fill in the dark and a darkened step
   * on paper, where a fill sits under 3:1 against the canvas.
   */
  entity: EntityColors;
  /** The categorical slots, the distance ramp and the fixed roles, resolved
   * for the scheme in force. See `CanvasPalette`. */
  palette: CanvasPalette;
}

export interface EntityColors {
  person: string;
  company: string;
  project: string;
  focus: string;
  other: string;
}

/**
 * Resolve the kit's tokens into concrete colours for the canvas — WebGL and
 * `fillStyle` cannot read a CSS custom property, and since the kit's light
 * theme every token is a `light-dark()` pair that `getComputedStyle` returns
 * verbatim, so each is split on the scheme the page is drawing in.
 *
 * Re-resolves when the theme preference or, under `system`, the OS scheme
 * changes; the canvas re-applies it in place (`graph-canvas.tsx`).
 */
export function useGraphTheme(): GraphTheme {
  const scheme = useColorScheme();
  return useMemo(() => graphTheme(scheme), [scheme]);
}

/** The theme for one scheme, from the tokens. Exported for tests. */
export function graphTheme(scheme: ColorScheme): GraphTheme {
  const token = (name: TokenName) => readToken(name, scheme);
  return {
    background: token("color-canvas"),
    surfaceOverlay: token("color-raised"),
    node: token("color-ink-mute"),
    nodeSelected: token("canvas-root"),
    edge: token("color-edge"),
    edgeHighlight: token("color-teal"),
    label: token("color-ink"),
    labelMuted: token("color-ink-mute"),
    entity: {
      person: token("teal-mark"),
      company: token("blue-mark"),
      project: token("purple-mark"),
      focus: token("canvas-root"),
      other: token("canvas-other"),
    },
    palette: {
      slots: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => token(`canvas-slot-${n}` as TokenName)),
      ramp: [1, 2, 3, 4, 5].map((n) => token(`canvas-ramp-${n}` as TokenName)),
      root: token("canvas-root"),
      other: token("canvas-other"),
      lens: {
        orphan: token("canvas-lens-orphan"),
        unreachable: token("canvas-lens-unreachable"),
        broken: token("canvas-lens-broken"),
        stale: token("canvas-lens-stale"),
      },
    },
  };
}
