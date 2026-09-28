/**
 * How a `map` block is drawn: the plan, as a pure function of its places (#44).
 *
 * The model says which places; this decides everything the drawing needs and
 * nothing the model may steer. Every place becomes a row, numbered in payload
 * order, whatever else happens: the map is an illustration of the list, never
 * a replacement for it. What the plan decides on top of that is whether there
 * is one map, two, or none, and why, from the coordinates alone.
 *
 * Nothing here does I/O. The surface fetches geometry per frame through the
 * server's `/geo/coastline` route, with the frame's `bbox`, and a test hands
 * the kit literal geometry instead: keyless and offline either way.
 *
 * ## Why the frame envelope is the kit's own arithmetic, repeated
 *
 * The server clips to the box it is asked for, so the box has to cover every
 * frame `MapView` can draw for these pins. `drawnBounds` below is `MapView`'s
 * bounding-box rule (the span minimum, the 12% and 14% margins, the aspect
 * correction) written out again, because this package cannot import the kit.
 * The two must agree, and `packages/ui-react/tests/map-block.test.ts` holds
 * them to it against the kit's exported `mapViewBounds` at both ends of the
 * width range. A frame is the union of the two, because the aspect correction
 * is monotonic in width: the narrowest card is the tallest box and the widest
 * the widest.
 */

import type { MapPlace } from "./tool-contracts/blocks.js";

/** Why a place has no pin. Shown in its row, so a missing pin is never silent. */
export type UnpinnedReason = "no position" | "0, 0 is usually a missing value" | "beyond the map's ±85°";

/** One place, as the list shows it. Every input place yields exactly one. */
export interface PlaceRow {
  /** 1-based payload order. Never changes with width, clustering or mode. */
  n: number;
  label: string;
  meta?: string;
  source?: string;
  /** The coordinate as given, trimmed to 4 dp and never padded. */
  coord?: string;
  /** What the given digits can claim, e.g. `to ~1 km`. Absent at 4+ dp. */
  precision?: string;
  /** The stated accuracy, e.g. `±50 m, as stated`. Never drawn for N ≥ 2. */
  accuracy?: string;
  /** Drawn on a frame. False for every row that has an `unpinnedWhy`. */
  pinned: boolean;
  unpinnedWhy?: UnpinnedReason;
}

export interface PlaceFramePin {
  n: number;
  lat: number;
  lon: number;
}

/** One map, and the box of geometry to fetch for it. */
export interface PlaceFrame {
  /** `[west, south, east, north]`: every box `MapView` can draw for these pins. */
  bbox: [number, number, number, number];
  pins: PlaceFramePin[];
  height: PlaceFrameHeight;
  /** The kit's minimum span; the pins' own extent widens it. */
  spanKm: number;
  /** Set only for a lone pin whose ring fits the frame. */
  accuracyM?: number;
  /** Roughly how much ground the frame shows across, for its accessible name. */
  acrossKm: number;
  /** `1–3 · Vathy`: which numbers the frame holds. Only set in `pair`. */
  caption?: string;
}

export type PlaceFrameHeight = 170 | 200 | 260;

export type PlaceMode = "map" | "pair" | "list";

export interface PlacePlan {
  /** Every place, payload order. */
  rows: PlaceRow[];
  mode: PlaceMode;
  /** Why there is no single map. Absent in `map`. */
  reason?: string;
  /** One for `map`, two for `pair`, none for `list`. */
  frames: PlaceFrame[];
  /** All pins carry their name on the map, or none does. */
  onMapLabels: boolean;
}

/** The longest label drawn beside a pin; past it every pin is numbered. */
export const ON_MAP_LABEL_MAX = 18;

/** The kit's minimum span, in kilometres. */
export const MIN_SPAN_KM = 1.6;

/**
 * The frame widths a map is drawn at. 238 is the narrowest card the kit
 * lays out and 420 is `MapView`'s cap, so the envelope covers both.
 */
export const FRAME_WIDTHS = [238, 420] as const;

/**
 * The widest box `/geo/coastline` answers is 5° on each axis. A frame must fit
 * under it with room for the request's 5 dp rounding.
 */
export const MAX_FRAME_DEGREES = 4.99;

/** Two pins closer than this on both axes belong to the same group. */
const LINK_DEGREES = 5;

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

function mercY(lat: number): number {
  const r = Math.max(-85, Math.min(85, lat)) * DEG;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

function unmercY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/**
 * What `MapView` draws for these pins at `width` × `height`, as
 * `[west, south, east, north]`. The kit's rule, repeated: see the header.
 */
export function drawnBounds(
  pins: ReadonlyArray<{ lat: number; lon: number }>,
  opts: { width: number; height: number; spanKm?: number; accuracyM?: number }
): [number, number, number, number] {
  const lats = pins.map((p) => p.lat);
  const lons = pins.map((p) => p.lon);
  const spanKm = Math.max(opts.spanKm || MIN_SPAN_KM, ((opts.accuracyM ?? 0) * 6) / 1000);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const degLon = spanKm / 111 / Math.max(0.2, Math.cos(midLat * DEG));
  let west = Math.min(...lons);
  let east = Math.max(...lons);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  if (east - west < degLon) {
    const c = (east + west) / 2;
    west = c - degLon / 2;
    east = c + degLon / 2;
  }
  let mw = west - (east - west) * 0.12;
  let me = east + (east - west) * 0.12;
  const ms = south - (north - south) * 0.14;
  const mn = north + (north - south) * 0.14;
  let yTop = mercY(mn);
  let yBot = mercY(ms);
  const wantRatio = opts.width / Math.max(110, Math.min(260, opts.height));
  const lonRad = (me - mw) * DEG;
  const yRad = yTop - yBot;
  if (lonRad / yRad < wantRatio) {
    const grow = ((yRad * wantRatio) / DEG - (me - mw)) / 2;
    mw -= grow;
    me += grow;
  } else {
    const grow = (lonRad / wantRatio - yRad) / 2;
    yTop += grow;
    yBot -= grow;
  }
  return [mw, unmercY(yBot), me, unmercY(yTop)];
}

/** Every box `MapView` can draw for these pins at this height, clamped to the world. */
export function frameEnvelope(
  pins: ReadonlyArray<{ lat: number; lon: number }>,
  opts: { height: number; spanKm?: number; accuracyM?: number }
): [number, number, number, number] {
  const boxes = FRAME_WIDTHS.map((width) => drawnBounds(pins, { ...opts, width }));
  return [
    Math.max(-180, Math.min(...boxes.map((b) => b[0]))),
    Math.max(-89, Math.min(...boxes.map((b) => b[1]))),
    Math.min(180, Math.max(...boxes.map((b) => b[2]))),
    Math.min(89, Math.max(...boxes.map((b) => b[3]))),
  ];
}

function fits(bbox: [number, number, number, number]): boolean {
  return bbox[2] - bbox[0] <= MAX_FRAME_DEGREES && bbox[3] - bbox[1] <= MAX_FRAME_DEGREES;
}

/** Great-circle distance in kilometres, from the coordinates as given. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Three significant figures, grouped: `508 km`, `1,210 km`. */
export function formatDistance(km: number): string {
  const rounded = Number(km.toPrecision(3));
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 2 })} km`;
}

/** Trimmed to 4 dp, never padded: `38.1` stays `38.1`. */
function trimCoord(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** How many decimal places the number was given with. */
function decimals(value: number): number {
  const text = String(value);
  if (/e/i.test(text)) return 4;
  return text.split(".")[1]?.length ?? 0;
}

const PRECISION = ["to ~100 km", "to ~10 km", "to ~1 km", "to ~100 m"] as const;

function accuracyText(metres: number): string {
  const figure =
    metres >= 1000
      ? `±${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km`
      : `±${Math.round(metres)} m`;
  return `${figure}, as stated`;
}

function unpinned(place: MapPlace): UnpinnedReason | undefined {
  if (place.lat === undefined || place.lon === undefined) return "no position";
  if (place.lat === 0 && place.lon === 0) return "0, 0 is usually a missing value";
  if (Math.abs(place.lat) > 85) return "beyond the map's ±85°";
  return undefined;
}

function row(place: MapPlace, index: number): PlaceRow {
  const why = unpinned(place);
  const out: PlaceRow = { n: index + 1, label: place.label, pinned: why === undefined };
  if (place.meta !== undefined) out.meta = place.meta;
  if (place.source !== undefined) out.source = place.source;
  if (place.lat !== undefined && place.lon !== undefined) {
    out.coord = `${trimCoord(place.lat)}, ${trimCoord(place.lon)}`;
    const given = Math.min(decimals(place.lat), decimals(place.lon));
    if (given < PRECISION.length) out.precision = PRECISION[given];
  }
  if (place.accuracyM !== undefined) out.accuracy = accuracyText(place.accuracyM);
  if (why) out.unpinnedWhy = why;
  return out;
}

function heightFor(count: number): PlaceFrameHeight {
  return count <= 3 ? 170 : count <= 9 ? 200 : 260;
}

/** `1–3`, `1, 4, 6–8`: the numbers a frame holds, as runs. */
export function numberRuns(ns: number[]): string {
  const sorted = [...ns].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** Roughly the ground a frame shows across its width, in kilometres. */
function acrossKm(pins: PlaceFramePin[], spanKm: number): number {
  const lons = pins.map((p) => p.lon);
  const midLat = (Math.min(...pins.map((p) => p.lat)) + Math.max(...pins.map((p) => p.lat))) / 2;
  const extent = (Math.max(...lons) - Math.min(...lons)) * 111 * Math.max(0.2, Math.cos(midLat * DEG));
  return Math.max(extent, spanKm) * 1.24;
}

/** Does the tightest arc around these longitudes cross ±180°? */
function crossesDateLine(lons: number[]): boolean {
  if (lons.length < 2) return false;
  const sorted = [...lons].sort((a, b) => a - b);
  const wrap = sorted[0]! + 360 - sorted[sorted.length - 1]!;
  let widest = 0;
  for (let i = 1; i < sorted.length; i++) widest = Math.max(widest, sorted[i]! - sorted[i - 1]!);
  // The arc that leaves out the widest gap is the tightest one. When that gap
  // is not the one across ±180°, the arc runs through it.
  return widest > wrap;
}

function frame(pins: PlaceFramePin[], accuracyM?: number): PlaceFrame | null {
  const height = heightFor(pins.length);
  const withRing = accuracyM !== undefined ? frameEnvelope(pins, { height, spanKm: MIN_SPAN_KM, accuracyM }) : null;
  // A ring too wide for one fetchable frame is stated in the row and not
  // drawn: the pin is still a pin, and the frame falls back to the span rule.
  const ring = withRing && fits(withRing) ? accuracyM : undefined;
  const bbox = ring !== undefined ? withRing! : frameEnvelope(pins, { height, spanKm: MIN_SPAN_KM });
  if (!fits(bbox)) return null;
  const spanKm = Math.max(MIN_SPAN_KM, ((ring ?? 0) * 6) / 1000);
  const out: PlaceFrame = { bbox, pins, height, spanKm, acrossKm: acrossKm(pins, spanKm) };
  if (ring !== undefined) out.accuracyM = ring;
  return out;
}

/** Single-linkage groups: two pins within `LINK_DEGREES` on both axes join. */
function groups(pins: PlaceFramePin[]): PlaceFramePin[][] {
  const parent = pins.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i]!;
      const b = pins[j]!;
      if (Math.abs(a.lat - b.lat) <= LINK_DEGREES && Math.abs(a.lon - b.lon) <= LINK_DEGREES) {
        parent[find(j)] = find(i);
      }
    }
  }
  const byRoot = new Map<number, PlaceFramePin[]>();
  pins.forEach((pin, i) => {
    const root = find(i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), pin]);
  });
  // In order of each group's first number, which is the reading order.
  return [...byRoot.values()].sort((a, b) => a[0]!.n - b[0]!.n);
}

function largestDistance(pins: PlaceFramePin[]): number {
  let most = 0;
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) most = Math.max(most, haversineKm(pins[i]!, pins[j]!));
  }
  return most;
}

function nearestDistance(a: PlaceFramePin[], b: PlaceFramePin[]): number {
  let least = Infinity;
  for (const p of a) for (const q of b) least = Math.min(least, haversineKm(p, q));
  return least;
}

/**
 * The plan for a `map` block's places. Pure: literal input, literal output.
 *
 * In order, the first that applies:
 *   - no pinned place → `list`, `No positions given`;
 *   - the pins' tightest arc crosses ±180° → `list`, `Spans the date line`;
 *   - one frame fits the route's 5° → `map`;
 *   - exactly two groups, each fitting → `pair`, with the distance between;
 *   - anything else → `list`, with the distance across.
 * Every distance is Brain's great-circle arithmetic on the given coordinates,
 * never a figure the model supplied.
 */
export function planPlaces(places: ReadonlyArray<MapPlace>): PlacePlan {
  const rows = places.map(row);
  const pins: PlaceFramePin[] = [];
  places.forEach((place, i) => {
    if (rows[i]!.pinned) pins.push({ n: i + 1, lat: place.lat!, lon: place.lon! });
  });
  const onMapLabels =
    pins.length > 0 &&
    pins.length <= 3 &&
    pins.every((pin) => places[pin.n - 1]!.label.length <= ON_MAP_LABEL_MAX);
  const plan = (mode: PlaceMode, frames: PlaceFrame[], reason?: string): PlacePlan =>
    reason === undefined ? { rows, mode, frames, onMapLabels } : { rows, mode, reason, frames, onMapLabels };

  if (pins.length === 0) return plan("list", [], "No positions given");
  if (crossesDateLine(pins.map((p) => p.lon))) return plan("list", [], "Spans the date line; not drawn");

  // The ring is drawn for a lone pin only: the kit draws it round the first
  // pin, and a ring the model sized beside other pins is the model drawing.
  const only = pins.length === 1 ? places[pins[0]!.n - 1]!.accuracyM : undefined;
  const single = frame(pins, only);
  if (single) return plan("map", [single]);

  const parts = groups(pins);
  if (parts.length === 2) {
    const frames = parts.map((part) => frame(part));
    if (frames.every((f): f is PlaceFrame => f !== null)) {
      for (const f of frames) {
        f.caption = `${numberRuns(f.pins.map((p) => p.n))} · ${places[f.pins[0]!.n - 1]!.label}`;
      }
      return plan(
        "pair",
        frames,
        `Too far apart for one map · ${formatDistance(nearestDistance(parts[0]!, parts[1]!))} between them`
      );
    }
  }
  return plan("list", [], `Too spread out to draw · ${formatDistance(largestDistance(pins))} across`);
}
