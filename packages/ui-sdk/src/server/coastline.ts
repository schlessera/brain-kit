// Compatibility exports: the shared geo package owns geometry and request I/O.
export {
  OSM_ATTRIBUTION, clipLine, closeAgainstViewport, closedRings, detailFor,
  prepare, prepareLand, signedArea, simplify, stitch, toleranceMetres,
} from "@schlessera/brain-geo";
export type {
  BBox, Coord, CoastlineConfig, CoastlineRequest, CoastlineResult,
  FetchLike, LandOptions, MapDetail,
} from "@schlessera/brain-geo";
export { fetchCoastline } from "@schlessera/brain-geo/server";
