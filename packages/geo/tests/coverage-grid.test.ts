/** Coverage finds candidate edges through a grid and counts the comparisons it performs (#4814). */
import { beforeEach, describe, expect, test } from "bun:test";
import { ambiguous, closestOnEdge, gridShape, sample, spatialWork, tolerance, trackEdges } from "../src/arcs.js";
import { trackCoverage, type TrackCoverage, type TrackCoverageOptions } from "../src/spatial.js";
import { EARTH_RADIUS_M, normalizeTrack, type ParsedTrack } from "../src/track.js";

/** `trackCoverage` as it was before the grid: every sample against every edge of B. */
function bruteForceCoverage(a: ParsedTrack, b: ParsedTrack, options: TrackCoverageOptions): TrackCoverage {
  tolerance(options.toleranceM);
  const spacing=options.sampleSpacingM ?? Math.max(0.1,Math.min(5,options.toleranceM/4));
  if (!Number.isFinite(spacing) || spacing<=0 || spacing>1_000) throw new Error("Sample spacing must be finite metres above 0 and at most 1,000.");
  const source=trackEdges(a), target=trackEdges(b), total=source.reduce((n,e)=>n+e.lengthM,0), unknown: string[]=[];
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

type Point = {lat: number; lon: number};
const RAD=Math.PI/180;
function mulberry32(seed: number): () => number {
  return () => {
    seed=(seed+0x6d2b79f5)|0;
    let t=Math.imul(seed^(seed>>>15),1|seed);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4_294_967_296;
  };
}
/** The point `distanceM` from `p` along `bearingDeg` on the documented sphere. */
function destination(p: Point, bearingDeg: number, distanceM: number): Point {
  const d=distanceM/EARTH_RADIUS_M, t=bearingDeg*RAD, f1=p.lat*RAD;
  const f2=Math.asin(Math.sin(f1)*Math.cos(d)+Math.cos(f1)*Math.sin(d)*Math.cos(t));
  const l2=p.lon*RAD+Math.atan2(Math.sin(t)*Math.sin(d)*Math.cos(f1),Math.cos(d)-Math.sin(f1)*Math.sin(f2));
  return {lat:f2/RAD,lon:((l2/RAD+540)%360)-180};
}
function walk(start: Point, bearingDeg: number, count: number, stepM: number, rand: () => number, wiggleDeg = 8): Point[] {
  const points=[start];
  let bearing=bearingDeg;
  for (let i=1;i<count;i++) {
    bearing+=(rand()-0.5)*wiggleDeg;
    points.push(destination(points[i-1]!,bearing,stepM));
  }
  return points;
}
const bearing=(from: Point, to: Point): number=>Math.atan2(Math.sin((to.lon-from.lon)*RAD)*Math.cos(to.lat*RAD),
  Math.cos(from.lat*RAD)*Math.sin(to.lat*RAD)-Math.sin(from.lat*RAD)*Math.cos(to.lat*RAD)*Math.cos((to.lon-from.lon)*RAD))/RAD;
/** A copy of `path` displaced sideways by `offsetM`, give or take `noiseM`. */
function beside(path: Point[], offsetM: number, noiseM: number, rand: () => number): Point[] {
  return path.map((p,i)=> {
    const next=path[Math.min(i+1,path.length-1)]!, previous=path[Math.max(i-1,0)]!;
    return destination(p,bearing(previous,next)+90,offsetM+(rand()-0.5)*2*noiseM);
  });
}
const sections=(points: Point[], cuts: number[]): Point[][]=>
  [0,...cuts].map((start,i)=>points.slice(start,[...cuts,points.length][i]));

interface Pair { name: string; a: ParsedTrack; b: ParsedTrack; options: TrackCoverageOptions }
function pairs(): Pair[] {
  const out: Pair[]=[];
  for (let seed=1;seed<=6;seed++) {
    const rand=mulberry32(seed), toleranceM=4+rand()*24;
    const b=walk({lat:38.36+rand()*0.1,lon:20.71+rand()*0.1},rand()*360,240,6+rand()*12,rand);
    out.push({name:`mid-latitude ${seed}`,a:normalizeTrack([beside(b,toleranceM*(0.5+rand()),toleranceM*0.6,rand)]),
      b:normalizeTrack([b]),options:{toleranceM}});
  }
  {
    // Coarse explicit sampling: half a step (20 m) is far wider than the tolerance.
    const rand=mulberry32(10), b=walk({lat:51.5,lon:-0.12},200,240,9,rand);
    out.push({name:"coarse sampling",a:normalizeTrack([beside(b,6,6,rand)]),b:normalizeTrack([b]),
      options:{toleranceM:2,sampleSpacingM:40}});
  }
  {
    const rand=mulberry32(11), b=walk({lat:-16.5,lon:179.993},90,160,9,rand,2);
    out.push({name:"date line",a:normalizeTrack([beside(b,8,6,rand)]),b:normalizeTrack([b]),options:{toleranceM:10}});
  }
  {
    const rand=mulberry32(12), b=walk({lat:86.4,lon:-30},20,160,9,rand,6);
    out.push({name:"near the pole",a:normalizeTrack([beside(b,8,6,rand)]),b:normalizeTrack([b]),options:{toleranceM:10}});
  }
  for (const [seed,lat] of [[13,61],[14,68],[15,74]] as const) {
    const rand=mulberry32(seed), toleranceM=6+rand()*10;
    // Heading north, so the offset between A and B runs east-west.
    const b=walk({lat,lon:25.1},0,200,8,rand,4);
    out.push({name:`high latitude ${lat}`,a:normalizeTrack([beside(b,toleranceM*(0.7+rand()*0.5),toleranceM*0.4,rand)]),
      b:normalizeTrack([b]),options:{toleranceM}});
  }
  {
    const rand=mulberry32(16), b=walk({lat:44.2,lon:-1.4},120,300,7,rand), a=beside(b,9,9,rand);
    out.push({name:"multi-section",a:normalizeTrack(sections(a,[70,180,181])),b:normalizeTrack(sections(b,[40,150,260])),
      options:{toleranceM:12}});
  }
  {
    const rand=mulberry32(17), b=walk({lat:-33.9,lon:18.4},200,220,8,rand), a=beside(b,6,8,rand);
    const broken=(points: Point[], at: number)=>[...points.slice(0,at),{lat:91,lon:0},...points.slice(at)];
    out.push({name:"partial",a:normalizeTrack([broken(a,90)]),b:normalizeTrack([broken(b,130)]),options:{toleranceM:9}});
  }
  {
    // A few edges each 3 km long under a tolerance of a few metres, A beside their middles.
    const rand=mulberry32(18), b=walk({lat:47.3,lon:8.5},45,4,3_000,rand,10), edge=trackEdges(normalizeTrack([b]))[1]!;
    const middle=Array.from({length:61},(_,i)=>{
      const along=sample(edge,0.45+i/600), ahead=sample(edge,0.46+i/600);
      return destination(along,bearing(along,ahead)+90,3+rand()*2);
    });
    out.push({name:"long edges",a:normalizeTrack([middle]),b:normalizeTrack([b]),options:{toleranceM:4}});
  }
  return out;
}

beforeEach(()=>{ spatialWork.comparisons=0; spatialWork.edgeBuilds=0; });

describe("grid coverage equals the brute-force loop",()=>{
  for (const pair of pairs()) test(pair.name,()=>{
    const expected=bruteForceCoverage(pair.a,pair.b,pair.options);
    expect(expected.unknown).toEqual([]);
    expect(expected.ratio!).toBeGreaterThan(0);
    expect(trackCoverage(pair.a,pair.b,pair.options)).toEqual(expected);
  });

  test("the generated pairs exercise the grid where it holds and the fallback where it does not",()=>{
    const used=Object.fromEntries(pairs().map(pair=>{ trackCoverage(pair.a,pair.b,pair.options); return [pair.name,gridShape.grid]; }));
    expect(used).toMatchObject({"date line":false,"near the pole":false,"high latitude 61":true,"long edges":true,"multi-section":true});
  });
});

/** Two tracks of `points` points, 20 km long, 10 m apart. */
function recordedPair(points: number): {a: ParsedTrack; b: ParsedTrack} {
  const rand=mulberry32(99), b=walk({lat:38.36,lon:20.71},70,points,20_000/(points-1),rand,6);
  return {a:normalizeTrack([beside(b,10,3,rand)]),b:normalizeTrack([b])};
}

test("a 20 km recorded pair with 5,000 points each is answered with a bounded number of comparisons",()=>{
  const {a,b}=recordedPair(5_000);
  const result=trackCoverage(a,b,{toleranceM:25});
  expect(result.unknown).toEqual([]);
  expect(result.status).toBe("ok");
  expect(result.ratio!).toBeGreaterThan(0.9);
  expect(result.method.samples).toBeGreaterThan(3_000);
  expect(spatialWork.comparisons).toBeLessThan(result.method.samples*50);
});

test("a few edges hundreds of kilometres long under a one-metre tolerance keep the grid small",()=>{
  const b=normalizeTrack([[{lat:46,lon:6},{lat:47.5,lon:9},{lat:46.2,lon:12},{lat:47.9,lon:14.5}]]);
  const a=normalizeTrack([[destination({lat:46.75,lon:7.5},90,0.4),destination({lat:46.75,lon:7.5},90,60)]]);
  const result=trackCoverage(a,b,{toleranceM:1});
  expect(result.unknown).toEqual([]);
  expect(gridShape.grid).toBe(true);
  expect(gridShape.registrations).toBeLessThan(10_000);
  expect(result).toEqual(bruteForceCoverage(a,b,{toleranceM:1}));
});

test("a sample count above 100,000 is refused before any comparison",()=>{
  const result=trackCoverage(normalizeTrack([[{lat:0,lon:0},{lat:0,lon:1}]]),normalizeTrack([[{lat:0,lon:0},{lat:0,lon:1}]]),
    {toleranceM:1,sampleSpacingM:0.1});
  expect(result).toMatchObject({ratio:null,unknown:["analysis_limit_exceeded"],method:{samples:0}});
  expect(spatialWork.comparisons).toBe(0);
});
