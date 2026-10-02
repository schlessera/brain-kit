import { describe, expect, test } from "bun:test";
import { parseTrackGpx, summarizeTrack } from "../src/track.js";
const gpx = (sections: string[]) => `<gpx version="1.1"><trk>${sections.map(s=>`<trkseg>${s}</trkseg>`).join("")}</trk></gpx>`;
const pt = (lon: number, elevation: number | null, time: string | null) => `<trkpt lat="0" lon="${lon}">${elevation === null ? "" : `<ele>${elevation}</ele>`}${time === null ? "" : `<time>2026-07-12T${time}Z</time>`}</trkpt>`;
const source = { kind: "file" as const, path: "routes/ithaca.gpx" };

describe("shared track summaries", () => {
  test("elapsed retains pauses inside sections and excludes original gaps", () => {
    const track = parseTrackGpx(gpx([pt(0,0,"00:00:00")+pt(0,0,"00:10:00")+pt(0.001,10,"00:11:00"),
      pt(1,1000,"02:00:00")+pt(1.001,1010,"02:01:00")]));
    const summary = summarizeTrack(track, source);
    expect(summary.measurements.elapsed).toEqual({value:720,unit:"s",scope:"usable_sections"});
    expect(summary.measurements.movingTime.value).toBeNull();
    expect(summary.unknown).toContainEqual({field:"movingTime",reason:"estimator_not_in_scope"});
    expect(summary.source).toEqual(source);
    expect(summary.measurements.distance.value).toBeCloseTo(222.39,2);
  });

  test("distance measures each continuous section without connecting the gap", () => {
    const result=summarizeTrack(parseTrackGpx(gpx([pt(0,0,null)+pt(0.001,0,null),pt(1,0,null)+pt(1.001,0,null)])),source);
    expect(result.measurements.distance.value).toBeCloseTo(222.39,2);
  });

  test("ascent and descent share the median and hysteresis baseline", () => {
    const track = parseTrackGpx(gpx([[0,10,0,20,20,10,0].map((e,i)=>pt(i/1000,e,null)).join("")]));
    const summary = summarizeTrack(track, source);
    expect(summary.measurements.ascent.value).toBe(20);
    expect(summary.measurements.descent.value).toBe(20);
    expect(summary.measurements.altitudeMin.value).toBe(0);
    expect(summary.measurements.altitudeMax.value).toBe(20);
  });

  test("recovered measurements stay scoped to usable sections without crossing the omission", () => {
    const track = parseTrackGpx(gpx([pt(0,10,"00:00:00")+pt(0.001,20,"00:01:00")
      +'<trkpt lat="91" lon="0"/>'+pt(1,1000,"02:00:00")+pt(1.001,990,"02:01:00")]));
    const original = structuredClone(track);
    const summary = summarizeTrack(track,source);
    expect(summary).toMatchObject({status:"partial",partial:true,counts:{input:5,retained:4,omitted:1,segments:2}});
    expect(summary.measurements.ascent.value).toBe(10);
    expect(summary.measurements.descent.value).toBe(10);
    expect(summary.measurements.elapsed.value).toBe(120);
    summary.geometry[0]![0]!.lon=42;
    expect(track).toEqual(original);
  });

  test("known zeros remain distinct from missing and decreasing optional metadata", () => {
    const zero=summarizeTrack(parseTrackGpx(gpx([pt(0,0,"00:00:00")+pt(0,0,"00:00:00")])),source);
    expect(Object.values(zero.measurements).filter(m=>m.unit==="m").map(m=>m.value)).toEqual([0,0,0,0,0]);
    expect(zero.measurements.elapsed.value).toBe(0);
    expect(zero.unknown).toEqual([{field:"movingTime",reason:"estimator_not_in_scope"}]);
    for(const [time,reason] of [[null,"timestamp_missing_or_invalid"],["00:00:00","timestamps_decrease"]] as const){
      const result=summarizeTrack(parseTrackGpx(gpx([pt(0,null,"00:01:00")+pt(0.001,0,time)])),source);
      expect(result.measurements.elapsed.value).toBeNull();
      expect(result.unknown).toContainEqual({field:"elapsed",reason});
      expect(result.measurements.ascent.value).toBeNull();
      expect(result.measurements.descent.value).toBeNull();
    }
  });

  test("empty geometry carries reasons for every absent spatial value", () => {
    const result=summarizeTrack(parseTrackGpx(gpx(['<trkpt lat="91" lon="0"/>'])),source);
    expect(result.bounds).toBeNull();
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
    for(const field of ["bounds","start","end"]) expect(result.unknown).toContainEqual({field,reason:"no_valid_points"});
    expect(result.unknown).toContainEqual({field:"shape",reason:"no_usable_line"});
  });

  test("no-line evidence does not report zero distance as a successful empty track", () => {
    const result=summarizeTrack(parseTrackGpx(gpx([pt(0,10,null)])),source);
    expect(result.measurements.distance.value).toBeNull();
    expect(result.unknown).toContainEqual({field:"distance",reason:"no_usable_line"});
    expect(result.start).toMatchObject({lat:0,lon:0});
    expect(result.geometry).toHaveLength(1);
    expect(result.status).toBe("no_line");
  });
});
