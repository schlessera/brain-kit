import { distanceM, EARTH_RADIUS_M, routePoint, type ParsedTrack, type RoutePoint } from "./track.js";

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

interface Edge { a: RoutePoint; b: RoutePoint; x: Vector; y: Vector; angle: number; lengthM: number; section: number; index: number }
function edges(track: ParsedTrack): Edge[] {
  return track.segments.flatMap((s,section)=>s.slice(1).map((b,i)=> {
    const a=s[i]!, x=vector(a), y=vector(b), arc=angle(x,y);
    return {a,b,x,y,angle:arc,lengthM:metres(a,b),section,index:i};
  }));
}
const ambiguous = (e: Edge): boolean => Math.PI-e.angle < 1e-10;
function sample(e: Edge, fraction: number): Coordinate {
  if (e.angle < 1e-14) return {lat:e.a.lat,lon:e.a.lon};
  const a=scale(e.x,Math.sin((1-fraction)*e.angle)/Math.sin(e.angle));
  const b=scale(e.y,Math.sin(fraction*e.angle)/Math.sin(e.angle));
  return coordinate([a[0]+b[0],a[1]+b[1],a[2]+b[2]]);
}
function closestOnEdge(query: Coordinate, e: Edge): {point: Coordinate; distanceM: number; fraction: number} {
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
function tolerance(value: number): void {
  if (!Number.isFinite(value) || value<0 || value>Math.PI*EARTH_RADIUS_M) throw new Error("Tolerance must be finite metres from 0 to the half-circumference of the Earth.");
}

export interface NearestTrackPoint {
  status: "ok" | "partial" | "unknown";
  partial: boolean;
  distance: {value: number | null; unit: "m"};
  point: Coordinate | null;
  location: {section: number; index: number; fraction: number} | null;
  withinTolerance: boolean | null;
  counts: ParsedTrack["counts"];
  unknown: string[];
  method: {distance: "great_circle_segment"; earthRadiusM: number; toleranceM: number; scope: "retained_geometry"};
}

/** Closest point on minor great-circle arcs, including interiors, with no edge across a section gap. */
export function nearestTrackPoint(track: ParsedTrack, query: Coordinate, toleranceM: number): NearestTrackPoint {
  const validated=routePoint(query.lat,query.lon);
  tolerance(toleranceM);
  const arcs=edges(track), unknown=arcs.some(ambiguous) ? ["ambiguous_antipodal_edge"] : [];
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

export interface TrackCoverageOptions { toleranceM: number; sampleSpacingM?: number }
export interface TrackCoverage {
  status: "ok" | "partial" | "unknown";
  partial: boolean;
  direction: "A_relative_to_B";
  counts: {a: ParsedTrack["counts"]; b: ParsedTrack["counts"]};
  ratio: number | null;
  coveredLength: {value: number | null; unit: "m"};
  usableLength: {value: number; unit: "m"};
  bounds: {minimumRatio: number; maximumRatio: number} | null;
  unknown: string[];
  method: {distance: "great_circle_segment"; earthRadiusM: number; toleranceM: number;
    sampleSpacingM: number; estimator: "arc_length_midpoints"; scope: "usable_sections_of_A";
    maxSamples: number; maxComparisons: number; samples: number};
}

/** Directional arc-length estimate; conservative bounds expose sampling uncertainty. */
export function trackCoverage(a: ParsedTrack, b: ParsedTrack, options: TrackCoverageOptions): TrackCoverage {
  tolerance(options.toleranceM);
  const spacing=options.sampleSpacingM ?? Math.max(0.1,Math.min(5,options.toleranceM/4));
  if (!Number.isFinite(spacing) || spacing<=0 || spacing>1_000) throw new Error("Sample spacing must be finite metres above 0 and at most 1,000.");
  const source=edges(a), target=edges(b), total=source.reduce((n,e)=>n+e.lengthM,0), unknown: string[]=[];
  const maxSamples=100_000, maxComparisons=5_000_000;
  if (!total) unknown.push("A_has_no_positive_usable_length");
  if (!target.length) unknown.push("B_has_no_usable_line");
  if ([...source,...target].some(ambiguous)) unknown.push("ambiguous_antipodal_edge");
  const samples=source.reduce((n,e)=>n+(e.lengthM ? Math.ceil(e.lengthM/spacing) : 0),0);
  if (samples>maxSamples || samples*target.length>maxComparisons) unknown.push("analysis_limit_exceeded");
  let covered=0, lower=0, upper=0;
  if (!unknown.length) for (const e of source) {
    if (!e.lengthM) continue;
    const count=Math.ceil(e.lengthM/spacing), step=e.lengthM/count;
    for (let i=0;i<count;i++) {
      const point=sample(e,(i+0.5)/count);
      let distance=Infinity;
      for (const other of target) distance=Math.min(distance,closestOnEdge(point,other).distanceM);
      if (distance<=options.toleranceM) covered+=step;
      // Distance to a fixed set is 1-Lipschitz along the arc. These interval
      // tests bound true covered length independently of the midpoint estimate.
      if (distance+step/2<=options.toleranceM) lower+=step;
      if (distance-step/2<=options.toleranceM) upper+=step;
    }
  }
  const clamp=(n: number): number=>Math.max(0,Math.min(1,n/total));
  return {status:unknown.length ? "unknown" : a.partial || b.partial ? "partial" : "ok",partial:a.partial || b.partial,
    direction:"A_relative_to_B",counts:{a:{...a.counts},b:{...b.counts}},ratio:unknown.length ? null : clamp(covered),
    coveredLength:{value:unknown.length ? null : covered,unit:"m"},usableLength:{value:total,unit:"m"},
    bounds:unknown.length ? null : {minimumRatio:clamp(lower),maximumRatio:clamp(upper)},unknown,
    method:{distance:"great_circle_segment",earthRadiusM:EARTH_RADIUS_M,toleranceM:options.toleranceM,
      sampleSpacingM:spacing,estimator:"arc_length_midpoints",scope:"usable_sections_of_A",maxSamples,maxComparisons,
      samples:unknown.length ? 0 : samples}};
}
