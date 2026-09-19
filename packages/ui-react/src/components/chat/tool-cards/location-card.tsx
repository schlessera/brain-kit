/**
 * The `get_current_location` result, drawn on the kit's `MapView` (S9: the
 * first in-chat component rendered end to end from its contract; D37 moved
 * the span rule, the uncertainty ring, the note and the width cap into the
 * kit, so the card is now the fetch and the caption).
 *
 * Typed `LocationPayload` — the contract's payload type — so the fields it
 * reads are the fields the handler is contracted to send. The pin, the
 * span and the caption are pure functions of that payload. What is not pure
 * is the shoreline: `MapView` fetches nothing (kit D13), so this card is the
 * container that asks the server's `/geo/coastline` for the geometry around
 * the fix and hands it down as `paths` and `land`. The request is cancelled
 * on unmount, and any failure — no server, an older server without the
 * route, an Overpass outage — leaves a map with a correct pin, a graticule
 * and a true scale bar, which is a good locator on its own.
 *
 * The bounding box asked for is the box `MapView` will draw: `spanKm` across
 * the width, the height in proportion to the card, plus the component's own
 * margins. The server bleeds well past it, so a slightly different frame is
 * a cache hit rather than a fresh request to a shared service.
 */

import { MapView, type MapLand, type MapPath } from "@schlessera/brain-ui-kit";
import type { LocationPayload } from "@schlessera/brain-ui-sdk/client";
import { useEffect, useState } from "react";
import { useBrainApi } from "../../../root-context.js";
import type { CoastlineGeometry } from "../../../lib/api-client.js";

/** 4 decimal places is ~11 m — finer than any browser fix is honest about. */
function coord(value: number): string {
  return value.toFixed(4);
}

function accuracy(meters: number): string {
  return meters >= 1000
    ? `±${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km`
    : `±${Math.round(meters)} m`;
}

/** `MapView`'s own default projection width and card height. */
const WIDTH = 330;
const HEIGHT = 190;

/**
 * The view's span across its width, in kilometres — the kit's own rule
 * (`max(1.6 km, 6 × accuracy)`, D37), repeated here only so the coastline
 * request covers the box the kit will draw. The kit computes it again from
 * `accuracyM`; the two must agree, and `tests/location-card.test.ts` pins
 * this one.
 */
export function spanFor(accuracyMeters: number): number {
  return Math.max(1.6, (accuracyMeters * 6) / 1000);
}

/**
 * The bbox `MapView` draws for one pin, as `[west, south, east, north]`. The
 * same arithmetic as the component's: the span sets the longitude range at
 * the pin's latitude, the card's aspect sets the latitude range, and the
 * 12% / 14% margins are added on each side. Clamped to the server's 5°
 * limit and to the poles.
 */
export function viewBox(lat: number, lon: number, spanKm: number): [number, number, number, number] {
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const degLon = Math.min(4.5, (spanKm / 111 / cos) * 1.24);
  const degLat = Math.min(4.5, (spanKm / 111) * (HEIGHT / WIDTH) * 1.28);
  const west = Math.max(-180, lon - degLon / 2);
  const east = Math.min(180, lon + degLon / 2);
  const south = Math.max(-89, lat - degLat / 2);
  const north = Math.min(89, lat + degLat / 2);
  return [west, south, east, north];
}

/** The server's tiers as `MapView` paths, at the kit fixtures' weights. */
export function geometryPaths(geo: CoastlineGeometry): MapPath[] {
  return [
    ...geo.coastline.map((coords) => ({ coords, tone: "neutral" as const, width: 1 })),
    ...geo.roads.map((coords) => ({ coords, tone: "neutral" as const, width: 0.6 })),
    ...geo.streets.map((coords) => ({ coords, tone: "neutral" as const, width: 0.35 })),
  ];
}

export function LocationResultCard({
  latitude,
  longitude,
  accuracyMeters,
  place,
  address,
  note,
  retrievedAt,
}: LocationPayload) {
  const api = useBrainApi();
  const spanKm = spanFor(accuracyMeters);
  const [geo, setGeo] = useState<CoastlineGeometry | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setGeo(null);
    api
      .geoCoastline(viewBox(latitude, longitude, spanKm), { width: WIDTH, signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setGeo(result);
      })
      .catch(() => {
        // A plainer map, on purpose. The pin is the answer; the shore is
        // context, and context that cannot be had is not an error to show.
      });
    return () => controller.abort();
  }, [api, latitude, longitude, spanKm]);

  const when = new Date(retrievedAt);
  const stamp = Number.isNaN(when.getTime())
    ? retrievedAt
    : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const paths = geo ? geometryPaths(geo) : [];
  const land: MapLand | undefined = geo && geo.land.length ? { rings: geo.land } : undefined;
  const drawn = paths.length > 0 || land !== undefined;

  return (
    // The kit owns the span rule, the uncertainty ring, the note and the
    // 420px cap (D37); the card passes the payload through.
    <MapView
      pins={[{ lat: latitude, lon: longitude, label: place ?? "Here", meta: accuracy(accuracyMeters), tone: "amber" }]}
      accuracyM={accuracyMeters}
      paths={paths}
      land={land}
      // The place name is the answer; coordinates are the evidence for it,
      // so they stay visible but quiet rather than leading.
      title={place ?? "Coordinates only"}
      subtitle={address && address !== place ? address : undefined}
      meta={`${coord(latitude)}, ${coord(longitude)} · ${accuracy(accuracyMeters)} · ${stamp}`}
      note={note}
      // The credit is the licence's, not the design's: it appears exactly
      // when OpenStreetMap geometry is on the map.
      attribution={drawn ? geo?.attribution : undefined}
    />
  );
}
