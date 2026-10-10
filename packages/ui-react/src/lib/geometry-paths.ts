import type { MapPath } from "@schlessera/brain-ui-kit";
import type { CoastlineGeometry } from "./api-client.js";

/** The server's tiers as `MapView` paths, at the kit fixtures' weights. */
export function geometryPaths(geo: CoastlineGeometry): MapPath[] {
  return [
    ...geo.coastline.map((coords) => ({ coords, tone: "neutral" as const, width: 1 })),
    ...geo.roads.map((coords) => ({ coords, tone: "neutral" as const, width: 0.6 })),
    ...geo.streets.map((coords) => ({ coords, tone: "neutral" as const, width: 0.35 })),
  ];
}
