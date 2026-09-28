import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * A location inside a chat answer — an accurate locator, not a picture of a
 * map.
 *
 * Everything drawn is derived from real coordinates: pins are projected with
 * Web Mercator, the graticule sits on rounded lat/lon intervals, and the scale
 * bar is computed from metres-per-pixel at the view's latitude. Nothing here is
 * freehand cartography; street and coastline geometry appears only if the
 * caller passes real `[lon, lat]` paths.
 *
 * For a pannable street map, build a plain Leaflet page instead — tile layers
 * do not belong inside a chat transcript, and tile servers block embedded
 * clients.
 *
 * **The projection is the component.** A map that looks plausible and is wrong
 * is exactly the failure this component exists to prevent, so
 * `tests/mapview-projection.test.ts` pins `mercY`, `step`, the pin positions
 * and the scale-bar distance against coordinates whose answers were computed
 * by hand rather than read off a screenshot.
 */
export interface MapPin {
  lat: number;
  lon: number;
  label?: string;
  meta?: string;
  tone?: Tone;
  /**
   * The pin's number in the list the map illustrates. In `pinMode="number"`
   * it is the badge; in label mode it leads the label (`1 Vathy`), so the
   * map and the list name a place the same way.
   */
  n?: number;
}

/** A merge the drawing made: which pins sit under one mark. */
export interface MapCluster {
  /** `A`, `B`, … in order of each cluster's first member. */
  letter: string;
  /** The members' `n`, first member first. Pins without an `n` are left out. */
  members: number[];
}

/**
 * Closed rings of land, filled so a reader can tell water from shore.
 *
 * Separate from `paths` rather than a flag on it, because they are different
 * things and D25 called this before it was built: a route is a line somebody
 * travelled and land is the ground it was travelled over. Conflating them would
 * make "is this filled" a property of every polyline the caller passes.
 *
 * Rendered as ONE path with `fill-rule: evenodd`, which is what makes a lagoon
 * inside an island come out as a hole without anyone having to say so. Even-odd
 * ignores winding, and that matters here: every coastal ring OSM returns is
 * counter-clockwise — 486 of 486 across three of the fixture locations — so a
 * non-zero rule would fill an inner lagoon solid.
 */
export interface MapLand {
  /** Each ring is a closed `[lon, lat]` loop; the first and last coincide. */
  rings: [number, number][][];
}

export interface MapPath {
  /** `[lon, lat]`, in that order — `coords[0]` is projected as longitude. */
  coords: [number, number][];
  tone?: Tone;
  width?: number;
}

export interface MapViewProps {
  /** Single-pin shorthand, used only when `pins` is empty. */
  lat?: number;
  lon?: number;
  pinLabel?: string;
  pins?: MapPin[];
  paths?: MapPath[];
  /** Minimum span in kilometres. The view widens past it to fit the pins. */
  spanKm?: number;
  /**
   * The fix's uncertainty, in metres — a radius around the FIRST pin.
   *
   * Two things follow from it. The span becomes `max(spanKm, 6 × accuracyM)`,
   * a max rather than a "coarse" branch, so there is no threshold to argue
   * about and a 30 m fix and a 2 km fix get the same rule; six is the smallest
   * multiple that leaves the ring under two-thirds of the frame once the
   * margins are taken. And the uncertainty is DRAWN, at true projected scale,
   * because a pin without it claims a precision the fix does not have. Below
   * 14px across it is not drawn: at that size the ring sits inside the pin's
   * own glow, and the pin already is the uncertainty.
   */
  accuracyM?: number;
  /**
   * The agent's own sentence about the fix. Prose in the body font — not the
   * mono line, which is machine fact — inside the card under a hairline rather
   * than floating beneath it: a loose line under a card belongs to nothing,
   * and a transcript already reads a gap as a new block.
   */
  note?: string;
  /**
   * The card's cap, default 420. Past that the graticule spaces out into
   * decoration and the card starts competing with the answer it belongs to.
   * Narrower panes get 100%.
   */
  maxWidth?: number;
  /**
   * Pins whose projected centres land within this many pixels of an
   * already-placed pin are absorbed into it: the survivor's label gains `+N`
   * and the absorbed pins draw nothing. Default 34. "Resolved by clustering,
   * never truncating — the kit does not truncate a place name or a path
   * anywhere, because half a name is worse than a count."
   */
  clusterPx?: number;
  title?: string;
  subtitle?: string;
  meta?: string;
  icon?: IconName;
  height?: number;
  /** The projection's pixel width. The rendered card is fluid; this is the
   * SVG's coordinate space and the divisor in metres-per-pixel. */
  width?: number;
  /**
   * The source credit for `paths`, rendered under the foot row.
   *
   * **Required by the licence, not by the design**, whenever the geometry came
   * from OpenStreetMap: the drawn map is a Produced Work and carries no
   * share-alike, but it must still say where the shape came from. The kit
   * fixtures export the exact string as `OSM_ATTRIBUTION`.
   *
   * It is a prop rather than something this component infers because the
   * component cannot know where a caller's `paths` came from — a consumer
   * drawing their own survey has nothing to credit, and inventing a credit for
   * them would be worse than omitting one.
   *
   * A document showing several maps from one source only has to say so once;
   * that is the caller's call, because only the caller can see the document.
   * Pass it on the map that carries the credit and omit it on the rest.
   */
  attribution?: string;
  /**
   * Filled land. A coastline stroke says where the edge is and not which side
   * of it is water, and that is the first thing a reader needs.
   *
   * Optional and separate, so a caller with coastline and no rings to go with
   * it draws the stroke and no fill rather than guessing at a shape. A mainland
   * bbox used to be that caller; `@schlessera/brain-ui-sdk`'s geometry now
   * closes an open shore against the viewport and hands one back, and it is
   * still the caller's to pass or not.
   */
  land?: MapLand;
  /**
   * `"label"` (the default) is the map as it always was: a dot and its name.
   * `"number"` draws each pin as a numbered badge, never a name, and a merge
   * as a lettered badge (`A·5`), so every place stays identifiable on a map
   * too crowded for names. A merged pin is then never silent: the container
   * hears about it through `onClusters` and says so in its list.
   */
  pinMode?: "label" | "number";
  /**
   * Called with the merges the drawing actually made, at the width it is
   * actually drawn. A data callback from the drawing to its container, not a
   * payload field: the list under a map says `in A` only because of it. Fires
   * after layout, and again only when the merges change.
   */
  onClusters?: (clusters: MapCluster[]) => void;
  /**
   * Where cluster lettering starts, as an index (0 = `A`). Two maps that
   * share one list continue each other's letters rather than both saying `A`.
   */
  letterFrom?: number;
  /**
   * The top-left coordinate chip. Default on. It names the FIRST pin, which
   * is right for one pin and reads as the map's centre for several.
   */
  coordChip?: boolean;
  /**
   * An accessible name for the drawing. The viewport becomes `role="img"`
   * with this label, so what is drawn inside it is presentational;
   * `describedBy` points at the text equivalent, which for a place map is
   * its list.
   */
  describe?: { label: string; describedBy?: string };
  /**
   * Default true. False drops the card's own border, radius and width cap,
   * so a container that owns the card can put the drawing flush inside it.
   */
  framed?: boolean;
}

/** A pin is a 10px disc: the `mark` role, which is the step a darkened accent
 * would need on paper. */
const MARKS: Record<Tone, string> = {
  amber: accent.amber.mark,
  gold: accent.gold.mark,
  teal: accent.teal.mark,
  purple: accent.purple.mark,
  blue: accent.blue.mark,
  red: accent.red.mark,
  neutral: accent.neutral.mark,
};

/** A path is a 2px stroke, also a mark. */
/** A numbered badge is a solid disc that takes `on-fill` text on top. */
const FILLS: Record<Tone, string> = {
  amber: accent.amber.fill,
  gold: accent.gold.fill,
  teal: accent.teal.fill,
  purple: accent.purple.fill,
  blue: accent.blue.fill,
  red: accent.red.fill,
  neutral: accent.neutral.fill,
};

const RINGS: Record<Tone, string> = {
  amber: token("map-pin-ring-amber"),
  gold: token("map-pin-ring-gold"),
  teal: token("map-pin-ring-teal"),
  purple: token("map-pin-ring-purple"),
  blue: token("map-pin-ring-blue"),
  red: token("map-pin-ring-red"),
  neutral: token("map-pin-ring-neutral"),
};

const LABEL_BORDERS: Record<Tone, string> = {
  amber: token("map-pin-border-amber"),
  gold: token("map-pin-border-gold"),
  teal: token("map-pin-border-teal"),
  purple: token("map-pin-border-purple"),
  blue: token("map-pin-border-blue"),
  red: token("map-pin-border-red"),
  neutral: token("map-pin-border-neutral"),
};

/**
 * Web Mercator's y, in the projection's own units (not pixels).
 *
 * Clamped to ±85° because the projection diverges at the poles: `tan(π/4 +
 * φ/2)` goes to infinity at 90°, and a map that renders `Infinity` renders
 * nothing at all.
 */
/** Degrees to radians. Mercator's x IS longitude in radians, which is the unit
 * the aspect correction has to reason in. */
const DEG = Math.PI / 180;

export function mercY(lat: number): number {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

/**
 * The graticule interval: the smallest nice number that puts at most five
 * lines across the span, so the grid reads as degrees rather than as ruling.
 * Falls through to 30° for a span wide enough that even 20° gives more than
 * five — which is a hemisphere.
 */
export function step(span: number): number {
  const nice = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20];
  for (const n of nice) if (span / n <= 5) return n;
  return 30;
}

/** The distances the scale bar is allowed to claim, in metres. */
/** The pin marker's diameter. Named because the row's offset is half of it. */
const DOT = 10;

const NICE_METRES = [50, 100, 200, 250, 500, 1000, 2000, 5000];

/**
 * The ground `MapView` draws for these pins in a `width` × `height` viewport:
 * longitude `mw`..`me`, Mercator y `yBot`..`yTop` and the same in latitude.
 *
 * Exported because a container that fetches geometry for the drawing has to
 * ask for a box that covers it, and "what the component will draw" is this
 * component's rule and nobody else's. `@schlessera/brain-ui-sdk`'s place-map
 * plan repeats it (the SDK cannot import the kit) and
 * `packages/ui-react/tests/map-block.test.ts` holds the two together.
 */
export function mapViewBounds(
  pins: ReadonlyArray<{ lat: number; lon: number }>,
  opts: { width: number; height?: number; spanKm?: number; accuracyM?: number },
): { mw: number; me: number; yTop: number; yBot: number; latTop: number; latBot: number; midLat: number } {
  const lons = pins.map((s) => Number(s.lon));
  const lats = pins.map((s) => Number(s.lat));
  // THE SPAN RULE. The frame's job is to contain the uncertainty with room
  // left to read it, so the span is the larger of the caller's minimum and six
  // times the accuracy radius. A max, not a branch: see `accuracyM`.
  const accM = Math.max(0, Number(opts.accuracyM) || 0);
  const spanKm = Math.max(Number(opts.spanKm) || 1.6, (accM * 6) / 1000);

  // 111 km per degree of latitude. Longitude shrinks by cos(lat), floored at
  // 0.2 so a high-latitude view does not blow the box up to a hemisphere.
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  // `spanKm` is the span across the WIDTH. It used to be applied to both axes,
  // which was harmless while the projection stretched each axis to fill the box
  // independently — but once one pixel is the same distance in both directions,
  // a minimum on the short axis means the long one shows roughly twice it, and
  // a card captioned "18 km" was drawing forty. The caption is the contract.
  const degLon = spanKm / 111 / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  // Latitude gets no minimum of its own: the aspect correction below grows
  // whichever axis is short, so the height follows from the width and the card.
  const degLat = 0;

  let west = Math.min(...lons);
  let east = Math.max(...lons);
  let south = Math.min(...lats);
  let north = Math.max(...lats);
  // `spanKm` is a MINIMUM: a single pin, or two close together, is widened to
  // it; a bounding box already larger keeps its own extent.
  if (east - west < degLon) {
    const c = (east + west) / 2;
    west = c - degLon / 2;
    east = c + degLon / 2;
  }
  if (north - south < degLat) {
    const c = (north + south) / 2;
    south = c - degLat / 2;
    north = c + degLat / 2;
  }
  // 12% margin east-west, 14% north-south, so a pin at the edge of the bounding
  // box is never at the edge of the drawing.
  let mw = west - (east - west) * 0.12;
  let me = east + (east - west) * 0.12;
  const ms = south - (north - south) * 0.14;
  const mn = north + (north - south) * 0.14;

  /**
   * ONE SCALE FOR BOTH AXES, and this is where that is made true.
   *
   * Web Mercator is conformal: at any point, a step in longitude degrees and
   * the same step in mercator-y cover the same distance on the ground. So the
   * drawing is undistorted exactly when the bbox's longitude range and its
   * mercator-y range are in the same ratio as the box they are drawn into.
   *
   * They are not, in general — the bbox comes from the pins, plus a minimum
   * span, plus margins that differ per axis — so the short axis is WIDENED
   * until it matches. Widened, never cropped: cropping to fit would push a pin
   * out of the view it was the reason for. A wider card therefore shows more
   * ground at the same scale, which is the difference between panning and
   * stretching.
   */
  let yTop = mercY(mn);
  let yBot = mercY(ms);
  const wantRatio = opts.width / Math.max(110, Math.min(260, Number(opts.height) || 170));
  // `mercY` is the conformal y in RADIANS (`ln tan`), and the bbox holds
  // longitude in DEGREES. Comparing them directly is out by a factor of 57 and
  // widens the wrong axis by two orders of magnitude — 0.05 degrees of latitude
  // drawn 2.9px tall beside 0.05 degrees of longitude drawn 129px wide. In
  // Mercator, longitude-in-radians and y are the same units by construction, so
  // that is what the ratio has to be taken in.
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

  // The correction moved the view in MERCATOR y, so the latitude bounds it was
  // derived from are now stale — and `step()` reads them to choose the
  // graticule interval. Left stale, the latitude span looks like almost
  // nothing and the interval comes out so fine that the labels pile on top of
  // one another. Invert the mercator back to degrees and use that.
  const unmercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
  const latTop = unmercY(yTop);
  const latBot = unmercY(yBot);

  return { mw, me, yTop, yBot, latTop, latBot, midLat };
}

/** `A`…`Z`, then `AA`, `AB`…: a letter per merge, never a number that could
 * be mistaken for a pin's own. */
export function clusterLetter(index: number): string {
  let out = "";
  let i = index;
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

/** The numbered badge's diameter: a pin you can read a two-digit number in. */
const BADGE = 18;

export function MapView(p: MapViewProps) {
  /**
   * THE PROJECTION IS BUILT FOR THE WIDTH THE CARD ACTUALLY IS.
   *
   * The card is fluid and the drawing is not: a viewBox sized to a fixed
   * `width` either letterboxes inside a wider card (`meet`, the SVG default) or
   * stretches to fill it (`none`). Stretching is the one a map may never do —
   * a degree of longitude and a degree of latitude stop being the same distance
   * on screen, the scale bar stops being true in every direction, and an island
   * gets wider as the window does.
   *
   * Measuring is what removes the choice. With the viewBox at the element's own
   * width, its aspect and the box's are identical, `preserveAspectRatio` has
   * nothing to decide, and the percentage-positioned overlays land exactly
   * where the geometry does. The bbox is then EXPANDED to that aspect below —
   * so a wider card shows more ground rather than the same ground stretched,
   * which is what "fill by panning, never by distorting" means in practice.
   *
   * `width` remains the fallback for the first paint and for server rendering,
   * where there is nothing to measure.
   */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      // Sub-pixel churn would re-project on every scroll on some browsers.
      if (next > 0) setMeasured((current) => (current !== null && Math.abs(current - next) < 1 ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const W = measured ?? (Number(p.width) || 330);
  // Aspect is bounded so the server's geometry envelope can be too: a card is
  // at most 420px wide and its viewport runs 110-260px tall. The widest card
  // (420x110) draws 1.24x the span across and 0.32x down; the tallest
  // (420x260) draws 0.77x down. An envelope of 1.5x wide and 1.0x tall
  // therefore covers every card that can exist.
  const H = Math.max(110, Math.min(260, Number(p.height) || 170));

  if (p.pins && !Array.isArray(p.pins)) warnOnce("MapView: `pins` is not an array; the single-pin fallback will draw instead.");
  if (p.paths && !Array.isArray(p.paths)) warnOnce("MapView: `paths` is not an array; no route will draw.");

  // The fallback is Ithaca: 38.3647, 20.7202, read from the Wikipedia geotag
  // for Vathy. A made-up coordinate would draw a wrong map with a confidently
  // wrong scale bar underneath it, which is the one thing this component must
  // never do — so even the stand-in content is a real place.
  const src = (
    p.pins && p.pins.length
      ? p.pins
      : [
          {
            lat: Number(p.lat ?? 38.3647),
            lon: Number(p.lon ?? 20.7202),
            label: p.pinLabel ?? "Vathy",
            tone: "amber" as Tone,
          },
        ]
  ).map((pin) => ({
    lat: Number(pin.lat),
    lon: Number(pin.lon),
    label: pin.label,
    meta: pin.meta,
    tone: pin.tone || ("amber" as Tone),
    n: "n" in pin && typeof pin.n === "number" ? pin.n : undefined,
  }));

  // THE SPAN RULE lives in `mapViewBounds`, so a container that has to
  // fetch geometry for this drawing can ask what it will cover.
  const accM = Math.max(0, Number(p.accuracyM) || 0);
  const { mw, me, yTop, yBot, latTop, latBot, midLat } = mapViewBounds(src, {
    width: W,
    height: H,
    spanKm: p.spanKm,
    accuracyM: accM,
  });

  const px = (lon: number) => ((lon - mw) / (me - mw)) * W;
  const py = (lat: number) => ((yTop - mercY(lat)) / (yTop - yBot)) * H;

  // The SVG scales to the card's width; these absolutely-positioned overlays do
  // not. Placing them at the projected SVG pixel puts a pin at CSS x=99 while
  // the coastline it marks is drawn at CSS x=70 — 30% of the box out, and
  // invisible until the card renders at a width other than `W`. Percentages of
  // the same box scale with the drawing, which is the only thing that keeps a
  // pin on its own shoreline at every width. Measured in
  // `tests/mapview-projection.test.tsx`, which reads these very strings.
  const pctX = (x: number) => `${((x / W) * 100).toFixed(4)}%`;
  const pctY = (y: number) => `${((y / H) * 100).toFixed(4)}%`;

  /*
   * Label collisions are resolved by CLUSTERING, not by truncating (the
   * fourth drop's answer to design-feedback §16). Two rules, both computable
   * without measuring text:
   *   1. a pin whose projected centre sits within `clusterPx` of an
   *      already-placed pin joins it; the survivor carries `+N` and the
   *      absorbed pins draw nothing;
   *   2. `meta` is dropped past 70% of the width, where the label has already
   *      flipped and the remaining room cannot be known at render time. The
   *      pin keeps its name; only the secondary figure goes.
   * Two passes, as the source has them: project and absorb, then style.
   */
  const clusterPx = Number(p.clusterPx) || 34;
  const numbered = p.pinMode === "number";
  const placed: {
    x: number;
    y: number;
    extra: number;
    tone: Tone;
    label?: string;
    meta?: string;
    n?: number;
    members: number[];
    letter?: string;
  }[] = [];
  for (const pin of src) {
    const x = px(pin.lon);
    const y = py(pin.lat);
    const host = placed.find((q) => Math.hypot(q.x - x, q.y - y) < clusterPx);
    if (host) {
      host.extra += 1;
      if (pin.n !== undefined) host.members.push(pin.n);
      continue;
    }
    placed.push({
      x,
      y,
      extra: 0,
      tone: pin.tone,
      label: pin.label,
      meta: pin.meta,
      n: pin.n,
      members: pin.n !== undefined ? [pin.n] : [],
    });
  }
  // Letters go to merges in the order of each merge's first member, which is
  // the order `placed` is already in: payload order, greedy, as above.
  const letterFrom = Math.max(0, Math.floor(Number(p.letterFrom) || 0));
  const clusters: MapCluster[] = [];
  for (const mark of placed) {
    if (!mark.extra) continue;
    mark.letter = clusterLetter(letterFrom + clusters.length);
    clusters.push({ letter: mark.letter, members: mark.members });
  }
  // Reported after layout and only on change, so a container that re-renders
  // with the answer does not loop on its own state.
  const clusterKey = JSON.stringify(clusters);
  const onClustersRef = useRef(p.onClusters);
  onClustersRef.current = p.onClusters;
  useEffect(() => {
    onClustersRef.current?.(JSON.parse(clusterKey) as MapCluster[]);
  }, [clusterKey]);

  const lonStep = step(me - mw);
  const latStep = step(latTop - latBot);

  const labelStyle: CSSProperties = {
    position: "absolute",
    zIndex: 2,
    font: `500 9px/1 ${font.mono}`,
    color: accent.neutral.ink,
    whiteSpace: "nowrap",
  };
  // Labels are suppressed wherever they would collide: the bottom-right band
  // belongs to the scale bar, and a label needs room to sit fully inside the
  // viewport. Suppressed, not thinned — an unreadable label is worse than a
  // missing one, and the graticule line itself still draws.
  const scaleBandX = W - 130;
  const labelBandY = H - 20;

  const grid: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const gridLabels: { text: string; style: CSSProperties }[] = [];

  for (let lon = Math.ceil(mw / lonStep) * lonStep; lon <= me; lon += lonStep) {
    const x = px(lon);
    grid.push({ x1: x, y1: 0, x2: x, y2: H });
    if (x < scaleBandX - 34 && x > 40) {
      gridLabels.push({
        text: `${lon.toFixed(lonStep < 0.01 ? 3 : 2)}°`,
        style: { ...labelStyle, left: `calc(${pctX(x)} + 4px)`, top: pctY(labelBandY) },
      });
    }
  }
  for (let lat = Math.ceil(latBot / latStep) * latStep; lat <= latTop; lat += latStep) {
    const y = py(lat);
    grid.push({ x1: 0, y1: y, x2: W, y2: y });
    if (y > 26 && y < labelBandY - 12) {
      gridLabels.push({
        text: `${lat.toFixed(latStep < 0.01 ? 3 : 2)}°`,
        style: { ...labelStyle, left: 6, top: `calc(${pctY(y)} + 3px)` },
      });
    }
  }

  // One `d` for every ring, so the even-odd rule can see them together: a
  // lagoon is only a hole relative to the island around it, and two separate
  // <path> elements cannot know about each other.
  const land = (p.land?.rings ?? [])
    .filter((ring) => ring.length > 2)
    .map(
      (ring) =>
        `M${ring.map((c) => `${px(Number(c[0])).toFixed(1)},${py(Number(c[1])).toFixed(1)}`).join("L")}Z`,
    )
    .join("") || null;

  const paths = (p.paths || []).map((path) => ({
    points: (path.coords || [])
      .map((c) => `${px(Number(c[0])).toFixed(1)},${py(Number(c[1])).toFixed(1)}`)
      .join(" "),
    stroke: MARKS[path.tone || "teal"] || MARKS.teal,
    width: path.width || 2,
  }));

  // Metres per pixel at the view's own latitude, which is what makes the scale
  // bar true rather than decorative. The bar aims for 22% of the width and then
  // snaps to whichever nice distance is nearest, so its LABEL is a round number
  // and its LENGTH is whatever that number actually measures.
  const mPerPx = ((me - mw) * 111320 * Math.cos((midLat * Math.PI) / 180)) / W;
  const target = W * 0.22;
  const rawM = mPerPx * target;
  const niceM = NICE_METRES.reduce((a, b) => (Math.abs(b - rawM) < Math.abs(a - rawM) ? b : a), 50);

  // The uncertainty ring, in the SVG's own coordinate space: `mPerPx` is
  // metres per viewBox unit, and the viewBox is the measured width, so this
  // radius is the ring's true size on the same drawing the scale bar measures.
  // A `vector-effect="non-scaling-stroke"` hairline, like the graticule's.
  const ringPx = accM / mPerPx;
  const ring = accM > 0 && ringPx * 2 >= 14 ? { cx: px(src[0].lon), cy: py(src[0].lat), r: ringPx } : null;

  // The footer's stand-in content. Ithaca is the destination behind every open
  // loop in this world, and `meta` is what the source's was: how far the pin is
  // from the person reading the card. 628 km is the great-circle distance from
  // Ogygia — where the owner of this brain is this morning — to Vathy, computed
  // from the two coordinates in `fixtures/places.ts` rather than chosen to look
  // plausible. A component that refuses to draw an invented map should not
  // caption itself with an invented number either.
  const title = p.title ?? "Ithaca";
  const subtitle = p.subtitle ?? "Vathy · the hall, and 108 guests in it";
  const meta = p.meta ?? "628 km";

  const framed = p.framed !== false;
  const box: CSSProperties = framed
    ? {
        border: `1px solid ${color.line}`,
        background: color.surface,
        borderRadius: 14,
        overflow: "hidden",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: Number(p.maxWidth) || 420,
        flex: "none",
      }
    : { width: "100%", boxSizing: "border-box", flex: "none" };
  const viewport: CSSProperties = {
    position: "relative",
    width: "100%",
    height: H,
    overflow: "hidden",
    background: `radial-gradient(120% 90% at 50% 40%,${token("map-sky-inner")},${token("map-sky-outer")} 70%)`,
  };

  return (
    <div style={box}>
      <div
        ref={viewportRef}
        style={viewport}
        {...(p.describe
          ? {
              role: "img",
              "aria-label": p.describe.label,
              ...(p.describe.describedBy ? { "aria-describedby": p.describe.describedBy } : {}),
            }
          : {})}
      >
        {/* `preserveAspectRatio="none"` is not a style choice, it is what the
         * projection already assumes: `px()` maps the bbox's longitude range
         * across the FULL width and `py()` maps its latitude range across the
         * full height, independently, with different margins on each axis. The
         * mapping is already anisotropic, so letting the SVG letterbox its
         * content — the default `xMidYMid meet` — scaled the drawing uniformly
         * and centred it, which put the geometry somewhere the component's own
         * arithmetic says it is not. The strokes keep their width through
         * `vector-effect`, the same pairing `GraphView` uses. */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        >
          {grid.map((g, i) => (
            <line
              key={`g${i}`}
              x1={g.x1}
              y1={g.y1}
              x2={g.x2}
              y2={g.y2}
              stroke={token("map-graticule")}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Under everything: the graticule reads THROUGH land, and the route
           * and the coastline read over it. A fill drawn after the coastline
           * would swallow its own outline. */}
          {land ? (
            <path
              d={land}
              fill={token("map-land")}
              // Even-odd, so a ring inside a ring is a hole. See `MapLand`.
              fillRule="evenodd"
              stroke="none"
            />
          ) : null}
          {/* Above the graticule and the land, under the route: the tint has
           * to read over the ground it sits on, and a path drawn across the
           * ring still has to read as the subject. */}
          {ring ? (
            <circle
              cx={ring.cx.toFixed(1)}
              cy={ring.cy.toFixed(1)}
              r={ring.r.toFixed(1)}
              fill={token("map-accuracy-fill")}
              stroke={token("map-accuracy-ring")}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {paths.map((path, i) => (
            <polyline
              key={`p${i}`}
              points={path.points}
              fill="none"
              stroke={path.stroke}
              strokeWidth={path.width}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {gridLabels.map((lab, i) => (
          <span key={`l${i}`} style={lab.style}>
            {lab.text}
          </span>
        ))}
        {placed.map((pin, i) => {
          const c = MARKS[pin.tone] || MARKS.amber;
          const x = pin.x;
          if (numbered) {
            // A badge is centred on its coordinate: it has no label to lead,
            // so the mark IS the row. A merge is a rounded square rather than
            // a disc, so a letter can never be read as a number.
            const text = pin.letter ? `${pin.letter}·${pin.extra + 1}` : pin.n !== undefined ? String(pin.n) : "";
            return (
              <div
                key={`pin${i}`}
                data-pin={pin.letter ? "cluster" : "badge"}
                style={{
                  position: "absolute",
                  left: pctX(x),
                  top: pctY(pin.y),
                  transform: "translate(-50%, -50%)",
                  zIndex: 3,
                  boxSizing: "border-box",
                  minWidth: BADGE,
                  height: pin.letter ? 22 : BADGE,
                  padding: pin.letter ? "0 6px" : "0 4px",
                  borderRadius: pin.letter ? 6 : BADGE / 2,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: FILLS[pin.tone] || FILLS.amber,
                  color: color.onFill,
                  font: `700 10px/1 ${font.mono}`,
                  whiteSpace: "nowrap",
                  boxShadow: `0 0 0 2px ${token("map-halo")}, 0 0 0 3.5px ${RINGS[pin.tone] || RINGS.amber}`,
                }}
              >
                {text}
              </div>
            );
          }
          const named = pin.n !== undefined && pin.label ? `${pin.n} ${pin.label}` : pin.label;
          const label = pin.extra ? `${named || "here"} +${pin.extra}` : named;
          const meta = x <= W * 0.7 && !pin.extra ? pin.meta : undefined;
          // A label on a pin in the right-hand third would run off the edge, so
          // the row reverses and the label sits to the left of its own dot.
          const flip = x > W * 0.62;
          return (
            <div
              key={`pin${i}`}
              style={{
                position: "absolute",
                left: pctX(x),
                top: pctY(pin.y),
                // THE DOT marks the coordinate, not the row.
                //
                // `translate(-50%, -50%)` centres the whole flex row — dot, gap
                // and label — on the projected point, which puts the dot itself
                // half a label to one side of the place it is marking: measured
                // at 44px in a 238px card, about 19% of the width. Two pins
                // with labels of different lengths are then displaced by
                // different amounts, so the distance BETWEEN them is wrong too,
                // under a scale bar that claims to measure it. Nothing caught
                // it because `tests/mapview-projection.test.tsx` reads `left`,
                // which is the row's anchor and was always correct.
                //
                // So the row is shifted by half a dot instead: leftwards when
                // the dot leads, and by its own width less half a dot when the
                // row is reversed and the dot trails.
                transform: flip
                  ? `translate(calc(-100% + ${DOT / 2}px), -50%)`
                  : `translate(-${DOT / 2}px, -50%)`,
                zIndex: 3,
                display: "flex",
                flexDirection: flip ? "row-reverse" : "row",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: DOT,
                  height: DOT,
                  borderRadius: "50%",
                  flex: "none",
                  background: c,
                  boxShadow: `0 0 0 3px ${token("map-halo")}, 0 0 0 5px ${RINGS[pin.tone] || RINGS.amber}`,
                }}
              />
              {label ? (
                <span
                  style={{
                    background: token("map-label-bg"),
                    border: `1px solid ${LABEL_BORDERS[pin.tone] || LABEL_BORDERS.amber}`,
                    borderRadius: 7,
                    padding: "3px 7px",
                    font: `500 10px/1.35 ${font.mono}`,
                    color: c,
                  }}
                >
                  {label}
                  {meta ? (
                    <span style={{ marginLeft: 6, color: accent.neutral.ink }}>{meta}</span>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })}
        {/* The scale row spans the WHOLE viewport rather than shrink-wrapping
         * at the right edge, because the bar's length is a percentage and a
         * percentage resolves against its containing block: inside a
         * shrink-to-fit flex box that is circular, and the bar collapsed to a
         * few pixels. `left: 0; right: 0` with no horizontal padding makes the
         * containing block exactly the drawing, so the percentage is exactly
         * the fraction of the map the bar claims to measure. The 10px inset
         * moves to the LABEL's margin, where it cannot change the basis. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 8,
            zIndex: 4,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              display: "block",
              // A PERCENTAGE of the box, not the projected pixel. The bar is an
              // HTML overlay on a drawing that scales to the card's fluid
              // width, so a fixed pixel length claims a distance the map is not
              // drawn at the moment the card is not exactly `width` wide — and
              // a scale bar that is wrong is worse than no scale bar, because
              // it is the thing a reader trusts to measure with.
              width: `${((niceM / mPerPx / W) * 100).toFixed(4)}%`,
              // A flex item shrinks; a scale bar must not. Its length IS the
              // claim it makes.
              flex: "none",
              height: 3,
              borderRadius: 2,
              background: token("map-scale-bar"),
              borderLeft: `1px solid ${token("map-scale-cap")}`,
              borderRight: `1px solid ${token("map-scale-cap")}`,
            }}
          />
          <span
            style={{
              font: `500 9px/1 ${font.mono}`,
              color: color.inkDim,
              whiteSpace: "nowrap",
              flex: "none",
              marginRight: 10,
            }}
          >
            {niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`}
          </span>
        </div>
        {p.coordChip !== false ? (
          <div
            style={{
              position: "absolute",
              left: 10,
              top: 8,
              zIndex: 4,
              font: `500 9px/1 ${font.mono}`,
              color: accent.neutral.ink,
              background: token("map-coord-bg"),
              borderRadius: 4,
              padding: "2px 5px",
            }}
          >
            {`${src[0].lat.toFixed(4)}, ${src[0].lon.toFixed(4)}`}
          </div>
        ) : null}
      </div>
      {title || p.attribution ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            // A map with geometry and no title still owes its credit, so the
            // foot row is no longer gated on the title alone. The padding drops
            // when the row carries only the credit: a lone 9px line in a 10px
            // band reads as an empty row rather than as a footnote.
            padding: title ? "10px 12px" : "6px 12px",
            borderTop: `1px solid ${color.line}`,
          }}
        >
          {title ? <Icon icon={p.icon || "graph"} size={14} color={accent.teal.ink} /> : null}
          <span style={{ flex: 1, minWidth: 0 }}>
            {title ? (
              <b style={{ display: "block", font: `600 12.5px/1.35 ${font.body}`, color: color.ink }}>
                {title}
              </b>
            ) : null}
            {subtitle ? (
              <span
                style={{
                  display: "block",
                  marginTop: 2,
                  font: `400 10.5px/1.45 ${font.body}`,
                  color: accent.neutral.ink,
                }}
              >
                {subtitle}
              </span>
            ) : null}
            {p.attribution ? (
              // The quietest text in the component, deliberately: a credit is an
              // obligation to state the source, not an invitation to read it.
              // `ink-mute` on the card ground is the kit's floor for small text
              // and is measured in `tests/contrast.test.ts`.
              <span
                style={{
                  display: "block",
                  marginTop: title ? 3 : 0,
                  font: `400 9px/1.3 ${font.mono}`,
                  color: color.inkMute,
                }}
              >
                {p.attribution}
              </span>
            ) : null}
          </span>
          {meta ? (
            <span style={{ flex: "none", font: `500 10px/1 ${font.mono}`, color: accent.teal.ink }}>
              {meta}
            </span>
          ) : null}
        </div>
      ) : null}
      {p.note ? (
        <div
          style={{
            padding: "9px 12px 10px",
            borderTop: `1px solid ${color.line}`,
            font: `400 11.5px/1.55 ${font.body}`,
            color: color.inkDim,
            textWrap: "pretty",
          }}
        >
          {p.note}
        </div>
      ) : null}
    </div>
  );
}
