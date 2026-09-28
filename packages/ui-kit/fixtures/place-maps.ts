// Place maps: several named places in one answer (#44).
//
// Each scene is what the model would send (`places`), the plan
// `@schlessera/brain-ui-sdk`'s `planPlaces` makes from it (`plan`), and which
// committed geometry each frame is drawn over. The plans are literal because
// Storybook cannot import the SDK's source, and `tests/place-map-fixtures.test.ts`
// recomputes every one of them, so a plan here that the planner would not
// make fails there.
//
// ## Where the positions come from
//
// No coordinate below is invented for the look of it. The Vathy scenes use
// vertices of the committed OSM street geometry (`geo/vathy.json`), so every
// pin sits on a street that is really there; the names attached to them are
// the world's, and fictional. `Eumaeus's gate` and `Raven's Rock` are given at
// two decimal places on purpose: a coordinate somebody rounded is the case the
// list's precision note is for. Ogygia, the cave, Ithaca and Troy are the
// geotags in `places.ts`.
//
// A scene with geometry `"none"` is the route having answered with nothing,
// not a place without a coastline.

import type { PlaceListRow, PlaceMapFrame, PlaceMapProps } from "../src/blocks/PlaceMap.js";
import { OSM_ATTRIBUTION, geoLand, geoPaths, type GeoId } from "./geo/index.js";

/** One place as the `map` block carries it. */
export interface ScenePlace {
  label: string;
  lat?: number;
  lon?: number;
  meta?: string;
  source?: string;
  accuracyM?: number;
}

/** The plan as `planPlaces` returns it. */
export interface ScenePlan {
  rows: PlaceListRow[];
  mode: PlaceMapProps["mode"];
  reason?: string;
  frames: (Omit<PlaceMapFrame, "geometry"> & { bbox: [number, number, number, number] })[];
  onMapLabels: boolean;
}

export interface PlaceMapScene {
  title?: string;
  places: ScenePlace[];
  plan: ScenePlan;
  /** Per frame: which fixture to draw it over, or `"none"` for an empty answer. */
  geometry: (GeoId | "none")[];
}

/** A scene as `PlaceMap` props, each frame drawn over its fixture. */
export function placeMapProps(
  scene: PlaceMapScene,
  geometry: "fixture" | "pending" | "none" = "fixture"
): PlaceMapProps {
  const frames: PlaceMapFrame[] = scene.plan.frames.map(({ bbox: _bbox, ...frame }, i) => {
    const id = scene.geometry[i];
    if (geometry !== "fixture") return { ...frame, geometry };
    if (id === undefined || id === "none") return { ...frame, geometry: "none" };
    return { ...frame, geometry: { paths: geoPaths(id), land: geoLand(id), attribution: OSM_ATTRIBUTION } };
  });
  return {
    ...(scene.title ? { title: scene.title } : {}),
    rows: scene.plan.rows,
    mode: scene.plan.mode,
    ...(scene.plan.reason ? { reason: scene.plan.reason } : {}),
    frames,
    onMapLabels: scene.plan.onMapLabels,
  };
}

/** Eight places in one town: the acceptance case. Two of them are 35 m apart, which is one lettered badge at a phone width. */
export const harbourEight: PlaceMapScene = {
  title: "Errands in Vathy",
  places: [
    {
      label: "Harbour steps",
      lat: 38.3644,
      lon: 20.7202,
      meta: "09:40",
      source: "notes/landing.md",
    },
    {
      label: "The hall",
      lat: 38.3644,
      lon: 20.7206,
      meta: "10:15",
    },
    {
      label: "Agora well",
      lat: 38.3667,
      lon: 20.7207,
      meta: "11:00",
    },
    {
      label: "Mentor's house",
      lat: 38.3651,
      lon: 20.7154,
      meta: "11:30",
    },
    {
      label: "Boatyard",
      lat: 38.3644,
      lon: 20.7253,
      meta: "12:00",
      source: "notes/raft.md",
    },
    {
      label: "Arethusa road",
      lat: 38.3612,
      lon: 20.7224,
    },
    {
      label: "Shrine of Athena",
      lat: 38.3684,
      lon: 20.7183,
      meta: "dusk",
    },
    {
      label: "Eumaeus's gate",
      lat: 38.37,
      lon: 20.72,
      source: "journal/day-3650.md",
    },
  ],
  plan: {
    rows: [
      {
        n: 1,
        label: "Harbour steps",
        pinned: true,
        meta: "09:40",
        source: "notes/landing.md",
        coord: "38.3644, 20.7202",
      },
      {
        n: 2,
        label: "The hall",
        pinned: true,
        meta: "10:15",
        coord: "38.3644, 20.7206",
      },
      {
        n: 3,
        label: "Agora well",
        pinned: true,
        meta: "11:00",
        coord: "38.3667, 20.7207",
      },
      {
        n: 4,
        label: "Mentor's house",
        pinned: true,
        meta: "11:30",
        coord: "38.3651, 20.7154",
      },
      {
        n: 5,
        label: "Boatyard",
        pinned: true,
        meta: "12:00",
        source: "notes/raft.md",
        coord: "38.3644, 20.7253",
      },
      {
        n: 6,
        label: "Arethusa road",
        pinned: true,
        coord: "38.3612, 20.7224",
      },
      {
        n: 7,
        label: "Shrine of Athena",
        pinned: true,
        meta: "dusk",
        coord: "38.3684, 20.7183",
      },
      {
        n: 8,
        label: "Eumaeus's gate",
        pinned: true,
        source: "journal/day-3650.md",
        coord: "38.37, 20.72",
        precision: "to ~1 km",
      },
    ],
    mode: "map",
    frames: [
      {
        bbox: [20.705265560313837, 38.35808979849083, 20.735434439686163, 38.37310986050819],
        pins: [
          {
            n: 1,
            lat: 38.3644,
            lon: 20.7202,
          },
          {
            n: 2,
            lat: 38.3644,
            lon: 20.7206,
          },
          {
            n: 3,
            lat: 38.3667,
            lon: 20.7207,
          },
          {
            n: 4,
            lat: 38.3651,
            lon: 20.7154,
          },
          {
            n: 5,
            lat: 38.3644,
            lon: 20.7253,
          },
          {
            n: 6,
            lat: 38.3612,
            lon: 20.7224,
          },
          {
            n: 7,
            lat: 38.3684,
            lon: 20.7183,
          },
          {
            n: 8,
            lat: 38.37,
            lon: 20.72,
          },
        ],
        height: 200,
        spanKm: 1.6,
        acrossKm: 1.984,
      },
    ],
    onMapLabels: false,
  },
  geometry: ["vathy"],
};

/** Twelve places, five of them inside one block of the harbour: a lettered cluster, and a list long enough to collapse on a phone. */
export const harbourTwelve: PlaceMapScene = {
  title: "Where the crew went ashore",
  places: [
    {
      label: "Harbour steps",
      lat: 38.3644,
      lon: 20.7202,
      meta: "09:40",
      source: "notes/landing.md",
    },
    {
      label: "Mentor's house",
      lat: 38.3651,
      lon: 20.7154,
    },
    {
      label: "Agora well",
      lat: 38.3667,
      lon: 20.7207,
      meta: "11:00",
    },
    {
      label: "The hall",
      lat: 38.3644,
      lon: 20.7206,
      meta: "10:15",
    },
    {
      label: "The threshold",
      lat: 38.3648,
      lon: 20.7198,
    },
    {
      label: "Nurse's lodge",
      lat: 38.3641,
      lon: 20.7197,
    },
    {
      label: "Weaving room",
      lat: 38.365,
      lon: 20.7203,
    },
    {
      label: "Storeroom",
      lat: 38.3644,
      lon: 20.7207,
    },
    {
      label: "Boatyard",
      lat: 38.3644,
      lon: 20.7253,
      meta: "12:00",
    },
    {
      label: "Arethusa road",
      lat: 38.3612,
      lon: 20.7224,
    },
    {
      label: "Shrine of Athena",
      lat: 38.3684,
      lon: 20.7183,
      meta: "dusk",
    },
    {
      label: "Fish market",
      lat: 38.3614,
      lon: 20.7179,
    },
  ],
  plan: {
    rows: [
      {
        n: 1,
        label: "Harbour steps",
        pinned: true,
        meta: "09:40",
        source: "notes/landing.md",
        coord: "38.3644, 20.7202",
      },
      {
        n: 2,
        label: "Mentor's house",
        pinned: true,
        coord: "38.3651, 20.7154",
      },
      {
        n: 3,
        label: "Agora well",
        pinned: true,
        meta: "11:00",
        coord: "38.3667, 20.7207",
      },
      {
        n: 4,
        label: "The hall",
        pinned: true,
        meta: "10:15",
        coord: "38.3644, 20.7206",
      },
      {
        n: 5,
        label: "The threshold",
        pinned: true,
        coord: "38.3648, 20.7198",
      },
      {
        n: 6,
        label: "Nurse's lodge",
        pinned: true,
        coord: "38.3641, 20.7197",
      },
      {
        n: 7,
        label: "Weaving room",
        pinned: true,
        coord: "38.365, 20.7203",
        precision: "to ~100 m",
      },
      {
        n: 8,
        label: "Storeroom",
        pinned: true,
        coord: "38.3644, 20.7207",
      },
      {
        n: 9,
        label: "Boatyard",
        pinned: true,
        meta: "12:00",
        coord: "38.3644, 20.7253",
      },
      {
        n: 10,
        label: "Arethusa road",
        pinned: true,
        coord: "38.3612, 20.7224",
      },
      {
        n: 11,
        label: "Shrine of Athena",
        pinned: true,
        meta: "dusk",
        coord: "38.3684, 20.7183",
      },
      {
        n: 12,
        label: "Fish market",
        pinned: true,
        coord: "38.3614, 20.7179",
      },
    ],
    mode: "map",
    frames: [
      {
        bbox: [20.708951934887086, 38.355036447924, 20.731748065112914, 38.37456252855168],
        pins: [
          {
            n: 1,
            lat: 38.3644,
            lon: 20.7202,
          },
          {
            n: 2,
            lat: 38.3651,
            lon: 20.7154,
          },
          {
            n: 3,
            lat: 38.3667,
            lon: 20.7207,
          },
          {
            n: 4,
            lat: 38.3644,
            lon: 20.7206,
          },
          {
            n: 5,
            lat: 38.3648,
            lon: 20.7198,
          },
          {
            n: 6,
            lat: 38.3641,
            lon: 20.7197,
          },
          {
            n: 7,
            lat: 38.365,
            lon: 20.7203,
          },
          {
            n: 8,
            lat: 38.3644,
            lon: 20.7207,
          },
          {
            n: 9,
            lat: 38.3644,
            lon: 20.7253,
          },
          {
            n: 10,
            lat: 38.3612,
            lon: 20.7224,
          },
          {
            n: 11,
            lat: 38.3684,
            lon: 20.7183,
          },
          {
            n: 12,
            lat: 38.3614,
            lon: 20.7179,
          },
        ],
        height: 260,
        spanKm: 1.6,
        acrossKm: 1.984,
      },
    ],
    onMapLabels: false,
  },
  geometry: ["vathy"],
};

/** Two places 508 km apart: a pair of frames, each at its own scale. */
export const homeAndTroy: PlaceMapScene = {
  title: "Where it started, and where it ends",
  places: [
    {
      label: "Vathy",
      lat: 38.3647,
      lon: 20.7202,
      meta: "home",
    },
    {
      label: "Hisarlik (Troy)",
      lat: 39.9575,
      lon: 26.2389,
      meta: "day 0",
      source: "notes/troy.md",
    },
  ],
  plan: {
    rows: [
      {
        n: 1,
        label: "Vathy",
        pinned: true,
        meta: "home",
        coord: "38.3647, 20.7202",
      },
      {
        n: 2,
        label: "Hisarlik (Troy)",
        pinned: true,
        meta: "day 0",
        source: "notes/troy.md",
        coord: "39.9575, 26.2389",
      },
    ],
    mode: "pair",
    reason: "Too far apart for one map · 508 km between them",
    frames: [
      {
        bbox: [20.70880195063445, 38.35831619212836, 20.731598049365548, 38.371083244885575],
        pins: [
          {
            n: 1,
            lat: 38.3647,
            lon: 20.7202,
          },
        ],
        height: 170,
        spanKm: 1.6,
        acrossKm: 1.984,
        caption: "1 · Vathy",
      },
      {
        bbox: [26.227240910958237, 39.95111617568104, 26.250559089041765, 39.9638832284402],
        pins: [
          {
            n: 2,
            lat: 39.9575,
            lon: 26.2389,
          },
        ],
        height: 170,
        spanKm: 1.6,
        acrossKm: 1.984,
        caption: "2 · Hisarlik (Troy)",
      },
    ],
    onMapLabels: true,
  },
  geometry: ["vathy", "troy"],
};

/** Three places, one name past 18 characters, so every pin is numbered and every name is in the list, whole. */
export const longLabels: PlaceMapScene = {
  places: [
    {
      label: "The cave of the Naiads, where the gifts were hidden",
      lat: 38.3685,
      lon: 20.7219,
      source: "notes/cave.md",
    },
    {
      label: "Raven's Rock",
      lat: 38.36,
      lon: 20.72,
    },
    {
      label: "Phorcys harbour, north shore",
      lat: 38.3651,
      lon: 20.7154,
    },
  ],
  plan: {
    rows: [
      {
        n: 1,
        label: "The cave of the Naiads, where the gifts were hidden",
        pinned: true,
        source: "notes/cave.md",
        coord: "38.3685, 20.7219",
      },
      {
        n: 2,
        label: "Raven's Rock",
        pinned: true,
        coord: "38.36, 20.72",
        precision: "to ~1 km",
      },
      {
        n: 3,
        label: "Phorcys harbour, north shore",
        pinned: true,
        coord: "38.3651, 20.7154",
      },
    ],
    mode: "map",
    frames: [
      {
        bbox: [20.70150891097983, 38.35786639657742, 20.73579108902017, 38.37063344929855],
        pins: [
          {
            n: 1,
            lat: 38.3685,
            lon: 20.7219,
          },
          {
            n: 2,
            lat: 38.36,
            lon: 20.72,
          },
          {
            n: 3,
            lat: 38.3651,
            lon: 20.7154,
          },
        ],
        height: 170,
        spanKm: 1.6,
        acrossKm: 1.984,
      },
    ],
    onMapLabels: false,
  },
  geometry: ["vathy"],
};

/** The route answered with nothing: the frame is one line, and the list carries all three places, one of them with no position. */
export const noGeometry: PlaceMapScene = {
  title: "Ogygia, before the raft",
  places: [
    {
      label: "Ogygia landing",
      lat: 36.05,
      lon: 14.25,
      source: "notes/ogygia.md",
    },
    {
      label: "Calypso's cave",
      lat: 36.062,
      lon: 14.283,
    },
    {
      label: "Raft timber stand",
    },
  ],
  plan: {
    rows: [
      {
        n: 1,
        label: "Ogygia landing",
        pinned: true,
        source: "notes/ogygia.md",
        coord: "36.05, 14.25",
        precision: "to ~1 km",
      },
      {
        n: 2,
        label: "Calypso's cave",
        pinned: true,
        coord: "36.062, 14.283",
        precision: "to ~100 m",
      },
      {
        n: 3,
        label: "Raft timber stand",
        pinned: false,
        unpinnedWhy: "no position",
      },
    ],
    mode: "map",
    frames: [
      {
        bbox: [14.243030023126703, 36.044184683906714, 14.289969976873296, 36.06781429184661],
        pins: [
          {
            n: 1,
            lat: 36.05,
            lon: 14.25,
          },
          {
            n: 2,
            lat: 36.062,
            lon: 14.283,
          },
        ],
        height: 170,
        spanKm: 1.6,
        acrossKm: 3.672041103573547,
      },
    ],
    onMapLabels: true,
  },
  geometry: ["none"],
};

/** Three places across 12 degrees: no map, and a line that says why. */
export const tooSpread: PlaceMapScene = {
  title: "Seven years, one year, ten years",
  places: [
    {
      label: "Ogygia",
      lat: 36.05,
      lon: 14.25,
      meta: "7 years",
    },
    {
      label: "Ithaca",
      lat: 38.3647,
      lon: 20.7202,
      meta: "home",
    },
    {
      label: "Troy",
      lat: 39.9575,
      lon: 26.2389,
      meta: "10 years",
    },
  ],
  plan: {
    rows: [
      {
        n: 1,
        label: "Ogygia",
        pinned: true,
        meta: "7 years",
        coord: "36.05, 14.25",
        precision: "to ~1 km",
      },
      {
        n: 2,
        label: "Ithaca",
        pinned: true,
        meta: "home",
        coord: "38.3647, 20.7202",
      },
      {
        n: 3,
        label: "Troy",
        pinned: true,
        meta: "10 years",
        coord: "39.9575, 26.2389",
      },
    ],
    mode: "list",
    reason: "Too spread out to draw · 1,140 km across",
    frames: [],
    onMapLabels: true,
  },
  geometry: [],
};
