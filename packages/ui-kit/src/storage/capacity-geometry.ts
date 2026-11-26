/**
 * The pure half of {@link CapacityGauge}: which segments a capacity draws, and
 * where its threshold ticks and their labels go (#4542, epic #4537 D5).
 *
 * A capacity is four numbers about one volume: `used + free = total`, and the
 * caller can write `available` bytes of `free` (`available <= free`). The
 * gap between free and available is reserved: free on disk, but not for
 * this caller. The gauge draws them as one track running used → reserved →
 * available, so the available segment ends at the track's right edge.
 *
 * Thresholds are fractions of total available space (Low 10%, Very low 5%;
 * `docs/decisions/storage-guidance.md`), so a tick sits at `(1 − fraction)`
 * of the track from the used end, whatever the current figures are.
 *
 * Nothing here formats a number or reads the DOM. That keeps it testable
 * in `tests/capacity-geometry.test.ts`.
 */

/** One volume's figures, in bytes. */
export interface CapacityFigures {
  total: number;
  used: number;
  free: number;
  /** What the caller can actually write. At most `free`. */
  available: number;
}

/** Fractions of `total` that available space must stay above: 0 < veryLow < low < 1. */
export interface CapacityThresholds {
  low: number;
  veryLow: number;
}

export type CapacitySegmentKind = "used" | "reserved" | "available";

/** A segment's start and size as fractions of the track, from the used end. */
export interface CapacitySegment {
  kind: CapacitySegmentKind;
  start: number;
  size: number;
}

/** Sums of byte counts are exact below 2^53, but callers may hand in derived
 * floats. One part in a billion absorbs that and nothing a person would see. */
const EPSILON = 1e-9;

const finite = (n: number) => typeof n === "number" && Number.isFinite(n);

/**
 * Whether the figures can be drawn honestly. Anything negative, non-finite,
 * unbalanced (`used + free ≠ total`) or with `available > free` is refused,
 * because the bar it drew would be wrong. The gauge shows a text mark instead
 * (`docs/decisions/design-kit/storage.md`: "Negative or inconsistent
 * differences never become a bar").
 */
export function capacityDrawable(c: CapacityFigures): boolean {
  const { total, used, free, available } = c;
  if (![total, used, free, available].every(finite)) return false;
  if (total <= 0 || used < 0 || free < 0 || available < 0) return false;
  const slack = total * EPSILON;
  if (Math.abs(used + free - total) > slack) return false;
  return available <= free + slack;
}

/**
 * The segments to draw, in track order. A segment with no bytes is left
 * out rather than drawn at zero width. `null` means draw no bar at all.
 */
export function capacitySegments(c: CapacityFigures): CapacitySegment[] | null {
  if (!capacityDrawable(c)) return null;
  const available = Math.min(c.available, c.free);
  const reserved = c.free - available;
  const parts: Array<[CapacitySegmentKind, number]> = [
    ["used", c.used],
    ["reserved", reserved],
    ["available", available],
  ];
  const out: CapacitySegment[] = [];
  let start = 0;
  for (const [kind, bytes] of parts) {
    const size = bytes / c.total;
    if (size <= 0) continue;
    out.push({ kind, start, size });
    start += size;
  }
  return out;
}

/** Whether a threshold pair can be drawn: both finite, 0 < veryLow < low < 1. */
export function thresholdsValid(t: CapacityThresholds): boolean {
  return finite(t.low) && finite(t.veryLow) && t.veryLow > 0 && t.low > t.veryLow && t.low < 1;
}

/** `0.1` → `"10%"`, `0.125` → `"12.5%"`. One decimal at most. */
export function percentLabel(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/**
 * Below this gap the two ticks merge into one marker. A 1px rule and a 4px
 * pair need about 4px between them to read as two marks.
 */
const TICK_COLLAPSE_PX = 4;

/** At this gap or more, each tick can carry its own label (if it fits). */
const TICK_SPLIT_PX = 18;

/** The caption is 11px JetBrains Mono, whose advance is 0.6em: 6.6px a glyph. */
export const CAPTION_GLYPH_PX = 6.6;

/** Room for a label's tick glyph and the space beside it. */
const CAPTION_KEY_PX = 8;

export interface TickLayout {
  /** Tick positions as fractions of the track from the used end. */
  low: number;
  veryLow: number;
  /** Distance between the ticks in px, or null while the width is unknown. */
  gapPx: number | null;
  /** The ticks are too close to tell apart and draw as one marker. */
  collapsed: boolean;
  /** Each tick has room for its own label: Low ends at its tick, Very low
   * starts at its own. Otherwise one right-aligned caption names both. */
  split: boolean;
}

/**
 * Where the ticks go on a `width`-px track, and how their labels fit.
 *
 * Positions are fractions, so the ticks can be placed with percentages before
 * the track has been measured. With `width` null (first render, or no layout
 * engine) the ticks stay apart and the caption is merged, which is the right
 * answer at every realistic card width: 10% and 5% sit 14.8px apart on a
 * 296px track.
 */
export function tickLayout(
  width: number | null,
  t: CapacityThresholds,
  labels: { low: string; veryLow: string },
): TickLayout {
  const low = 1 - t.low;
  const veryLow = 1 - t.veryLow;
  if (width === null || !finite(width) || width <= 0) {
    return { low, veryLow, gapPx: null, collapsed: false, split: false };
  }
  // Rounded to a micropixel, so 0.1 × 180 compares as the 18px it means
  // rather than as 17.999999999999996.
  const px = (n: number) => Math.round(n * 1e6) / 1e6;
  const gapPx = px((t.low - t.veryLow) * width);
  const lowRoom = px(low * width);
  const veryLowRoom = px(t.veryLow * width);
  const need = (text: string) => text.length * CAPTION_GLYPH_PX + CAPTION_KEY_PX;
  return {
    low,
    veryLow,
    gapPx,
    collapsed: gapPx < TICK_COLLAPSE_PX,
    split: gapPx >= TICK_SPLIT_PX && lowRoom >= need(labels.low) && veryLowRoom >= need(labels.veryLow),
  };
}
