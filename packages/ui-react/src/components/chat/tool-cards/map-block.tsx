/**
 * The `map` block: several named places on real geography, and the list that
 * always carries every one of them (#44).
 *
 * The block is the model's places and nothing else; this is the container
 * that turns them into a drawing. `planPlaces` decides the mode and the
 * frames from the coordinates alone, this card asks the server's
 * `/geo/coastline` for each frame's box, and the kit's `PlaceMap` draws what
 * it is handed. The same route and cache as the location card: no new
 * geometry service, and a place looked at before costs nothing.
 *
 * The geometry is CONTEXT, never evidence. A coastline under a pin is real;
 * whether the pin is right is the brain's claim, which the card states in
 * words. So a request that fails, or comes back empty, is not an error to
 * show: the frame becomes one line and the list is the answer.
 *
 * `isStatic` is for a render nothing will update, a shared page or a print:
 * no request is made, so no frame is drawn, and the list is open, because a
 * row behind a control nobody can press is a row that is gone.
 */

import { PlaceMap, type PlaceMapFrame } from "@schlessera/brain-ui-kit";
import { planPlaces, type Block } from "@schlessera/brain-ui-sdk/client";
import { useEffect, useMemo, useState } from "react";

import type { CoastlineGeometry } from "../../../lib/api-client.js";
import { useBrainApi } from "../../../root-context.js";
import { geometryPaths } from "../../../lib/geometry-paths.js";

type MapBlock = Extract<Block, { kind: "map" }>;
type FrameGeometry = PlaceMapFrame["geometry"];

/**
 * The width sent with every frame's box: the location card's, for the same
 * reason. The server takes its detail tier and its tolerance from the box's
 * width over this many pixels, and buckets 495 up to 660, which errs towards
 * streets rather than an empty map.
 */
export const MAP_BLOCK_REQUEST_WIDTH = 495;

/** Below this viewport width the list starts collapsed past eight rows. */
const LIST_OPEN_FROM_PX = 480;

/** The server's answer as a frame's geometry: drawn, or an honest `"none"`. */
export function frameGeometry(geo: CoastlineGeometry): FrameGeometry {
  const paths = geometryPaths(geo);
  // A `partial` answer with some geometry in it is drawn as geometry; one
  // with none is the same as no answer at all.
  if (paths.length === 0 && geo.land.length === 0) return "none";
  return {
    paths,
    ...(geo.land.length ? { land: { rings: geo.land } } : {}),
    attribution: geo.attribution,
  };
}

function listOpenByDefault(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(`(min-width: ${LIST_OPEN_FROM_PX}px)`).matches;
}

export function MapBlockCard({ block, isStatic = false }: { block: MapBlock; isStatic?: boolean }) {
  const api = useBrainApi();
  // The plan is a pure function of the places, so the same places are the
  // same plan and the same requests, however often the answer re-renders.
  const key = JSON.stringify(block.places);
  const plan = useMemo(() => planPlaces(JSON.parse(key) as MapBlock["places"]), [key]);
  const [geometry, setGeometry] = useState<FrameGeometry[]>(() =>
    plan.frames.map(() => (isStatic ? "none" : "pending")),
  );
  const [listOpen] = useState(() => (isStatic ? true : listOpenByDefault()));

  useEffect(() => {
    if (isStatic) return;
    const controller = new AbortController();
    setGeometry(plan.frames.map(() => "pending"));
    const settle = (index: number, value: FrameGeometry) => {
      if (controller.signal.aborted) return;
      setGeometry((current) => current.map((g, i) => (i === index ? value : g)));
    };
    plan.frames.forEach((frame, index) => {
      api
        .geoCoastline(frame.bbox, { width: MAP_BLOCK_REQUEST_WIDTH, signal: controller.signal })
        .then((geo) => settle(index, frameGeometry(geo)))
        // No server, an older one without the route, an Overpass outage: the
        // frame says there is no map, and the list carries the places.
        .catch(() => settle(index, "none"));
    });
    return () => controller.abort();
  }, [api, plan, isStatic]);

  return (
    <PlaceMap
      {...(block.title ? { title: block.title } : {})}
      rows={plan.rows}
      mode={plan.mode}
      {...(plan.reason ? { reason: plan.reason } : {})}
      frames={plan.frames.map(({ bbox: _bbox, ...frame }, i) => ({ ...frame, geometry: geometry[i] ?? "pending" }))}
      onMapLabels={plan.onMapLabels}
      listOpen={listOpen}
    />
  );
}
