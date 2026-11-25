/**
 * The storage map's pure geometry and ownership encoding (#4544).
 *
 * Everything here is a function of numbers and owner names, so it is unit
 * tested without a browser (`tests/storage-geometry.test.ts`). The component
 * only paints what these functions return.
 *
 * The rules come from `docs/decisions/design-kit/storage.md` and the #4544
 * design brief, with the 2026-11-25 maintainer rulings:
 *
 * - a label only on a tile at least 62 × 40;
 * - an activation target only at 44 × 44 or larger;
 * - ownership by tint, edge and label, never colour alone and never a hatch
 *   (#4537 D8). The edge is the primary non-colour cue and is drawn on every
 *   tile; the owner's letter prefix (`B ·`, `A ·`, `O ·`) on every labelled
 *   tile is the second cue, and the legend decodes the letters (maintainer
 *   decision of 2026-11-25, 13:30Z).
 */

export type StorageOwner = "brain" | "app" | "operator";

/** What a tile draws its edge as. `outline` is the neutral aggregate's. */
type StorageEdge = "solid" | "dotted" | "dashed" | "outline";

interface StorageEdgeSpec {
  edge: StorageEdge;
  /** Stroke width in CSS px, drawn inside the tile. */
  width: number;
  /** SVG `stroke-dasharray`, or `null` for a continuous line. */
  dash: string | null;
}

/** Labels need this much room; anything smaller is drawn as an edge only. */
export const TILE_LABEL_MIN = { width: 62, height: 40 } as const;
/** A tile is an activation target only from here; smaller items use the list. */
export const TILE_TARGET_MIN = 44;

export const OWNER_WORD: Record<StorageOwner, string> = { brain: "Brain", app: "App", operator: "Operator" };
const OWNER_LETTER: Record<StorageOwner, string> = { brain: "B", app: "A", operator: "O" };

/**
 * Brain solid, App inner dotted (2–2), Operator dashed (6–3), all 2px inside
 * the tile; the smaller aggregate a 1px neutral outline. The dash patterns
 * are exact SVG arrays rather than CSS `dotted`/`dashed`, whose rhythm the
 * browser chooses, so the three stay distinct at any tile size.
 */
export function ownerEdge(owner: StorageOwner | null): StorageEdgeSpec {
  if (owner === null) return { edge: "outline", width: 1, dash: null };
  if (owner === "app") return { edge: "dotted", width: 2, dash: "2 2" };
  if (owner === "operator") return { edge: "dashed", width: 2, dash: "6 3" };
  return { edge: "solid", width: 2, dash: null };
}

type TileLabel = "none" | "letter";

/** Which owner cue a tile of this size carries, if any. */
export function tileLabel(width: number, height: number): TileLabel {
  if (!(width >= TILE_LABEL_MIN.width && height >= TILE_LABEL_MIN.height)) return "none";
  return "letter";
}

/** The in-tile prefix: `B ·`, `A ·` or `O ·` on a labelled tile of any width, nothing otherwise. */
export function ownerCue(owner: StorageOwner, label: TileLabel): string {
  if (label === "none") return "";
  return `${OWNER_LETTER[owner]} ·`;
}

/** Whether a tile of this size may be a target (`interactive` false opts out). */
export function isTileTarget(width: number, height: number, interactive = true): boolean {
  return interactive && width >= TILE_TARGET_MIN && height >= TILE_TARGET_MIN;
}

interface StorageArea {
  id: string;
  bytes: number;
}

interface StorageRect<T extends StorageArea = StorageArea> {
  item: T;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounded binary subdivision preserves area without a chart runtime. The input
 * is already a disjoint union; anything that is not a finite positive size is
 * dropped here, so an unknown or zero entry can never become a tile.
 */
export function storageRectangles<T extends StorageArea>(items: readonly T[], width: number, height: number): StorageRect<T>[] {
  const result: StorageRect<T>[] = [];
  function split(rows: readonly T[], x: number, y: number, w: number, h: number) {
    if (!rows.length || w <= 0 || h <= 0) return;
    if (rows.length === 1) {
      result.push({ item: rows[0]!, x, y, width: w, height: h });
      return;
    }
    const total = rows.reduce((sum, row) => sum + row.bytes, 0);
    let cut = 1,
      first = rows[0]!.bytes;
    while (cut < rows.length - 1 && first + rows[cut]!.bytes <= total / 2) first += rows[cut++]!.bytes;
    const ratio = first / total;
    if (w >= h) {
      split(rows.slice(0, cut), x, y, w * ratio, h);
      split(rows.slice(cut), x + w * ratio, y, w * (1 - ratio), h);
    } else {
      split(rows.slice(0, cut), x, y, w, h * ratio);
      split(rows.slice(cut), x, y + h * ratio, w, h * (1 - ratio));
    }
  }
  split(
    items.filter((item) => Number.isFinite(item.bytes) && item.bytes > 0),
    0,
    0,
    Math.max(0, width),
    Math.max(0, height),
  );
  return result;
}

/** The space between neighbouring tiles, in CSS px, painted as the map background. */
export const TILE_GUTTER = 2;

/**
 * One axis of a tile's drawn box. A shared edge moves in by half the gutter,
 * so neighbours end up a full gutter apart; an edge on the map's outer
 * boundary stays flush. A span too thin to keep 1px after that is drawn as
 * 1px about its own centre, kept inside the map: a sliver never vanishes,
 * and it still never touches its neighbour, though its gap may be under the
 * full gutter.
 */
function insetSpan(start: number, size: number, extent: number, gutter: number): [number, number] {
  const EDGE = 1e-6,
    half = gutter / 2;
  const from = start + (start > EDGE ? half : 0);
  const to = start + size - (start + size < extent - EDGE ? half : 0);
  if (to - from >= 1) return [from, to - from];
  const centred = Math.min(Math.max(start + size / 2 - 0.5, 0), Math.max(0, extent - 1));
  return [centred, Math.min(1, extent)];
}

/**
 * What the map draws: each tile of {@link storageRectangles} trimmed by half
 * the gutter on every shared edge, so a 2px line of map background separates
 * neighbours (#4544 design feedback). Areas are proportional to bytes BEFORE
 * the trim; the trim is the same on every shared edge of every tile, so it
 * takes the same strip off each and no tile gains on another. The 62 × 40
 * label and 44 × 44 target rules are measured on these drawn boxes.
 */
export function storageTiles<T extends StorageArea>(items: readonly T[], width: number, height: number, gutter = TILE_GUTTER): StorageRect<T>[] {
  return storageRectangles(items, width, height).map((rect) => {
    const [x, w] = insetSpan(rect.x, rect.width, width, gutter);
    const [y, h] = insetSpan(rect.y, rect.height, height, gutter);
    return { item: rect.item, x, y, width: w, height: h };
  });
}

/** The targets in reading order (top to bottom, then left to right): the arrow-key order. */
export function storageTargets<T extends StorageArea & { interactive?: boolean }>(rects: readonly StorageRect<T>[]): StorageRect<T>[] {
  return rects
    .filter((rect) => isTileTarget(rect.width, rect.height, rect.item.interactive !== false))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** A share bar's fill, as a fraction clamped to 0–1. A non-finite share draws nothing. */
export function shareFraction(share: number | undefined): number {
  if (share === undefined || !Number.isFinite(share)) return 0;
  return Math.min(1, Math.max(0, share));
}
