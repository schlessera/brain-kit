import { describe, expect, test } from "bun:test";
import { nearestTrackPoint, trackCoverage } from "../src/spatial.js";
import { EARTH_RADIUS_M, normalizeTrack } from "../src/track.js";

const equator=(start: number,end: number)=>normalizeTrack([[{lat:0,lon:start},{lat:0,lon:end}]]);
const degreeM=EARTH_RADIUS_M*Math.PI/180;
describe("spherical track proximity",()=>{
  test("closest point lies inside the segment, with an analytic great-circle distance",()=>{
    const nearest=nearestTrackPoint(equator(-1,1),{lat:1,lon:0},degreeM+1);
    expect(nearest.distance.value).toBeCloseTo(degreeM,6);
    expect(nearest.point!.lat).toBeCloseTo(0,8);
    expect(nearest.point!.lon).toBeCloseTo(0,8);
    expect(nearest.location!.fraction).toBeCloseTo(0.5,8);
    expect(nearest.withinTolerance).toBe(true);
    expect(nearestTrackPoint(equator(-1,1),{lat:1,lon:0},degreeM-1).withinTolerance).toBe(false);
  });

  test("minor arcs cross the date line and the pole without planar shortcuts",()=>{
    const dateline=nearestTrackPoint(equator(179,-179),{lat:1,lon:180},degreeM+1);
    expect(dateline.distance.value).toBeCloseTo(degreeM,6);
    expect(Math.abs(dateline.point!.lon)).toBeCloseTo(180,8);
    const pole=nearestTrackPoint(normalizeTrack([[{lat:80,lon:-90},{lat:80,lon:90}]]),{lat:80,lon:0},2_000_000);
    expect(pole.point!.lat).toBeCloseTo(90,8);
  });

  test("gaps, repeated points and retained singletons are spatial evidence",()=>{
    const track=normalizeTrack([[{lat:0,lon:0},{lat:0,lon:0.001}], [{lat:0,lon:0.009},{lat:0,lon:0.01}]]);
    expect(nearestTrackPoint(track,{lat:0,lon:0.005},1).distance.value).toBeCloseTo(0.004*degreeM,6);
    const singleton=nearestTrackPoint(normalizeTrack([[{lat:0,lon:0}]]),{lat:0,lon:0},0);
    expect(singleton.distance.value).toBe(0);
    expect(singleton.withinTolerance).toBe(true);
    expect(nearestTrackPoint(equator(0,0),{lat:0,lon:0},0).distance.value).toBe(0);
  });

  test("empty and ambiguous geometry give explicit unknown values",()=>{
    expect(nearestTrackPoint(normalizeTrack([]),{lat:0,lon:0},1)).toMatchObject({status:"unknown",distance:{value:null},unknown:["no_retained_geometry"]});
    expect(nearestTrackPoint(equator(0,180),{lat:1,lon:0},1)).toMatchObject({status:"unknown",unknown:["ambiguous_antipodal_edge"]});
    expect(()=>nearestTrackPoint(equator(0,1),{lat:91,lon:0},1)).toThrow("coordinates");
    for (const tolerance of [NaN,-1,Math.PI*EARTH_RADIUS_M+1]) expect(()=>nearestTrackPoint(equator(0,1),{lat:0,lon:0},tolerance)).toThrow("Tolerance");
  });

  test("self and disjoint references have analytic covered lengths",()=>{
    const a=equator(0,0.01), self=trackCoverage(a,a,{toleranceM:10,sampleSpacingM:1});
    expect(self.ratio!).toBeGreaterThanOrEqual(0.99);
    expect(self.usableLength.value).toBeCloseTo(degreeM*0.01,6);
    expect(self.coveredLength.value).toBeCloseTo(degreeM*0.01,6);
    expect(self.bounds!.minimumRatio).toBeGreaterThanOrEqual(0.99);
    expect(trackCoverage(a,equator(1,1.01),{toleranceM:10}).ratio!).toBeLessThan(0.1);
  });

  test("coverage names its direction and returns bounds around the sampled estimate",()=>{
    const a=equator(0,0.02), b=equator(0,0.01), result=trackCoverage(a,b,{toleranceM:1,sampleSpacingM:1});
    expect(result.ratio!).toBeCloseTo(0.5,2);
    expect(trackCoverage(b,a,{toleranceM:1,sampleSpacingM:1}).ratio!).toBeGreaterThanOrEqual(0.99);
    expect(result.direction).toBe("A_relative_to_B");
    expect(result.method).toMatchObject({toleranceM:1,sampleSpacingM:1,scope:"usable_sections_of_A"});
    expect(result.bounds!.minimumRatio).toBeLessThanOrEqual(result.ratio!);
    expect(result.bounds!.maximumRatio).toBeGreaterThanOrEqual(result.ratio!);
    // Analytic equatorial extension past B is exactly the tolerance (one metre).
    const truth=(degreeM*0.01+1)/(degreeM*0.02);
    expect(result.bounds!.minimumRatio).toBeLessThanOrEqual(truth);
    expect(result.bounds!.maximumRatio).toBeGreaterThanOrEqual(truth);
  });

  test("recovery remains partial and neither input's gaps are filled",()=>{
    const a=normalizeTrack([[{lat:0,lon:0},{lat:0,lon:0.001},{lat:91,lon:0},{lat:0,lon:0.009},{lat:0,lon:0.01}]]);
    const middle=equator(0.004,0.006), result=trackCoverage(a,middle,{toleranceM:1});
    expect(result.ratio).toBe(0);
    expect(result).toMatchObject({status:"partial",partial:true,counts:{a:{input:5,omitted:1}}});
    expect(result.usableLength.value).toBeCloseTo(0.002*degreeM,6);
    expect(trackCoverage(middle,a,{toleranceM:1}).ratio).toBe(0);
    expect(nearestTrackPoint(a,{lat:0,lon:0},1).status).toBe("partial");
  });

  test("comparison limits apply even when sample count is below its limit",()=>{
    const many=normalizeTrack(Array.from({length:1_000},()=>[{lat:0,lon:0},{lat:0,lon:0.001}]));
    expect(trackCoverage(equator(0,0.02),many,{toleranceM:1})).toMatchObject({ratio:null,unknown:["analysis_limit_exceeded"]});
  });

  test("undefined coverage and bounded analysis never fabricate a percentage",()=>{
    expect(trackCoverage(equator(0,0),equator(0,1),{toleranceM:1})).toMatchObject({ratio:null,unknown:["A_has_no_positive_usable_length"]});
    expect(trackCoverage(equator(0,1),normalizeTrack([]),{toleranceM:10,sampleSpacingM:100})).toMatchObject({ratio:null,unknown:["B_has_no_usable_line"]});
    expect(trackCoverage(equator(0,180),equator(0,1),{toleranceM:10,sampleSpacingM:1_000}).unknown).toContain("ambiguous_antipodal_edge");
    expect(trackCoverage(equator(0,1),equator(0,1),{toleranceM:1,sampleSpacingM:0.1})).toMatchObject({ratio:null,unknown:["analysis_limit_exceeded"]});
    for (const spacing of [0,NaN,1_001]) expect(()=>trackCoverage(equator(0,1),equator(0,1),{toleranceM:1,sampleSpacingM:spacing})).toThrow("spacing");
  });
});
