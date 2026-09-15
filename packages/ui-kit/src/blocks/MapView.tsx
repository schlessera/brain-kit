import type { CSSProperties } from "react";

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
  title?: string;
  subtitle?: string;
  meta?: string;
  icon?: IconName;
  height?: number;
  /** The projection's pixel width. The rendered card is fluid; this is the
   * SVG's coordinate space and the divisor in metres-per-pixel. */
  width?: number;
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
const NICE_METRES = [50, 100, 200, 250, 500, 1000, 2000, 5000];

export function MapView(p: MapViewProps) {
  const W = Number(p.width) || 330;
  const H = Number(p.height) || 170;

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
  }));

  const lons = src.map((s) => s.lon);
  const lats = src.map((s) => s.lat);
  const spanKm = Number(p.spanKm) || 1.6;

  // 111 km per degree of latitude. Longitude shrinks by cos(lat), floored at
  // 0.2 so a high-latitude view does not blow the box up to a hemisphere.
  const degLat = spanKm / 111;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const degLon = degLat / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

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
  const mw = west - (east - west) * 0.12;
  const me = east + (east - west) * 0.12;
  const ms = south - (north - south) * 0.14;
  const mn = north + (north - south) * 0.14;

  const yTop = mercY(mn);
  const yBot = mercY(ms);
  const px = (lon: number) => ((lon - mw) / (me - mw)) * W;
  const py = (lat: number) => ((yTop - mercY(lat)) / (yTop - yBot)) * H;

  const lonStep = step(me - mw);
  const latStep = step(mn - ms);

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
        style: { ...labelStyle, left: x + 4, top: labelBandY },
      });
    }
  }
  for (let lat = Math.ceil(ms / latStep) * latStep; lat <= mn; lat += latStep) {
    const y = py(lat);
    grid.push({ x1: 0, y1: y, x2: W, y2: y });
    if (y > 26 && y < labelBandY - 12) {
      gridLabels.push({
        text: `${lat.toFixed(latStep < 0.01 ? 3 : 2)}°`,
        style: { ...labelStyle, left: 6, top: y + 3 },
      });
    }
  }

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

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 14,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
    flex: "none",
  };
  const viewport: CSSProperties = {
    position: "relative",
    width: "100%",
    height: H,
    overflow: "hidden",
    background: `radial-gradient(120% 90% at 50% 40%,${token("map-sky-inner")},${token("map-sky-outer")} 70%)`,
  };

  return (
    <div style={box}>
      <div style={viewport}>
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
        {src.map((pin, i) => {
          const c = MARKS[pin.tone] || MARKS.amber;
          const x = px(pin.lon);
          // A label on a pin in the right-hand third would run off the edge, so
          // the row reverses and the label sits to the left of its own dot.
          const flip = x > W * 0.62;
          return (
            <div
              key={`pin${i}`}
              style={{
                position: "absolute",
                left: x,
                top: py(pin.lat),
                transform: "translate(-50%,-50%)",
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
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  flex: "none",
                  background: c,
                  boxShadow: `0 0 0 3px ${token("map-halo")}, 0 0 0 5px ${RINGS[pin.tone] || RINGS.amber}`,
                }}
              />
              {pin.label ? (
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
                  {pin.label}
                  {pin.meta ? (
                    <span style={{ marginLeft: 6, color: accent.neutral.ink }}>{pin.meta}</span>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })}
        <div
          style={{
            position: "absolute",
            right: 10,
            bottom: 8,
            zIndex: 4,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              display: "block",
              width: Math.round(niceM / mPerPx),
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
            }}
          >
            {niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`}
          </span>
        </div>
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
      </div>
      {title ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "10px 12px",
            borderTop: `1px solid ${color.line}`,
          }}
        >
          <Icon icon={p.icon || "graph"} size={14} color={accent.teal.ink} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <b style={{ display: "block", font: `600 12.5px/1.35 ${font.body}`, color: color.ink }}>
              {title}
            </b>
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
          </span>
          {meta ? (
            <span style={{ flex: "none", font: `500 10px/1 ${font.mono}`, color: accent.teal.ink }}>
              {meta}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
