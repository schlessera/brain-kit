/**
 * `PlaceMap` and its fixtures (#44), in the static render.
 *
 * Two things are checked here, and the browser checks the rest:
 *
 *   1. Every scene in `fixtures/place-maps.ts` carries the plan the SDK's
 *      planner actually makes. The plans are literal because Storybook cannot
 *      import the SDK's source; this is what keeps them from being a plan
 *      nobody would compute.
 *   2. What the card promises without a layout engine: every place is a row,
 *      the credit appears exactly when OpenStreetMap geometry is drawn and
 *      once however many frames carry it, the coordinate chip is for one pin
 *      only, and an empty answer from the route is a line, not a frame.
 *
 * Clustering is measured at the width the drawing is laid out at, so it is
 * asserted in the stories' play functions, in a real browser
 * (`stories/blocks/PlaceMap.stories.tsx`).
 */

import { planPlaces } from "@schlessera/brain-ui-sdk/client";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as scenes from "../fixtures/place-maps.js";
import { placeMapProps, type PlaceMapScene } from "../fixtures/place-maps.js";
import { MapView } from "../src/blocks/MapView.js";
import {
  PLACE_MAP_NO_GEOMETRY,
  PLACE_MAP_POSITIONS_LINE,
  PlaceList,
  PlaceMap,
} from "../src/blocks/PlaceMap.js";

const all = Object.entries(scenes).filter(
  (entry): entry is [string, PlaceMapScene] => typeof entry[1] === "object" && entry[1] !== null && "plan" in entry[1],
);

const html = (scene: PlaceMapScene, geometry?: "fixture" | "pending" | "none") =>
  renderToStaticMarkup(<PlaceMap {...placeMapProps(scene, geometry)} />);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("the fixtures are the planner's", () => {
  test("there is a scene for every mode", () => {
    expect(new Set(all.map(([, scene]) => scene.plan.mode))).toEqual(new Set(["map", "pair", "list"]));
  });

  for (const [name, scene] of all) {
    test(`${name}: the plan is what planPlaces makes of its places`, () => {
      expect(scene.plan as unknown).toEqual(planPlaces(scene.places));
      expect(scene.geometry).toHaveLength(scene.plan.frames.length);
    });
  }
});

describe("PlaceMap", () => {
  for (const [name, scene] of all) {
    test(`${name}: every place is one row, in order, whatever the mode`, () => {
      const out = html(scene);
      expect(scene.places.length).toBeGreaterThan(0);
      expect(count(out, "data-place=")).toBe(scene.places.length);
      let from = 0;
      for (const place of scene.places) {
        const at = out.indexOf(place.label.replace(/'/g, "&#x27;"), from);
        expect(at).toBeGreaterThan(-1);
        from = at;
      }
    });
  }

  test("the credit is drawn once for two frames of OpenStreetMap geometry, and never without it", () => {
    expect(scenes.homeAndTroy.plan.frames).toHaveLength(2);
    expect(count(html(scenes.homeAndTroy), "© OpenStreetMap contributors")).toBe(1);
    expect(html(scenes.homeAndTroy, "pending")).not.toContain("OpenStreetMap");
    expect(html(scenes.homeAndTroy, "none")).not.toContain("OpenStreetMap");
    expect(html(scenes.harbourEight)).toContain("© OpenStreetMap contributors");
  });

  test("an empty answer from the route is one line, and the list still carries every place", () => {
    const out = html(scenes.noGeometry);
    expect(out).toContain(PLACE_MAP_NO_GEOMETRY);
    expect(out).not.toContain(`preserveAspectRatio="none"`);
    expect(count(out, "data-place=")).toBe(3);
    expect(out).toContain("no position");
  });

  test("pending geometry still draws the frame: graticule, pins and scale bar need none", () => {
    const out = html(scenes.harbourEight, "pending");
    expect(out).toContain(`preserveAspectRatio="none"`);
    expect(out).not.toContain(PLACE_MAP_NO_GEOMETRY);
    expect(count(out, 'data-pin="badge"')).toBeGreaterThan(0);
  });

  test("positions are stated as the brain's whenever a place is pinned, and not otherwise", () => {
    expect(html(scenes.harbourEight)).toContain(PLACE_MAP_POSITIONS_LINE);
    expect(html(scenes.tooSpread)).toContain(PLACE_MAP_POSITIONS_LINE);
    const nothingPinned: PlaceMapScene = {
      places: [{ label: "Raft timber stand" }],
      plan: planPlaces([{ label: "Raft timber stand" }]) as PlaceMapScene["plan"],
      geometry: [],
    };
    const out = html(nothingPinned);
    expect(out).not.toContain(PLACE_MAP_POSITIONS_LINE);
    expect(out).toContain("No positions given");
  });

  test("the coordinate chip is for one pin; several pins have none", () => {
    // The chip is the only place the kit prints a coordinate to four places
    // inside the viewport, so its text is what is looked for.
    const one = planPlaces([{ label: "Vathy", lat: 38.3647, lon: 20.7202 }]);
    const single = renderToStaticMarkup(
      <PlaceMap
        rows={one.rows}
        mode={one.mode}
        frames={one.frames.map((f) => ({ ...f, geometry: "pending" as const }))}
        onMapLabels={one.onMapLabels}
      />,
    );
    expect(single).toContain(">38.3647, 20.7202</div>");
    const several = html(scenes.harbourEight);
    expect(several).not.toContain(">38.3644, 20.7202</div>");
  });

  test("numbers on the map when any name is too long for it, names when all fit", () => {
    expect(scenes.longLabels.plan.onMapLabels).toBe(false);
    const numbered = html(scenes.longLabels);
    expect(count(numbered, 'data-pin="badge"')).toBe(3);
    // The long name is whole in the list and absent from the drawing.
    expect(count(numbered, "The cave of the Naiads, where the gifts were hidden")).toBe(1);
    expect(scenes.homeAndTroy.plan.onMapLabels).toBe(true);
    const labelled = html(scenes.homeAndTroy);
    expect(labelled).not.toContain('data-pin="badge"');
    expect(labelled).toContain("1 Vathy");
  });

  test("each frame is an image named for its places and described by the list", () => {
    const out = html(scenes.homeAndTroy);
    expect(count(out, 'role="img"')).toBe(2);
    expect(out).toMatch(/aria-label="Map, about [0-9.]+ km across, with place 1"/);
    expect(out).toMatch(/aria-label="Map, about [0-9.]+ km across, with place 2"/);
    const described = [...out.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(described).toHaveLength(2);
    expect(out).toContain(`id="${described[0]}"`);
  });

  test("the reason is stated in words, before the frames", () => {
    const out = html(scenes.homeAndTroy);
    expect(out).toContain("Too far apart for one map · 508 km between them");
    expect(out.indexOf("Too far apart")).toBeLessThan(out.indexOf(`preserveAspectRatio="none"`));
    expect(html(scenes.tooSpread)).toContain("Too spread out to draw · 1,140 km across");
  });
});

describe("PlaceList", () => {
  const rows = scenes.harbourTwelve.plan.rows;

  test("past eight rows the rest sit behind a disclosure that names the total", () => {
    expect(rows).toHaveLength(12);
    const closed = renderToStaticMarkup(<PlaceList rows={rows} open={false} />);
    expect(closed).toContain("Show all 12 places");
    expect(count(closed, "data-place=")).toBe(8);
    const open = renderToStaticMarkup(<PlaceList rows={rows} />);
    expect(count(open, "data-place=")).toBe(12);
  });

  test("a row states what its position rests on, and what the drawing did to it", () => {
    const out = renderToStaticMarkup(<PlaceList rows={rows} drawn={{ 4: "in A" }} />);
    expect(out).toContain("38.3644, 20.7202 · per notes/landing.md");
    expect(out).toContain("38.3644, 20.7206 · in A");
  });
});

describe("MapView in number mode", () => {
  test("a pin is a badge carrying its number, and nothing carries its name", () => {
    const out = renderToStaticMarkup(
      <MapView
        pinMode="number"
        pins={[
          { lat: 38.3647, lon: 20.7202, n: 1, label: "Vathy" },
          { lat: 38.3685, lon: 20.7219, n: 2, label: "Cave" },
        ]}
        title=""
        meta=""
      />,
    );
    expect(count(out, 'data-pin="badge"')).toBe(2);
    expect(out).not.toContain("Vathy");
    expect(out).toContain(">1</div>");
    expect(out).toContain(">2</div>");
  });

  test("two pins inside the radius are one lettered badge that counts both", () => {
    const out = renderToStaticMarkup(
      <MapView
        pinMode="number"
        clusterPx={22}
        pins={[
          { lat: 38.3644, lon: 20.7202, n: 1 },
          { lat: 38.3644, lon: 20.7203, n: 2 },
          { lat: 38.3685, lon: 20.7219, n: 3 },
        ]}
        title=""
        meta=""
      />,
    );
    expect(count(out, 'data-pin="cluster"')).toBe(1);
    expect(out).toContain(">A·2</div>");
    expect(count(out, 'data-pin="badge"')).toBe(1);
  });

  test("letters continue from `letterFrom`", () => {
    const out = renderToStaticMarkup(
      <MapView
        pinMode="number"
        letterFrom={2}
        pins={[
          { lat: 38.3644, lon: 20.7202, n: 1 },
          { lat: 38.3644, lon: 20.7203, n: 2 },
        ]}
        title=""
        meta=""
      />,
    );
    expect(out).toContain(">C·2</div>");
  });
});
