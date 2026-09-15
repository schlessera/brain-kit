/**
 * MapView is the only component in the kit with real algorithmic content, and
 * the failure it exists to prevent is a map that looks plausible and is wrong.
 * A screenshot cannot catch that and neither can review, so this file checks
 * the arithmetic against numbers worked out from the definitions rather than
 * read off a render.
 *
 * Three levels, deliberately:
 *
 *   1. `mercY` against the closed form, and against the PROPERTY that makes it
 *      Mercator rather than equirectangular — the local vertical stretch at
 *      latitude φ is 1/cos φ. An equirectangular projection passes every
 *      eyeball test at this scale and fails that one.
 *   2. `step`, including the 30° fall-through nothing else reaches.
 *   3. The rendered component: where two REAL fixture coordinates land, and
 *      whether the scale bar's pixel length actually measures the distance its
 *      label claims.
 *
 * The expected pixel values below were computed independently, from the same
 * definitions, before the component was run. Re-deriving them here with the
 * component's own helpers would prove only that the code equals itself.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { voyageMap, voyageRoute } from "../fixtures/places.js";
import { MapView, mercY, step } from "../src/blocks/MapView.js";

/** Scylla and Charybdis, from `fixtures/places.ts`. Both are Wikipedia geotags. */
const SCYLLA = { lat: 38.2507, lon: 15.719 };
const CHARYBDIS = { lat: 38.2647, lon: 15.6508 };
/** Ithaca and Troy — the two ends of the whole fixture world. */
const ITHACA = { lat: 38.3647, lon: 20.7202 };
const TROY = { lat: 39.9575, lon: 26.2389 };

describe("mercY", () => {
  test("matches the closed form", () => {
    // ln(tan(π/4 + φ/2)) at a few latitudes, to 10 decimal places.
    expect(mercY(0)).toBeCloseTo(0, 10);
    expect(mercY(38.3647)).toBeCloseTo(0.7260857792, 10);
    expect(mercY(39.9575)).toBeCloseTo(0.7619416478, 9);
    expect(mercY(-38.3647)).toBeCloseTo(-0.7260857792, 10);
  });

  test("clamps at ±85°, because the projection diverges at the poles", () => {
    // tan(π/4 + φ/2) → ∞ at 90°, and a map that renders Infinity renders
    // nothing at all.
    expect(mercY(90)).toBe(mercY(85));
    expect(mercY(-90)).toBe(mercY(-85));
    expect(Number.isFinite(mercY(90))).toBe(true);
  });

  test("stretches vertically by 1/cos(lat) — the property that makes it Mercator", () => {
    // THE TEST THAT CATCHES AN EQUIRECTANGULAR "MAP". At this zoom a plain
    // lat/lon plot is visually indistinguishable; numerically it is not, and
    // this is where the difference shows.
    for (const lat of [0, 20, 38.2507, 55, 70]) {
      const h = 1e-6;
      const dPerDegree = (mercY(lat + h) - mercY(lat - h)) / (2 * h);
      const expected = Math.PI / 180 / Math.cos((lat * Math.PI) / 180);
      expect(dPerDegree).toBeCloseTo(expected, 8);
    }
    // At the equator the stretch is exactly 1; at 60° it is exactly 2.
    expect(
      (mercY(60.000001) - mercY(59.999999)) / (mercY(0.000001) - mercY(-0.000001)),
    ).toBeCloseTo(2, 5);
  });
});

describe("step", () => {
  test("picks the smallest nice interval that fits five lines across", () => {
    expect(step(0.004)).toBe(0.001);
    expect(step(0.03)).toBe(0.01);
    expect(step(0.4)).toBe(0.1);
    expect(step(3)).toBe(1);
    expect(step(40)).toBe(10);
  });

  test("falls through to 30° for a span wider than a hemisphere's worth", () => {
    // 200/20 is 10, which is more than five lines, so the table runs out.
    expect(step(200)).toBe(30);
  });

  test("never puts more than five lines across the span", () => {
    for (const span of [0.0005, 0.007, 0.09, 1.3, 17, 99, 150]) {
      expect(span / step(span)).toBeLessThanOrEqual(5);
    }
  });
});

/** Every `left:`/`top:` pair on an absolutely-positioned pin wrapper. */
function pinPositions(html: string): { left: number; top: number }[] {
  return [...html.matchAll(/left:([\d.]+)px;top:([\d.]+)px;transform:translate\(-50%,-50%\)/g)].map(
    (m) => ({ left: Number(m[1]), top: Number(m[2]) }),
  );
}

describe("the rendered projection", () => {
  // The strait, at the scale the decision was made: two real coordinates,
  // 330x170, minimum span 9 km. Expected values computed from the definitions.
  const strait = renderToStaticMarkup(
    <MapView
      width={330}
      height={170}
      spanKm={9}
      pins={[
        { ...SCYLLA, label: "Scylla", tone: "red" },
        { ...CHARYBDIS, label: "Charybdis", tone: "red" },
      ]}
      paths={[]}
    />,
  );

  test("puts both pins where the projection says they go", () => {
    const pins = pinPositions(strait);
    expect(pins).toHaveLength(2);
    // Scylla is the eastern of the two, so it sits further right.
    expect(pins[0].left).toBeCloseTo(252.8873, 3);
    expect(pins[0].top).toBeCloseTo(96.4959, 3);
    // Charybdis is west and NORTH, so: further left and higher up the card.
    expect(pins[1].left).toBeCloseTo(77.1127, 3);
    expect(pins[1].top).toBeCloseTo(73.5637, 3);
  });

  test("the scale bar measures the distance it claims", () => {
    // 2 km, drawn 59px wide. The check is not that those two numbers appear —
    // it is that 59px, converted back through metres-per-degree of longitude
    // at this latitude, really is 2 km.
    expect(strait).toContain(">2 km<");
    const bar = strait.match(/width:(\d+)px;height:3px/);
    expect(bar).not.toBeNull();
    const barPx = Number(bar![1]);
    expect(barPx).toBe(59);

    // Independently: the rendered bbox spans (me - mw) degrees over 330px.
    // Recover it from the two pin x-positions, whose longitudes we know.
    const pins = pinPositions(strait);
    const degPerPx =
      (SCYLLA.lon - CHARYBDIS.lon) / (pins[0].left - pins[1].left);
    const midLat = (SCYLLA.lat + CHARYBDIS.lat) / 2;
    const metresPerPx = degPerPx * 111320 * Math.cos((midLat * Math.PI) / 180);
    expect(barPx * metresPerPx).toBeCloseTo(2000, -1.5);
  });

  test("a pin past 62% of the width flips its label to the left of its dot", () => {
    // Scylla sits at 252.9 of 330 — past the flip threshold — so its row
    // reverses and the label does not run off the eastern edge.
    expect(strait).toContain("flex-direction:row-reverse");
    expect(strait).toContain("flex-direction:row;");
  });

  test("the coordinate readout is the first pin, to four decimals", () => {
    expect(strait).toContain("38.2507, 15.7190");
  });

  test("Troy is north and east of Ithaca, and the render agrees", () => {
    // The cheapest possible sanity check on sign conventions: a transposed
    // lat/lon or a flipped y would pass every arithmetic test above and fail
    // this one. `top` grows DOWNWARD, so further north is a smaller top.
    const html = renderToStaticMarkup(
      <MapView
        width={330}
        height={170}
        spanKm={400}
        pins={[
          { ...ITHACA, label: "Ithaca", tone: "teal" },
          { ...TROY, label: "Troy", tone: "neutral" },
        ]}
        paths={[]}
      />,
    );
    const [ithaca, troy] = pinPositions(html);
    expect(troy.left).toBeGreaterThan(ithaca.left);
    expect(troy.top).toBeLessThan(ithaca.top);
  });

  test("a polyline is projected point by point, longitude first", () => {
    // `[lon, lat]`, which is the order the design chose and the order
    // `fixtures/places.ts` stores. Swapping them draws a map of nowhere.
    const html = renderToStaticMarkup(
      <MapView
        width={330}
        height={170}
        spanKm={9}
        pins={[
          { ...SCYLLA, label: "Scylla" },
          { ...CHARYBDIS, label: "Charybdis" },
        ]}
        paths={[{ coords: [[SCYLLA.lon, SCYLLA.lat], [CHARYBDIS.lon, CHARYBDIS.lat]], tone: "amber" }]}
      />,
    );
    // The polyline's two points are the two pins' own positions, to 1dp.
    expect(html).toContain('points="252.9,96.5 77.1,73.6"');
  });

  test("a fifteen-point route is projected in order, every point kept", () => {
    // `paths` carries every piece of real geometry this component will ever
    // draw — D25 puts simplified coastline through this same prop, as
    // `[lon, lat]` polylines through this same Mercator maths, with no API
    // change. So the polyline path is load-bearing rather than decorative, and
    // it is checked against the actual fixture route rather than a pair.
    const html = renderToStaticMarkup(<MapView {...voyageMap} width={330} />);

    const polylines = [...html.matchAll(/<polyline points="([^"]*)"/g)].map((m) => m[1]);
    expect(polylines).toHaveLength(2);

    const voyage = polylines[0].split(" ");
    expect(voyage).toHaveLength(voyageRoute.length);
    expect(voyage).toHaveLength(15);

    // Ismarus is the northernmost and Lotus-eaters the southernmost and most
    // western, so the first coordinate of each pair has to be moving the way
    // longitude moves and the second the way latitude does — inverted here.
    const xs = voyage.map((pt) => Number(pt.split(",")[0]));
    const ys = voyage.map((pt) => Number(pt.split(",")[1]));
    const lons = voyageRoute.map((c) => c[0]);
    const lats = voyageRoute.map((c) => c[1]);
    expect(xs.indexOf(Math.min(...xs))).toBe(lons.indexOf(Math.min(...lons)));
    expect(xs.indexOf(Math.max(...xs))).toBe(lons.indexOf(Math.max(...lons)));
    // `top` grows downward, so the northernmost point has the SMALLEST y.
    expect(ys.indexOf(Math.min(...ys))).toBe(lats.indexOf(Math.max(...lats)));
    expect(ys.indexOf(Math.max(...ys))).toBe(lats.indexOf(Math.min(...lats)));

    // Every point is inside the drawing, because the bbox was built from the
    // pins and the route runs between them.
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
    for (const x of xs) expect(x).toBeLessThanOrEqual(330);
  });

  test("one pin is widened to spanKm rather than collapsing to a point", () => {
    const html = renderToStaticMarkup(
      <MapView width={330} height={170} spanKm={12} pins={[{ ...ITHACA, label: "Vathy" }]} />,
    );
    const [only] = pinPositions(html);
    // Dead centre of a box built symmetrically around it, to within the 12%/14%
    // margins — which are symmetric, so the pin stays centred.
    expect(only.left).toBeCloseTo(165, 6);
    expect(only.top).toBeCloseTo(85, 1);
    // 12 km across 330px is 45.2 m/px; 22% of the width is 3.3 km, and the
    // nearest nice distance to that is 2 km, drawn 44px wide. The LABEL is a
    // round number and the LENGTH is whatever that number really measures,
    // which is the whole point of snapping one and not the other.
    expect(html).toContain(">2 km<");
    expect(html).toContain("width:44px;height:3px");
  });
});
