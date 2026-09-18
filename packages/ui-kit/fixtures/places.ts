// The geography.
//
// Every coordinate below is a REAL place, read from the English Wikipedia
// article named in its `source` field (fetched through the MediaWiki
// `prop=coordinates` API, which returns the article's own geotag rather than a
// paraphrase of it). This is not decoration: MapView projects with Web
// Mercator and computes its scale bar from metres-per-pixel at the view's
// latitude, so an invented coordinate draws a wrong map with a confidently
// wrong scale bar underneath it.
//
// Mythical places are pinned at their conventional candidate sites. That is a
// stated convention, not a claim -- Ogygia is not Gozo, but Gozo is where
// people have put Ogygia for a very long time, and it is a real island at a
// real latitude. Each one says which identification it is using.
//
// Day numbers: the poem dates almost none of the wandering. It commits to
// three durations and this file honours all three -- ten years since Troy, one
// full year on Aeaea (day 246 to day 611), seven years on Ogygia (day 1,095 to
// today, day 3,652). Everything between is ordered and plausible, not a
// reconciliation of Homer's arithmetic, which does not close.

import { OSM_ATTRIBUTION, geoLand, geoPaths } from "./geo/index.js";
import type { MapPath, MapPin, MapScene, Place, PlaceId } from "./types.js";

export const places: Place[] = [
  {
    id: "place:ithaca",
    name: "Ithaca",
    site: "Vathy, Ithaki, Ionian Islands",
    lat: 38.3647,
    lon: 20.7202,
    kind: "home",
    day: null,
    summary:
      "Home. The estate, the herds, the hall, and one hundred and eight men eating their way through all three.",
    source: "Wikipedia: Vathy, Ithaca",
    tone: "teal",
  },
  {
    id: "place:troy",
    name: "Troy",
    site: "Hisarlik, Canakkale, Turkey",
    lat: 39.9575,
    lon: 26.2389,
    kind: "visited",
    day: 0,
    summary: "Day zero. Twelve ships out of the beach, six hundred men aboard, a following wind.",
    source: "Wikipedia: Troy",
    tone: "neutral",
  },
  {
    id: "place:ismarus",
    name: "Ismarus",
    site: "Maroneia, Thrace, Greece",
    lat: 40.9,
    lon: 25.5167,
    kind: "visited",
    day: 9,
    summary:
      "A raid that should have ended at dawn and did not. Seventy-two men lost because nobody would leave the wine.",
    source: "Wikipedia: Maroneia",
    tone: "red",
  },
  {
    id: "place:malea",
    name: "Cape Malea",
    site: "Cape Maleas, Laconia, Greece",
    lat: 36.4381,
    lon: 23.1986,
    kind: "visited",
    day: 21,
    summary:
      "The last headland before home, and the one the north wind took us around. Ithaca was two days off.",
    source: "Wikipedia: Cape Maleas",
    tone: "gold",
  },
  {
    id: "place:lotus",
    name: "Land of the Lotus-eaters",
    site: "Djerba, Tunisia (conventional identification)",
    lat: 33.8,
    lon: 10.8833,
    kind: "visited",
    day: 30,
    summary: "Three men had to be carried back to the ship and tied under the benches. None were lost.",
    source: "Wikipedia: Djerba",
    tone: "purple",
  },
  {
    id: "place:cyclopes",
    name: "Land of the Cyclopes",
    site: "Aci Trezza, Sicily (the Faraglioni dei Ciclopi)",
    lat: 37.5636,
    lon: 15.1614,
    kind: "visited",
    day: 96,
    summary:
      "Six men eaten. One name given away from the stern of a ship already clear of the beach. Everything since dates from here.",
    source: "Wikipedia: Aci Trezza",
    tone: "red",
  },
  {
    id: "place:aeolia",
    name: "Aeolia",
    site: "Lipari, Aeolian Islands, Italy",
    lat: 38.4667,
    lon: 14.95,
    kind: "visited",
    day: 132,
    summary:
      "A month's hospitality and every wrong wind tied in a bag. We were close enough to see the cooking fires when the crew opened it.",
    source: "Wikipedia: Lipari",
    tone: "gold",
  },
  {
    id: "place:laestrygonians",
    name: "Land of the Laestrygonians",
    site: "Bonifacio, Corsica (conventional identification)",
    lat: 41.3868,
    lon: 9.1569,
    kind: "visited",
    day: 205,
    summary:
      "A harbour with one narrow mouth and cliffs on both sides. Eleven ships went in. One stayed outside, and that is the only reason there is anything to write.",
    source: "Wikipedia: Bonifacio, Corse-du-Sud",
    tone: "red",
  },
  {
    id: "place:aeaea",
    name: "Aeaea",
    site: "Mount Circeo, Lazio, Italy (conventional identification)",
    lat: 41.2333,
    lon: 13.05,
    kind: "visited",
    day: 246,
    summary:
      "A full year, day 246 to day 611. The sailing directions for everything after this were written here, and they have held.",
    source: "Wikipedia: Mount Circeo",
    tone: "purple",
  },
  {
    id: "place:acheron",
    name: "The house of the dead",
    site: "Necromanteion of Acheron, Epirus, Greece",
    lat: 39.2362,
    lon: 20.5345,
    kind: "visited",
    day: 620,
    summary:
      "The consultation. A forecast, a warning about cattle, and the news that the estate was not holding.",
    source: "Wikipedia: Necromanteion of Acheron",
    tone: "purple",
  },
  {
    id: "place:sirens",
    name: "The Sirens",
    site: "Li Galli (Sirenuse), Amalfi Coast, Italy",
    lat: 40.581,
    lon: 14.433,
    kind: "visited",
    day: 1041,
    summary: "Wax in fifty pairs of ears and rope on one man. Worked exactly as written. No losses.",
    source: "Wikipedia: Sirenuse",
    tone: "teal",
  },
  {
    id: "place:scylla",
    name: "Scylla",
    site: "Scilla, Calabria, Italy",
    lat: 38.2507,
    lon: 15.719,
    kind: "hazard",
    day: 1043,
    summary: "Six men, taken from the deck in the time it takes to say it. The price of the other choice was the ship.",
    source: "Wikipedia: Scilla, Calabria",
    tone: "red",
  },
  {
    id: "place:charybdis",
    name: "Charybdis",
    site: "Faro Point (Capo Peloro), Messina, Sicily",
    lat: 38.2647,
    lon: 15.6508,
    kind: "hazard",
    day: 1043,
    summary: "Passed twice. The second time there was no ship left to lose, only a fig tree to hold on to.",
    source: "Wikipedia: Faro Point",
    tone: "red",
  },
  {
    id: "place:messina",
    name: "The strait",
    site: "Strait of Messina, Italy",
    lat: 38.2458,
    lon: 15.6325,
    kind: "hazard",
    day: 1043,
    summary: "Three kilometres wide at the narrows. Both hazards are inside it, and you cannot avoid both.",
    source: "Wikipedia: Strait of Messina",
    tone: "gold",
  },
  {
    id: "place:thrinacia",
    name: "Thrinacia",
    site: "Mount Etna, Sicily (conventional identification)",
    lat: 37.755,
    lon: 14.995,
    kind: "visited",
    day: 1044,
    summary:
      "Thirty days of wind from the wrong quarter, then the cattle. The oath held for twenty-nine of those days.",
    source: "Wikipedia: Mount Etna",
    tone: "red",
  },
  {
    id: "place:ogygia",
    name: "Ogygia",
    site: "Gozo, Malta (conventional identification)",
    lat: 36.05,
    lon: 14.25,
    kind: "visited",
    day: 1095,
    summary:
      "Seven years. Landfall on day 1,095, alone, on a keel. The raft goes in the water this morning.",
    source: "Wikipedia: Gozo",
    tone: "amber",
  },
  {
    id: "place:calypso-cave",
    name: "The cave",
    site: "Ramla Bay, Gozo, Malta",
    lat: 36.062,
    lon: 14.283,
    kind: "visited",
    day: 1095,
    summary: "Where the seven years were spent. Four springs, a vine, alder and poplar and cypress.",
    source: "Wikipedia: Ramla Bay",
    tone: "amber",
  },
  {
    id: "place:scheria",
    name: "Scheria",
    site: "Corfu (Kerkyra), Ionian Islands, Greece",
    lat: 39.6,
    lon: 19.87,
    kind: "ahead",
    day: null,
    summary:
      "Seventeen days out, if the forecast holds. Sailors with fast ships and no reason yet to lend one.",
    source: "Wikipedia: Corfu",
    tone: "blue",
  },
  {
    id: "place:pylos",
    name: "Pylos",
    site: "Pylos, Messenia, Greece",
    lat: 36.9139,
    lon: 21.6964,
    kind: "elsewhere",
    day: null,
    summary: "Telemachus went there first, for news, and was sent on with a chariot and no answer.",
    source: "Wikipedia: Pylos",
    tone: "blue",
  },
  {
    id: "place:sparta",
    name: "Sparta",
    site: "Sparta, Laconia, Greece",
    lat: 37.0819,
    lon: 22.4236,
    kind: "elsewhere",
    day: null,
    summary: "Where Telemachus is now. Menelaus has the first real news in ten years and is in no hurry with it.",
    source: "Wikipedia: Sparta",
    tone: "blue",
  },
];

/** Index by id, so cross-module references resolve without a scan. */
export const placeById: Record<PlaceId, Place> = Object.fromEntries(
  places.map((p) => [p.id, p])
) as Record<PlaceId, Place>;

/**
 * The voyage as a polyline, in route order, `[lon, lat]` per point -- the
 * order MapView reads (`px(c[0])`, `py(c[1])`). Troy to Ogygia: everything
 * that has already happened.
 */
export const voyageRoute: [number, number][] = [
  [26.2389, 39.9575], // Troy
  [25.5167, 40.9], // Ismarus
  [23.1986, 36.4381], // Cape Malea
  [10.8833, 33.8], // Lotus-eaters
  [15.1614, 37.5636], // Cyclopes
  [14.95, 38.4667], // Aeolia
  [9.1569, 41.3868], // Laestrygonians
  [13.05, 41.2333], // Aeaea
  [20.5345, 39.2362], // the house of the dead
  [13.05, 41.2333], // back to Aeaea
  [14.433, 40.581], // the Sirens
  [15.6508, 38.2647], // Charybdis
  [15.719, 38.2507], // Scylla
  [14.995, 37.755], // Thrinacia
  [14.25, 36.05], // Ogygia
];

/**
 * The leg that has not happened yet: Ogygia to Scheria to Ithaca. Drawn in a
 * different tone so the map distinguishes a record from a plan.
 */
export const plannedRoute: [number, number][] = [
  [14.25, 36.05], // Ogygia
  [19.87, 39.6], // Scheria
  [20.7202, 38.3647], // Ithaca
];

/**
 * The whole Mediterranean, ten years of it. Eight labelled pins only: the
 * route carries the rest, and MapView does not thin colliding labels.
 */
export const voyageMap: MapScene = {
  title: "Troy to here",
  subtitle: "ten years · 15 landfalls · 1 survivor",
  meta: "5,453 km sailed",
  icon: "graph",
  pins: [
    { lat: 39.9575, lon: 26.2389, label: "Troy", meta: "day 0", tone: "neutral" },
    { lat: 36.4381, lon: 23.1986, label: "Cape Malea", meta: "day 21", tone: "gold" },
    { lat: 33.8, lon: 10.8833, label: "Lotus-eaters", meta: "day 30", tone: "purple" },
    { lat: 41.3868, lon: 9.1569, label: "Laestrygonians", meta: "11 ships", tone: "red" },
    { lat: 41.2333, lon: 13.05, label: "Aeaea", meta: "1 year", tone: "purple" },
    { lat: 38.2507, lon: 15.719, label: "Scylla", meta: "6 men", tone: "red" },
    { lat: 36.05, lon: 14.25, label: "Ogygia", meta: "7 years", tone: "amber" },
    { lat: 38.3647, lon: 20.7202, label: "Ithaca", meta: "home", tone: "teal" },
  ],
  paths: [
    { coords: voyageRoute, tone: "amber", width: 2 },
    { coords: plannedRoute, tone: "teal", width: 2 },
  ],
  // Small enough that the pins' own bounding box governs the view rather than
  // this minimum: the Mediterranean is already 1,900 km across at this bbox.
  spanKm: 400,
  height: 168,
};

/**
 * The decision, at the scale the decision was actually made. Three kilometres
 * of water with a hazard on each shore, which is the entire argument.
 */
export const straitMap: MapScene = {
  title: "The strait",
  subtitle: "Scylla to port, Charybdis to starboard · 6 km apart",
  meta: "6 km",
  icon: "deadline",
  pins: [
    { lat: 38.2507, lon: 15.719, label: "Scylla", meta: "six, certain", tone: "red" },
    { lat: 38.2647, lon: 15.6508, label: "Charybdis", meta: "all, possible", tone: "red" },
  ],
  attribution: OSM_ATTRIBUTION,
  land: geoLand("messina"),
  paths: [
    ...geoPaths("messina"),
    {
      // The passage as steered: hard against the Calabrian shore.
      coords: [
        [15.6325, 38.19],
        [15.705, 38.235],
        [15.7215, 38.262],
        [15.69, 38.295],
      ],
      tone: "amber",
      width: 2,
    },
  ],
  spanKm: 9,
  height: 148,
};

/** Home, at the scale of a harbour. The destination behind every open loop. */
export const ithacaMap: MapScene = {
  title: "Ithaca",
  subtitle: "Vathy · 108 guests, none invited",
  meta: "12 km",
  icon: "resolved",
  pins: [{ lat: 38.3647, lon: 20.7202, label: "Vathy", meta: "the hall", tone: "teal" }],
  paths: geoPaths("ithaca"),
  land: geoLand("ithaca"),
  spanKm: 12,
  height: 128,
  attribution: OSM_ATTRIBUTION,
};

/**
 * Ogygia. Seven years here, and the island is the one shape in this world the
 * owner could draw from memory -- which is exactly what coastline buys that a
 * graticule cannot.
 */
export const gozoMap: MapScene = {
  title: "Ogygia",
  subtitle: "Gozo · day 1,095 to day 3,652",
  meta: "18 km",
  icon: "history",
  pins: [
    { lat: 36.05, lon: 14.25, label: "Ogygia", meta: "here", tone: "amber" },
    { lat: 36.062, lon: 14.283, label: "The cave", meta: "Ramla Bay", tone: "neutral" },
  ],
  paths: geoPaths("gozo"),
  land: geoLand("gozo"),
  spanKm: 18,
  height: 148,
  attribution: OSM_ATTRIBUTION,
};

/** Scheria, the last landfall before Ithaca and the only welcome in ten years. */
export const corfuMap: MapScene = {
  title: "Scheria",
  subtitle: "Corfu · the Phaeacians, and a ship home",
  meta: "52 km",
  icon: "resolved",
  pins: [{ lat: 39.6, lon: 19.87, label: "Scheria", meta: "the harbour", tone: "teal" }],
  paths: geoPaths("corfu"),
  land: geoLand("corfu"),
  spanKm: 52,
  height: 148,
  attribution: OSM_ATTRIBUTION,
};

/**
 * Troy, and **the one scene that needs roads**. A single shoreline curve does
 * not locate you -- D25 measured it as the weak case of the five -- so the road
 * network goes in a step quieter than the coast and turns a line into a place.
 */
export const troyMap: MapScene = {
  title: "Troy",
  subtitle: "Hisarlik · day 0 of 3,652",
  meta: "30 km",
  icon: "history",
  pins: [{ lat: 39.9575, lon: 26.2389, label: "Troy", meta: "where it started", tone: "red" }],
  paths: geoPaths("troy"),
  land: geoLand("troy"),
  spanKm: 30,
  height: 148,
  attribution: OSM_ATTRIBUTION,
};

/**
 * Vathy at street scale: the same verified coordinate as `ithacaMap`, at
 * 1.8 km instead of 12, which moves the geometry from the road tier to the
 * street tier — the demo for the detail ladder. At this span a block is
 * legible, so the residential streets come in a step quieter than the roads
 * and the harbour front reads as a place rather than a shape.
 */
export const vathyMap: MapScene = {
  title: "Vathy",
  subtitle: "the harbour town · every street, this once",
  meta: "1.8 km",
  icon: "resolved",
  // One pin: the world's verified Ithaca coordinate. A second pin here would
  // need a place with a source of its own (`tests/fixtures.test.ts` holds
  // every map pin to one), and the harbour front is what the streets draw.
  pins: [{ lat: 38.3647, lon: 20.7202, label: "The hall", meta: "Penelope · 108 guests", tone: "teal" }],
  paths: geoPaths("vathy"),
  land: geoLand("vathy"),
  spanKm: 1.8,
  height: 148,
  attribution: OSM_ATTRIBUTION,
};

/** Every map scene the world offers, for the story that iterates them. */
export const mapScenes: MapScene[] = [voyageMap, straitMap, ithacaMap, vathyMap, gozoMap, corfuMap, troyMap];

/** Convenience: only the pins, for a story that wants one flat list. */
export const allPins: MapPin[] = mapScenes.flatMap((s) => s.pins);

/** Convenience: only the paths. */
export const allPaths: MapPath[] = mapScenes.flatMap((s) => s.paths);
