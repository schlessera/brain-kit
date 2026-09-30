import { describe, expect, test } from "bun:test";
import { parseTravelDocument } from "../src/content.js";

function trip(fields: string): string {
  return `---\ntype: trip\ntitle: Ithaca headland\ntrip_status: done\n${fields}\n---\nOdysseus returns to the same headland.\n`;
}

describe("canonical travel content", () => {
  test("preserves legacy journeys and unknown visit dates without inventing coordinates", () => {
    const legacy = parseTravelDocument("---\ntype: travel\ntitle: Homecoming\nstatus: active\n---\n[[travel/ithaca/itinerary]]\n");
    expect(legacy.type).toBe("travel");
    const document = parseTravelDocument(trip("visits:\n  - id: homecoming\n    date: null\n    party: [Odysseus, Penelope]"));
    if (document.type !== "trip") throw new Error("Expected a parsed trip");
    expect(document.visits).toHaveLength(1);
    expect(document.visits![0]!.date).toBeNull();
    expect(document).not.toHaveProperty("coordinates");
  });

  test("rejects duplicate visit identities while allowing two visits on an unknown date", () => {
    const repeated = "visits:\n  - id: first\n    date: null\n  - id: first\n    date: null";
    expect(() => parseTravelDocument(trip(repeated))).toThrow(/duplicate.*visit/i);
    const distinct = parseTravelDocument(trip(repeated.replace(/id: first(?=\n    date: null$)/, "id: second")));
    expect(distinct.visits).toHaveLength(2);
  });

  test("requires exactly one primary route when routes are recorded", () => {
    const source = trip("visits: [{id: homecoming}]\nroutes:\n  - {label: north, source: own plan, kind: planned}\n  - {label: south, source: own recording, kind: recorded}");
    expect(() => parseTravelDocument(source)).toThrow(/primary/i);
    expect(() => parseTravelDocument(source.replace("kind: planned", "kind: planned, primary: true"))).not.toThrow();
    expect(() => parseTravelDocument(source.replaceAll("kind: planned", "kind: planned, primary: true")
      .replace("kind: recorded", "kind: recorded, primary: true"))).toThrow(/primary/i);
  });

  test("rejects a done trip without a visit and an invalid trip status", () => {
    expect(() => parseTravelDocument(trip("visits: []"))).toThrow(/visit/i);
    expect(() => parseTravelDocument(trip("visits: [{id: homecoming}]").replace("trip_status: done", "trip_status: booked"))).toThrow();
  });

  test("accepts unknown coordinates and the real origin but rejects invalid ranges", () => {
    const source = "---\ntype: place\ntitle: Ithaca\nplace_kind: spot\ncoordinates: null\n---\n";
    expect(parseTravelDocument(source).coordinates).toBeNull();
    expect(parseTravelDocument(source.replace("coordinates: null", "coordinates: {lat: 0, lon: 0}")).coordinates)
      .toEqual({ lat: 0, lon: 0 });
    expect(() => parseTravelDocument(source.replace("coordinates: null", "coordinates: {lat: 91, lon: 0}"))).toThrow();
  });

  test("normalizes real YAML dates while rejecting nonexistent calendar days", () => {
    const source = trip("visits: [{id: homecoming, date: 2024-02-29}]");
    const data = parseTravelDocument(source);
    if (data.type !== "trip") throw new Error("Expected a parsed trip");
    expect(data.visits![0]!.date).toBe("2024-02-29");
    expect(() => parseTravelDocument(source.replace("2024-02-29", '"2026-02-30"'))).toThrow(/calendar/i);
    expect(() => parseTravelDocument(source.replace("2024-02-29", "2026-02-30"))).toThrow(/calendar/i);
  });
});
