/**
 * Great-circle edge geometry shared by the spatial queries. Internal to the
 * package: no entry point re-exports this module.
 */
import { distanceM, EARTH_RADIUS_M, routePoint, type ParsedTrack, type RoutePoint } from "./track.js";
import type { NearestTrackPoint } from "./spatial.js";

type Coordinate = Pick<RoutePoint, "lat" | "lon">;
type Vector = [number, number, number];
const RAD = Math.PI / 180;
const dot = (a: Vector, b: Vector): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm = (a: Vector): number => Math.hypot(...a);
const scale = (a: Vector, n: number): Vector => [a[0]*n,a[1]*n,a[2]*n];
const cross = (a: Vector, b: Vector): Vector => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const vector = (p: Coordinate): Vector => [Math.cos(p.lat*RAD)*Math.cos(p.lon*RAD),Math.cos(p.lat*RAD)*Math.sin(p.lon*RAD),Math.sin(p.lat*RAD)];
const coordinate = (v: Vector): Coordinate => ({lat:Math.atan2(v[2],Math.hypot(v[0],v[1]))/RAD,lon:Math.atan2(v[1],v[0])/RAD});
const angle = (a: Vector, b: Vector): number => Math.atan2(norm(cross(a,b)),dot(a,b));
const metres = (a: Coordinate, b: Coordinate): number => distanceM({...a,elevation_m:null,time:null},{...b,elevation_m:null,time:null});

/** Work counters the tests read: edge-list builds and edge comparisons. */
export const spatialWork = {edgeBuilds: 0, comparisons: 0};

export interface Edge { a: RoutePoint; b: RoutePoint; x: Vector; y: Vector; angle: number; lengthM: number; section: number; index: number }
export function trackEdges(track: ParsedTrack): Edge[] {
  spatialWork.edgeBuilds++;
  return track.segments.flatMap((s,section)=>s.slice(1).map((b,i)=> {
    const a=s[i]!, x=vector(a), y=vector(b), arc=angle(x,y);
    return {a,b,x,y,angle:arc,lengthM:metres(a,b),section,index:i};
  }));
}
export const ambiguous = (e: Edge): boolean => Math.PI-e.angle < 1e-10;
export function sample(e: Edge, fraction: number): Coordinate {
  if (e.angle < 1e-14) return {lat:e.a.lat,lon:e.a.lon};
  const a=scale(e.x,Math.sin((1-fraction)*e.angle)/Math.sin(e.angle));
  const b=scale(e.y,Math.sin(fraction*e.angle)/Math.sin(e.angle));
  return coordinate([a[0]+b[0],a[1]+b[1],a[2]+b[2]]);
}
export function closestOnEdge(query: Coordinate, e: Edge): {point: Coordinate; distanceM: number; fraction: number} {
  spatialWork.comparisons++;
  const da=metres(query,e.a), db=metres(query,e.b);
  let closest={point:{lat:e.a.lat,lon:e.a.lon},distanceM:da,fraction:0};
  if (db<da) closest={point:{lat:e.b.lat,lon:e.b.lon},distanceM:db,fraction:1};
  if (e.angle < 1e-14) return closest;
  const q=vector(query), n=scale(cross(e.x,e.y),1/norm(cross(e.x,e.y))), height=dot(q,n);
  const projection: Vector=[q[0]-height*n[0],q[1]-height*n[1],q[2]-height*n[2]];
  if (norm(projection)<1e-14) return closest;
  const projected=scale(projection,1/norm(projection)), fromA=angle(e.x,projected);
  if (fromA+angle(projected,e.y)<=e.angle+1e-12) {
    const point=coordinate(projected), distance=metres(query,point);
    if (distance<closest.distanceM) closest={point,distanceM:distance,fraction:Math.min(1,fromA/e.angle)};
  }
  return closest;
}
export function tolerance(value: number): void {
  if (!Number.isFinite(value) || value<0 || value>Math.PI*EARTH_RADIUS_M) throw new Error("Tolerance must be finite metres from 0 to the half-circumference of the Earth.");
}

/** `nearestTrackPoint` over an edge list the caller built once for `track`. */
export function nearestOnEdges(track: ParsedTrack, arcs: readonly Edge[], query: Coordinate, toleranceM: number): NearestTrackPoint {
  const validated=routePoint(query.lat,query.lon);
  tolerance(toleranceM);
  const unknown=arcs.some(ambiguous) ? ["ambiguous_antipodal_edge"] : [];
  let best: {point: Coordinate; distanceM: number; location: NonNullable<NearestTrackPoint["location"]>} | null=null;
  if (!unknown.length) {
    for (const e of arcs) {
      const next=closestOnEdge(validated,e);
      if (!best || next.distanceM<best.distanceM) best={...next,location:{section:e.section,index:e.index,fraction:next.fraction}};
    }
    for (const [section,s] of track.segments.entries()) if (s.length===1) {
      const point=s[0]!, distance=metres(validated,point);
      if (!best || distance<best.distanceM) best={point:{lat:point.lat,lon:point.lon},distanceM:distance,location:{section,index:0,fraction:0}};
    }
    if (!best) unknown.push("no_retained_geometry");
  }
  return {status:best ? track.partial ? "partial" : "ok" : "unknown",partial:track.partial,
    distance:{value:best?.distanceM ?? null,unit:"m"},point:best?.point ?? null,location:best?.location ?? null,
    withinTolerance:best ? best.distanceM<=toleranceM : null,counts:{...track.counts},unknown,
    method:{distance:"great_circle_segment",earthRadiusM:EARTH_RADIUS_M,toleranceM,scope:"retained_geometry"}};
}

const METRES_PER_DEGREE=EARTH_RADIUS_M*RAD;
/** Past this latitude a longitude cell degenerates; such inputs test every edge. */
const GRID_MAX_ABS_LAT=85;
/** An edge that would occupy more cells than this is tested by every sample instead. */
export const MAX_CELLS_PER_EDGE=2_048;
const MIN_CELL_M=1;

/** Cells per edge registered by the latest `coverageCandidates` call, for the tests. */
export const gridShape = {cells: 0, registrations: 0, everywhere: 0, grid: false};

/**
 * The edges of `target` that can lie within `reachM` of a point, found
 * through a uniform latitude/longitude grid. Every edge within the reach is
 * returned, so a minimum distance over the candidates equals the minimum over
 * all edges whenever that minimum is within the reach.
 *
 * An edge is walked along its arc at a step of one cell, and registered in
 * every cell of a box around each walked point that holds every point within
 * the reach plus half a step of it. The box's longitude width comes from the
 * highest latitude the box reaches. Where a box would pass the date line or
 * come near a pole there is no grid (`null`): every edge is a candidate.
 * An edge that would occupy more than `MAX_CELLS_PER_EDGE` cells is a
 * candidate of every point.
 */
export function coverageCandidates(target: readonly Edge[], reachM: number): ((point: Coordinate) => readonly Edge[]) | null {
  Object.assign(gridShape,{cells:0,registrations:0,everywhere:0,grid:false});
  const cellM=Math.max(reachM,MIN_CELL_M), cellLat=cellM/METRES_PER_DEGREE;
  const highest=target.reduce((n,e)=>Math.max(n,Math.abs(e.a.lat),Math.abs(e.b.lat)),0);
  if (highest>GRID_MAX_ABS_LAT) return null;
  const cellLon=cellM/(METRES_PER_DEGREE*Math.cos(highest*RAD));
  // Shift longitude cells to be non-negative so `key` cannot collide across rows.
  const lonOffset=Math.ceil(180/cellLon)+1, lonCells=2*lonOffset+1;
  const key=(i: number, j: number): number=>i*lonCells+j+lonOffset;
  const cells=new Map<number,Edge[]>(), everywhere: Edge[]=[];
  for (const e of target) {
    const arcM=e.angle*EARTH_RADIUS_M, steps=Math.max(1,Math.ceil(arcM/cellM));
    if (steps+1>MAX_CELLS_PER_EDGE) { everywhere.push(e); continue; }
    // Margins only add candidates; they absorb rounding between this walk and closestOnEdge.
    const r=(reachM+arcM/(2*steps))*(1+1e-6)+1e-3, dLat=r/METRES_PER_DEGREE;
    const occupied=new Set<number>();
    for (let k=0;k<=steps && occupied.size<=MAX_CELLS_PER_EDGE;k++) {
      const w=sample(e,k/steps), top=Math.abs(w.lat)+dLat;
      if (top>GRID_MAX_ABS_LAT) return null;
      const dLon=r/(METRES_PER_DEGREE*Math.cos(top*RAD));
      if (w.lon-dLon<=-180 || w.lon+dLon>=180) return null;
      for (let i=Math.floor((w.lat-dLat)/cellLat);i<=Math.floor((w.lat+dLat)/cellLat);i++) {
        for (let j=Math.floor((w.lon-dLon)/cellLon);j<=Math.floor((w.lon+dLon)/cellLon);j++) occupied.add(key(i,j));
      }
    }
    if (occupied.size>MAX_CELLS_PER_EDGE) { everywhere.push(e); continue; }
    for (const cell of occupied) {
      const list=cells.get(cell);
      if (list) list.push(e); else cells.set(cell,[e]);
    }
    gridShape.registrations+=occupied.size;
  }
  Object.assign(gridShape,{cells:cells.size,everywhere:everywhere.length,grid:true});
  return (point)=> {
    const found=cells.get(key(Math.floor(point.lat/cellLat),Math.floor(point.lon/cellLon)));
    return found ? everywhere.length ? [...found,...everywhere] : found : everywhere;
  };
}
