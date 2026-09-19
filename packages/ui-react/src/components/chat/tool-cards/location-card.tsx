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
 * The bounding box asked for is the envelope of every box `MapView` can draw
 * for the pin — 1.5 spans across, 1.0 down, the same rule the kit's fixture
 * generator uses (`viewBox` says why those numbers). The server clips to the
 * box it is given and quantises its cache key to ~110 m, so the request has
 * to cover the drawn frame itself; and because the envelope is a function of
 * the pin and the span alone, the same fix at any card width is one cache
 * entry rather than a fresh request to a shared service.
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

/** `MapView`'s own default projection width. */
const WIDTH = 330;

/**
 * How far past the span to fetch, per axis, as a multiple of `spanKm`. The
 * kit's ruling (README, sixth pass, §10) bounds a card at 420px wide with a
 * viewport of 110-260px, and `MapView` draws a single pin as 1.24 spans across
 * (12% margins each side) at any width and 1.24 × H/W spans down: 0.32 for
 * 420×110, 0.77 for 420×260, and this card leaves the height at its 170
 * default, so 1.0 down covers it at any width from 211px up. The square
 * 2.4-span bleed this replaced fetched geometry of which only 23% could ever
 * be drawn (measured on the kit's Messina fixture).
 */
const BLEED_ACROSS = 1.5;
const BLEED_DOWN = 1.0;

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
 * The box to fetch for one pin, as `[west, south, east, north]`: the span at
 * the pin's latitude, grown to the envelope above and centred on the pin.
 * Clamped to the server's 5° limit and to the poles.
 */
export function viewBox(lat: number, lon: number, spanKm: number): [number, number, number, number] {
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const degLon = Math.min(4.5, (spanKm / 111 / cos) * BLEED_ACROSS);
  const degLat = Math.min(4.5, (spanKm / 111) * BLEED_DOWN);
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
    // The box is BLEED_ACROSS times the drawn span, so the width sent with it
    // is BLEED_ACROSS times the drawn width: the server takes its tolerance
    // and its detail tier from the box's width over that many pixels, and the
    // bare 330 would ask for a view half again coarser than the one drawn —
    // a 2 km span asking for streets and getting roads. The server buckets
    // 495 up to 660, which errs on the fine side, never towards an empty map.
    api
      .geoCoastline(viewBox(latitude, longitude, spanKm), {
        width: WIDTH * BLEED_ACROSS,
        signal: controller.signal,
      })
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
