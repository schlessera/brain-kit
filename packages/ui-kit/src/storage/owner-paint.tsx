import { accent, color, token } from "../tokens.js";
import { ownerEdge, type StorageOwner } from "./storage-geometry.js";

/**
 * The owner tints and edge inks, from existing tokens only (#4537 D8).
 *
 * Brain teal, App blue, Operator purple, matching brief rev 1's teal and blue.
 * The fills step strong, mid and light (`avatar-tint`, `chip-tint`,
 * `surface-tint`), so a greyscale render also orders them by darkness, though
 * the edge pattern stays the cue that does not depend on it. Every fill is an
 * alpha tint low enough that `ink` labels keep 4.5:1 on it in both themes;
 * the Storybook a11y gate measures that on every story. The edge takes the
 * accent's `ink` role, which is the role for borders. The aggregate has no
 * tint: surface with a neutral outline.
 */
const OWNER_PAINT: Record<StorageOwner, { fill: string; edge: string; bar: string }> = {
  brain: { fill: token("avatar-tint-teal"), edge: accent.teal.ink, bar: token("trend-bar-teal") },
  app: { fill: token("chip-tint-blue"), edge: accent.blue.ink, bar: token("trend-bar-blue") },
  operator: { fill: token("surface-tint-purple"), edge: accent.purple.ink, bar: token("trend-bar-purple") },
};

const AGGREGATE_PAINT = { fill: color.surface, edge: accent.neutral.ink, bar: token("trend-bar-neutral") } as const;

export function ownerPaint(owner: StorageOwner | null) {
  return owner === null ? AGGREGATE_PAINT : OWNER_PAINT[owner];
}

/**
 * An edge drawn inside a box of the given size: the stroke sits half its width
 * in from the box, so a 2px edge occupies exactly the outer 2px. `data-edge`
 * names the pattern for tests and greyscale review.
 */
export function EdgeStroke({ owner, width, height, radius = 2 }: { owner: StorageOwner | null; width: number; height: number; radius?: number }) {
  const spec = ownerEdge(owner);
  const inset = spec.width / 2;
  if (width <= spec.width * 2 || height <= spec.width * 2) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-edge={spec.edge}
      width={width}
      height={height}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}
    >
      <rect
        x={inset}
        y={inset}
        width={width - spec.width}
        height={height - spec.width}
        rx={radius}
        fill="none"
        stroke={ownerPaint(owner).edge}
        strokeWidth={spec.width}
        strokeDasharray={spec.dash ?? undefined}
      />
    </svg>
  );
}

/**
 * The owner swatch a legend chip and a list row lead with: the tile in
 * miniature, its tint plus its edge pattern, so the list and the legend
 * decode the map without colour.
 */
export function OwnerSwatch({ owner, size = 16 }: { owner: StorageOwner | null; size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-owner-swatch={owner ?? "aggregate"}
      style={{
        position: "relative",
        display: "inline-block",
        flex: "none",
        width: size,
        height: size,
        borderRadius: 3,
        background: ownerPaint(owner).fill,
      }}
    >
      <EdgeStroke owner={owner} width={size} height={size} radius={2} />
    </span>
  );
}
