import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import raw from "../fixtures/geo/closure-probes.json" with { type: "json" };
import { geo, geoIds, OSM_ATTRIBUTION, type GeoId } from "../fixtures/geo/index.js";
import { MapView } from "../src/blocks/MapView.js";

type Point = [number, number];
type Rings = Point[][];
interface Witness {
  point: Point;
  source: { way: number; version: number; segment: [Point, Point] };
}
interface Closure {
  fixture: GeoId;
  id: string;
  land: Witness;
  sea: Witness;
}
// JSON widens tuples. The provenance/precision test below validates this data.
const closures = raw.closures as Closure[];
const coordinateError = Math.SQRT2 * 0.00005; // half of a four-decimal step on each axis
const pixelError = Math.SQRT2 * 0.05; // half of MapView's 0.1 px step on each axis

function envelope(id: GeoId): [number, number, number, number] {
  const { center: [lon, lat], spanKm } = geo[id];
  const dy = spanKm / 222;
  const dx = spanKm * 0.75 / 111 / Math.cos(lat * Math.PI / 180);
  return [lon - dx, lat - dy, lon + dx, lat + dy];
}

function viewportClosures(id: GeoId, rings: Rings): Rings {
  const [west, south, east, north] = envelope(id);
  return rings.filter((ring) => ring.filter(([x, y]) =>
    [Math.abs(x - west), Math.abs(x - east), Math.abs(y - south), Math.abs(y - north)]
      .some((d) => d < 1e-4)).length >= 2);
}

/** SVG closes each subpath, then applies even-odd across ALL subpaths. */
function filled(rings: Rings, [x, y]: Point): boolean {
  let result = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[(i + 1) % ring.length]!;
      if (ay > y !== by > y && x < (bx - ax) * (y - ay) / (by - ay) + ax) result = !result;
    }
  }
  return result;
}

function clearance(rings: Rings, [x, y]: Point): number {
  let nearest = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[(i + 1) % ring.length]!;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return nearest;
}

function expectedSide(closure: Closure, side: "land" | "sea", space: string): string {
  return `${closure.fixture}/${closure.id}: expected ${side} in ${space}`;
}

/** Independent records drive assertions even when observed geometry vanishes. */
function findings(id: GeoId, rings: Rings, expected = closures.filter((c) => c.fixture === id)): string[] {
  const errors: string[] = [];
  const observed = viewportClosures(id, rings);
  for (const c of expected) {
    for (const side of ["land", "sea"] as const) {
      if (filled(rings, c[side].point) !== (side === "land")) errors.push(expectedSide(c, side, "fixture fill"));
    }
    const matches = observed.filter((ring) => filled([ring], c.land.point));
    if (matches.length !== 1) errors.push(`${id}/${c.id}: expected one closure, observed ${matches.length}`);
    // Also ask the isolated closure, so other geometry cannot mask the answer.
    for (const ring of matches) {
      if (filled([ring], c.sea.point)) errors.push(expectedSide(c, "sea", "isolated closure"));
    }
  }
  for (const ring of observed) {
    const matches = expected.filter((c) => filled([ring], c.land.point));
    if (matches.length !== 1) errors.push(`${id}: observed closure has ${matches.length} independent identities; review coverage`);
  }
  return errors;
}

/** Read MapView's actual rounded SVG path and projected probe coordinates. */
function drawing(id: GeoId, rings: Rings, points: Point[]) {
  const { center: [lon, lat], spanKm } = geo[id];
  const html = renderToStaticMarkup(<MapView
    width={330} height={220} spanKm={spanKm} pins={[{ lon, lat }]}
    land={{ rings }} paths={points.map((point) => ({ coords: [point, point] }))}
  />);
  const paths = [...html.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]).filter((p) => p.includes('fill-rule="evenodd"'));
  expect(paths, `${id}: exactly one SVG even-odd land path`).toHaveLength(rings.length ? 1 : 0);
  const d = paths[0]?.match(/\bd="([^"]+)"/)?.[1] ?? "";
  const projected = d.split("M").filter(Boolean).map((ring) =>
    ring.replace(/Z$/, "").split("L").map((pair) => pair.split(",").map(Number) as Point));
  expect(projected, `${id}: no subpaths lost by the SVG parser`).toHaveLength(rings.length);
  const drawn = [...html.matchAll(/<polyline[^>]*points="([-\d.]+),([-\d.]+) /g)]
    .map((m) => [Number(m[1]), Number(m[2])] as Point);
  expect(drawn, `${id}: every probe reached the renderer`).toHaveLength(points.length);
  return { rings: projected, points: drawn };
}

function viewportRing(id: GeoId): Point[] {
  const [w, s, e, n] = envelope(id);
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

describe("independent viewport closure witnesses", () => {
  test("the oracle is nonempty, unique, attributed and covers every fixture", () => {
    expect(raw.attribution).toBe(OSM_ATTRIBUTION);
    expect(raw.sourceSnapshot).toBe("2026-09-30T13:42:06Z");
    expect(closures.length).toBeGreaterThan(0);
    expect(new Set(closures.map((c) => `${c.fixture}/${c.id}`)).size).toBe(closures.length);
    expect([...new Set(closures.map((c) => c.fixture))]).toEqual(geoIds);
  });

  for (const id of geoIds) {
    test(`${id}: expected and observed closures correspond one-to-one`, () => {
      expect(findings(id, geo[id].land)).toEqual([]);
    });

    test(`${id}: losing an expectation or adding a closure demands coverage review`, () => {
      const expected = closures.filter((c) => c.fixture === id);
      const missing = findings(id, geo[id].land, expected.slice(1));
      expect(missing).toContain(`${id}: observed closure has 0 independent identities; review coverage`);
      const extra = findings(id, [...geo[id].land, viewportRing(id)]);
      expect(extra.some((error) => error.includes("expected one closure, observed 2"))).toBe(true);
    });
  }

  for (const c of closures) {
    const name = `${c.fixture}/${c.id}`;
    test(`${name}: source sides and four-decimal clearance are unambiguous`, () => {
      const [w, s, e, n] = envelope(c.fixture);
      for (const side of ["land", "sea"] as const) {
        const { point: [x, y], source } = c[side];
        expect(source.way, `${name}/${side}: OSM way receipt`).toBeGreaterThan(0);
        expect(source.version).toBeGreaterThan(0);
        expect(source.segment).toHaveLength(2);
        const [[ax, ay], [bx, by]] = source.segment;
        const signed = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        expect(signed * (side === "land" ? 1 : -1), `${name}/${side}: raw OSM land-left convention`).toBeGreaterThan(0);
        expect(clearance([source.segment], [x, y]), `${name}/${side}: source shore clearance`).toBeGreaterThan(coordinateError);
        expect(Math.min(x - w, e - x, y - s, n - y), `${name}/${side}: envelope clearance`).toBeGreaterThan(coordinateError);
        expect(clearance(geo[c.fixture].land, [x, y]), `${name}/${side}: fixture clearance`).toBeGreaterThan(coordinateError);
      }
    });

    test(`${name}: MapView paints land and leaves sea clear after pixel rounding`, () => {
      const rendered = drawing(c.fixture, geo[c.fixture].land, [c.land.point, c.sea.point]);
      for (const [i, side] of (["land", "sea"] as const).entries()) {
        const point = rendered.points[i]!;
        expect(filled(rendered.rings, point), expectedSide(c, side, "SVG pixels")).toBe(side === "land");
        // Both the path and the probe have been rounded: account for both.
        expect(clearance(rendered.rings, point), `${name}/${side}: SVG rounding clearance`).toBeGreaterThan(2 * pixelError);
      }
    });

    test(`${name}: deletion fails its land and coverage assertions`, () => {
      const target = viewportClosures(c.fixture, geo[c.fixture].land).find((ring) => filled([ring], c.land.point));
      expect(target, `${name}: mutation has a real target`).toBeDefined();
      const deleted = geo[c.fixture].land.filter((ring) => ring !== target);
      const errors = findings(c.fixture, deleted);
      expect(errors).toContain(expectedSide(c, "land", "fixture fill"));
      expect(errors).toContain(`${name}: expected one closure, observed 0`);
      const rendered = drawing(c.fixture, deleted, [c.land.point]);
      expect(filled(rendered.rings, rendered.points[0]!), `${name}: deletion also loses rendered land`).toBe(false);
    });

    test(`${name}: wrong-side closure fails both land and sea assertions`, () => {
      const target = viewportClosures(c.fixture, geo[c.fixture].land).find((ring) => filled([ring], c.land.point));
      expect(target, `${name}: mutation has a real target`).toBeDefined();
      // Under even-odd, viewport XOR original ring is its complement inside
      // the viewport: an actual wrong-side fill, not a winding reversal.
      const wrongSide = [viewportRing(c.fixture), target!];
      expect(filled(wrongSide, c.land.point), `${name}: mutant clears land`).toBe(false);
      expect(filled(wrongSide, c.sea.point), `${name}: mutant paints sea`).toBe(true);
      const changed = [...geo[c.fixture].land.filter((ring) => ring !== target), ...wrongSide];
      const errors = findings(c.fixture, changed);
      expect(errors).toContain(expectedSide(c, "land", "fixture fill"));
      expect(errors).toContain(expectedSide(c, "sea", "fixture fill"));
      const rendered = drawing(c.fixture, changed, [c.land.point, c.sea.point]);
      expect(rendered.points.map((p) => filled(rendered.rings, p)), `${name}: rendered wrong side flips both witnesses`).toEqual([false, true]);
    });
  }
});
