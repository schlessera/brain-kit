import { describe, expect, test } from "bun:test";
import { normalizeTrack, parseTrackGpx, summarizeTrack } from "../src/track.js";

describe("normalized track adapters", () => {
  test("normalization shares GPX recovery, counts, omissions and unsimplified measurements", () => {
    const input = [[{lat:0,lon:0},{lat:0,lon:0.001},{lat:91,lon:0},
      {lat:0,lon:1},{lat:0,lon:1.001}], [{lat:90,lon:180},{lat:90,lon:180}]];
    const original = structuredClone(input);
    const fromXml = parseTrackGpx(`<gpx version="1.1"><trk>${input.map(s =>
      `<trkseg>${s.map(p=>`<trkpt lat="${p.lat}" lon="${p.lon}"/>`).join("")}</trkseg>`).join("")}</trk></gpx>`);
    const track = normalizeTrack(input);
    expect(track).toEqual(fromXml);
    expect(track.counts).toEqual({input:7,retained:6,omitted:1,segments:3});
    expect(summarizeTrack(track,{kind:"file",path:"route.json"}).measurements.distance.value).toBeCloseTo(222.39,2);
    track.segments[0]![0]!.lat = 42;
    expect(input).toEqual(original);
  });

  test("invalid numbers and missing coordinates report all reasons and preserve every gap", () => {
    const track=normalizeTrack([[{lat:0,lon:0},{lat:NaN,lon:Infinity},
      {lat:1,lon:1},{lat:undefined,lon:181},{lat:2,lon:2},{lat:2,lon:2}]]);
    expect(track.segments.map(s=>s.map(p=>p.lon))).toEqual([[0],[1],[2,2]]);
    expect(track.omissions).toEqual([
      {index:1,reason:"latitude_missing_or_invalid",reasons:["latitude_missing_or_invalid","longitude_missing_or_invalid"]},
      {index:3,reason:"latitude_missing_or_invalid",reasons:["latitude_missing_or_invalid","longitude_out_of_range"]},
    ]);
    expect(track.status).toBe("partial");
    expect(normalizeTrack([[{lat:"0",lon:0}]]).status).toBe("no_line");
  });

  test("metadata is optional and unknown while a genuine zero remains valid", () => {
    const track=normalizeTrack([[{lat:0,lon:0,elevation_m:0,time:"2026-07-12T12:00:00+02:00"},
      {lat:0,lon:0,elevation_m:"0",time:"yesterday"}]],"route");
    expect(track.segments[0]).toEqual([{lat:0,lon:0,elevation_m:0,time:"2026-07-12T10:00:00.000Z"},
      {lat:0,lon:0,elevation_m:null,time:null}]);
    expect(track.warnings).toHaveLength(2);
    expect(track.kind).toBe("route");
  });

  test("resource limits count omitted points", () => {
    expect(()=>normalizeTrack([Array.from({length:200_001},()=>({lat:91,lon:0}))])).toThrow("200,000");
  });

  test("empty-section resource limits and malformed structures reject", () => {
    expect(()=>normalizeTrack(Array.from({length:200_001},()=>[]))).toThrow("sections");
    for (const input of [null, [null], [[null]], [[[]]]]) {
      expect(()=>normalizeTrack(input as never)).toThrow();
    }
    expect(normalizeTrack([])).toMatchObject({status:"no_line",counts:{input:0,retained:0,omitted:0,segments:0}});
  });
});
