// Real coastline, as `MapView` paths.
//
// The geometry is OpenStreetMap's, simplified to one pixel of the render it is
// drawn at. **It is ODbL, unlike everything else in this repository** — see
// `LICENSE` in this directory before copying a file out of it, and note that
// the rendered map is a Produced Work and carries no such obligation.
//
// `tools/geo/generate.ts` regenerates these files. Run it by hand; Overpass is
// not for a test suite.
//
// ## Why coastline at all
//
// The graticule and scale bar alone make an accurate locator and an
// unrecognisable picture — a radar view. D25 measured the alternatives: raster
// tiles are out (a browser component cannot identify itself to a tile server,
// every keyless provider forbids commercial use, and a visual-regression suite
// panning a map is exactly what OSM's policy calls bulk downloading), and
// Natural Earth, which is public domain and would have been the easy answer, is
// five to ten times too coarse at these spans.
//
// ## Tone is the caller's, and quiet is the point
//
// Coastline is CONTEXT, not content: it says where, and the pins and the route
// say what. It goes in at `neutral` and hairline width so a 2px amber route
// still reads as the subject. A scene that draws its coastline as loudly as its
// route has buried its own argument.

import type { MapPath } from "../../src/blocks/MapView.js";

import corfu from "./corfu.json" with { type: "json" };
import gozo from "./gozo.json" with { type: "json" };
import ithaca from "./ithaca.json" with { type: "json" };
import messina from "./messina.json" with { type: "json" };
import troy from "./troy.json" with { type: "json" };

/** One generated file, as `tools/geo/generate.ts` writes it. */
export interface GeoFixture {
  id: string;
  label: string;
  /** `[lon, lat]`, matching `MapPath["coords"]`. */
  center: [number, number];
  spanKm: number;
  /** The simplification tolerance in metres — one pixel of the target render. */
  toleranceM: number;
  attribution: string;
  coastline: [number, number][][];
  /** Only where coastline alone does not locate you. Troy has them. */
  roads: [number, number][][];
}

/**
 * A JSON import widens every tuple: `[lon, lat]` arrives as `number[]`, so
 * `center` and every coordinate lose the pair-ness `MapPath` requires. There is
 * no way to recover that from the type system — the file is data — so it is one
 * documented cast, and `tests/geo-fixtures.test.ts` checks the shape for real:
 * two numbers per coordinate, every one inside the Mediterranean basin, every
 * line at least two points long. An unchecked cast paired with an actual
 * assertion is honest; an unchecked cast on its own is a hope.
 */
function adopt(raw: unknown): GeoFixture {
  return raw as GeoFixture;
}

export const geo = {
  ithaca: adopt(ithaca),
  gozo: adopt(gozo),
  corfu: adopt(corfu),
  messina: adopt(messina),
  troy: adopt(troy),
} as const;

export type GeoId = keyof typeof geo;

export const geoIds = Object.keys(geo) as GeoId[];

/** The line every scene drawing this geometry has to carry. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * A location's geometry as `MapView` paths: coastline first, then roads, so a
 * road drawn over its own shoreline reads as a road.
 *
 * Roads come in a step quieter than the coast. Troy is the only place with
 * them and the reason is legibility rather than completeness — one shoreline
 * curve is ambiguous, and a road network is what turns it into a place — so
 * they must not compete with the coast that gives the picture its shape.
 */
export function geoPaths(id: GeoId): MapPath[] {
  const fixture = geo[id];
  return [
    ...fixture.coastline.map((coords) => ({ coords, tone: "neutral" as const, width: 1 })),
    ...fixture.roads.map((coords) => ({ coords, tone: "neutral" as const, width: 0.6 })),
  ];
}
