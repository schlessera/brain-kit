import { closestOnEdge, coverageCandidates, ambiguous, nearestOnEdges, sample, tolerance, trackEdges } from "./arcs.js";
import { EARTH_RADIUS_M, type ParsedTrack, type RoutePoint } from "./track.js";

type Coordinate = Pick<RoutePoint, "lat" | "lon">;

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
  return nearestOnEdges(track,trackEdges(track),query,toleranceM);
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
  const source=trackEdges(a), target=trackEdges(b), total=source.reduce((n,e)=>n+e.lengthM,0), unknown: string[]=[];
  const maxSamples=100_000, maxComparisons=5_000_000;
  if (!total) unknown.push("A_has_no_positive_usable_length");
  if (!target.length) unknown.push("B_has_no_usable_line");
  if ([...source,...target].some(ambiguous)) unknown.push("ambiguous_antipodal_edge");
  const samples=source.reduce((n,e)=>n+(e.lengthM ? Math.ceil(e.lengthM/spacing) : 0),0);
  if (samples>maxSamples) unknown.push("analysis_limit_exceeded");
  let covered=0, lower=0, upper=0;
  if (!unknown.length) {
    // A distance is only ever compared with the tolerance plus or minus half a
    // step, so edges beyond that reach cannot change any of the three tests.
    const index=coverageCandidates(target,options.toleranceM+spacing/2), candidates=index ?? (()=>target);
    // The comparison bound counts comparisons performed, and stops there.
    // Without a grid every sample tests every edge, so the count is known now.
    let comparisons=0;
    if (!index && samples*target.length>maxComparisons) unknown.push("analysis_limit_exceeded");
    else measure: for (const e of source) {
      if (!e.lengthM) continue;
      const count=Math.ceil(e.lengthM/spacing), step=e.lengthM/count;
      for (let i=0;i<count;i++) {
        const point=sample(e,(i+0.5)/count), near=candidates(point);
        if (comparisons+near.length>maxComparisons) { unknown.push("analysis_limit_exceeded"); break measure; }
        comparisons+=near.length;
        let distance=Infinity;
        for (const other of near) distance=Math.min(distance,closestOnEdge(point,other).distanceM);
        if (distance<=options.toleranceM) covered+=step;
        // Distance to a fixed set is 1-Lipschitz along the arc. These interval
        // tests bound true covered length independently of the midpoint estimate.
        if (distance+step/2<=options.toleranceM) lower+=step;
        if (distance-step/2<=options.toleranceM) upper+=step;
      }
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
