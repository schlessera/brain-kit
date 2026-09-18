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

/**
 * Every `left:`/`top:` pair on an absolutely-positioned pin wrapper, converted
 * back to the projected pixel.
 *
 * The component places pins as PERCENTAGES of the box rather than at the
 * projected SVG pixel, because the SVG scales to the card's fluid width and an
 * absolutely-positioned overlay does not: at the pixel, a pin sat 30% of the box
 * away from the coastline it marks the moment the card was not exactly `width`
 * wide. Multiplying back by the box is the same number in a different unit, so
 * every expectation below is the projection's own arithmetic, unchanged.
 */
function pinPositions(html: string, width: number, height: number): { left: number; top: number }[] {
  // The transform is no longer a fixed `translate(-50%,-50%)`: the row is
  // offset by half a dot so that THE DOT sits on the coordinate rather than the
  // row's centre, and the offset differs when the row is reversed. `left`/`top`
  // are the projected anchor either way, which is what these tests check.
  return [...html.matchAll(/left:([\d.]+)%;top:([\d.]+)%;transform:translate\(/g)].map(
    (m) => ({ left: (Number(m[1]) / 100) * width, top: (Number(m[2]) / 100) * height }),
  );
}

/**
 * The scale bar's drawn length, as a projected pixel.
 *
 * Like the pins, the bar is an HTML overlay on a drawing that scales to the
 * card's fluid width, so it is written as a percentage of the box: a fixed
 * pixel length claims a distance the map is not drawn at the moment the card is
 * not exactly `width` wide, and a scale bar that is wrong is worse than none.
 */
function scaleBarPx(html: string, width: number): number | null {
  // Order-tolerant on purpose: the bar also declares `flex:none` between the
  // two, and a regex that assumed adjacency silently returned null — which read
  // as "there is no scale bar" rather than as "the parser is stale".
  const match = html.match(/width:([\d.]+)%;[^"]*?height:3px/);
  return match ? (Number(match[1]) / 100) * width : null;
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
    // The x values are the same as before the projection was corrected, and
    // that is the point: `spanKm` is the span across the WIDTH, so the
    // longitude range is unchanged and the LATITUDE range grew to match the
    // card. The two pins are 1.5 km apart north-south and now read that way
    // against a 6 km strait. The metres-per-pixel check below is what says
    // these numbers are right rather than merely stable.
    const pins = pinPositions(strait, 330, 170);
    expect(pins).toHaveLength(2);
    // Scylla is the eastern of the two, so it sits further right.
    expect(pins[0].left).toBeCloseTo(252.8872, 3);
    expect(pins[0].top).toBeCloseTo(107.9765, 3);
    // Charybdis is west and NORTH, so: further left and higher up the card.
    expect(pins[1].left).toBeCloseTo(77.1128, 3);
    expect(pins[1].top).toBeCloseTo(62.0248, 3);
  });

  test("ONE SCALE FOR BOTH AXES: a map is never stretched to fill its card", () => {
    // The property the numbers above are an instance of, and the one that
    // matters: a degree of longitude and a degree of latitude have to come out
    // as the same distance on screen. Otherwise an island gets wider as the
    // window does, and the scale bar is only true east-west.
    //
    // Recovered from the RENDER rather than the inputs: the pins give
    // metres-per-pixel across, the graticule gives it down. Both were wrong in
    // opposite directions at different times — the projection mapped each axis
    // across the whole box independently, and the first attempt at fixing it
    // compared longitude in degrees against a mercator y in radians, which is
    // out by a factor of 57.
    const pins = pinPositions(strait, 330, 170);
    const midLat = (SCYLLA.lat + CHARYBDIS.lat) / 2;
    const across =
      ((SCYLLA.lon - CHARYBDIS.lon) / (pins[0].left - pins[1].left)) *
      111320 *
      Math.cos((midLat * Math.PI) / 180);

    // Down comes from the same two pins. Over 0.014 degrees the mercator warp
    // is far below the tolerance, and it needs no graticule label — the strait
    // only renders one, because the collision guard suppresses the other.
    const down =
      ((CHARYBDIS.lat - SCYLLA.lat) / (pins[0].top - pins[1].top)) * 111320;

    expect(down / across).toBeCloseTo(1, 2);
  });

  test("pins that would collide cluster into one labelled `+N`, and never truncate", () => {
    // The same two pins at a 400 km span land within a few pixels of each
    // other. The design's answer to design-feedback §16: the second is absorbed
    // into the first, which carries the count — "half a name is worse than a
    // count". Both names still exist in the data; one label is drawn.
    const far = renderToStaticMarkup(
      <MapView
        width={330}
        height={170}
        spanKm={400}
        pins={[
          { ...SCYLLA, label: "Scylla", tone: "red", meta: "1.5 km" },
          { ...CHARYBDIS, label: "Charybdis", tone: "red" },
        ]}
        paths={[]}
      />,
    );
    expect(pinPositions(far, 330, 170)).toHaveLength(1);
    expect(far).toContain("Scylla +1");
    expect(far).not.toContain("Charybdis");
    // A cluster label carries no meta: the count is the secondary figure now.
    expect(far).not.toContain("1.5 km");

    // At the strait's own scale they are 175px apart and both draw, with meta.
    const near = renderToStaticMarkup(
      <MapView width={330} height={170} spanKm={9} pins={[{ ...SCYLLA, label: "Scylla", meta: "east" }, { ...CHARYBDIS, label: "Charybdis", meta: "west" }]} paths={[]} />,
    );
    expect(pinPositions(near, 330, 170)).toHaveLength(2);
    // Scylla sits at x=252.9 of 330 — past 70% of the width, where the label
    // has flipped and the room left cannot be known — so ITS meta is dropped
    // and Charybdis's, at x=77, is kept. The pin keeps its name either way.
    expect(near).toContain("Scylla");
    expect(near).not.toContain("east");
    expect(near).toContain("west");
    // `clusterPx` is the caller's: at 200px the strait pair clusters too.
    const forced = renderToStaticMarkup(
      <MapView width={330} height={170} spanKm={9} clusterPx={200} pins={[{ ...SCYLLA, label: "Scylla" }, { ...CHARYBDIS, label: "Charybdis" }]} paths={[]} />,
    );
    expect(pinPositions(forced, 330, 170)).toHaveLength(1);
  });

  test("the scale bar measures the distance it claims", () => {
    // 2 km, drawn 59px wide. The check is not that those two numbers appear —
    // it is that 59px, converted back through metres-per-degree of longitude
    // at this latitude, really is 2 km.
    expect(strait).toContain(">2 km<");
    const barPx = scaleBarPx(strait, 330);
    expect(barPx).not.toBeNull();
    expect(Math.round(barPx!)).toBe(59);

    // Independently: the rendered bbox spans (me - mw) degrees over 330px.
    // Recover it from the two pin x-positions, whose longitudes we know.
    const pins = pinPositions(strait, 330, 170);
    const degPerPx =
      (SCYLLA.lon - CHARYBDIS.lon) / (pins[0].left - pins[1].left);
    const midLat = (SCYLLA.lat + CHARYBDIS.lat) / 2;
    const metresPerPx = degPerPx * 111320 * Math.cos((midLat * Math.PI) / 180);
    expect(barPx! * metresPerPx).toBeCloseTo(2000, -1.5);
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
    const [ithaca, troy] = pinPositions(html, 330, 170);
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
    expect(html).toContain('points="252.9,108.0 77.1,62.0"');
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
    const [only] = pinPositions(html, 330, 170);
    // Dead centre of a box built symmetrically around it, to within the 12%/14%
    // margins — which are symmetric, so the pin stays centred.
    expect(only.left).toBeCloseTo(165, 6);
    expect(only.top).toBeCloseTo(85, 1);
    // 12 km across 330px is 45.2 m/px; 22% of the width is 3.3 km, and the
    // nearest nice distance to that is 2 km, drawn 44px wide. The LABEL is a
    // round number and the LENGTH is whatever that number really measures,
    // which is the whole point of snapping one and not the other.
    expect(html).toContain(">2 km<");
    expect(Math.round(scaleBarPx(html, 330)!)).toBe(44);
  });
});
