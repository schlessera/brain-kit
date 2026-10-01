import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness.js";

let root: string, server: Server, endpoint: string;
let requests: { path: string; body: string; userAgent: string | undefined }[];
let onRequest: (() => void) | undefined;
const gpx = '<gpx version="1.1"><trk><trkseg>'
  + '<trkpt lat="0" lon="0"><ele>0</ele><time>2026-07-01T08:00:00Z</time></trkpt>'
  + '<trkpt lat="0" lon="0.001"><ele>0</ele><time>2026-07-01T08:01:00Z</time></trkpt>'
  + '<trkpt lat="95" lon="0.003"/>'
  + '<trkpt lat="0" lon="0.004"><ele>0</ele><time>2026-07-01T09:00:00Z</time></trkpt>'
  + '<trkpt lat="0" lon="0.005"><ele>0</ele><time>2026-07-01T09:02:00Z</time></trkpt>'
  + '</trkseg></trk></gpx>';

beforeEach(async () => {
  root = makeTempBrain({ empty: true }); requests = []; onRequest = undefined;
  server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const path = request.url!; requests.push({ path, body, userAgent: request.headers["user-agent"] });
    onRequest?.();
    let value: unknown;
    if (path.startsWith("/reverse")) value = { display_name: "Harbour, Ithaca", lat: "38.36", lon: "20.72", address: { town: "Ithaca" } };
    else if (path.startsWith("/search")) value = [
      { display_name: "Harbour, Ithaca", lat: "38.36", lon: "20.72", address: { town: "Ithaca" } },
      { display_name: "Harbour, Other Island", lat: "38.4", lon: "20.8", address: { town: "Other Island" } },
    ];
    else if (path.startsWith("/route/v1/")) {
      const coordinates = path.split("/driving/")[1]!.split("?")[0]!.split(";").map(point => point.split(",").map(Number));
      value = { code: "Ok", waypoints: coordinates.map(location => ({ location, distance: 0 })),
        routes: [{ geometry: { type: "LineString", coordinates }, distance: 0, duration: 0,
          legs: coordinates.slice(1).map(() => ({ distance: 0, duration: 0 })) }] };
    } else value = { elements: [{ type: "node", id: 42, lat: 0, lon: 0, tags: { name: "Harbour café", amenity: "cafe" } }] };
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ geo: { userAgent: "brain-geo-cli-fixture/1.0", cacheDir: ".brain/geo",
    minimumIntervalMs: 0, geocoding: { enabled: true, url: endpoint }, overpass: { enabled: true, endpoints: [endpoint] },
    routing: { endpoints: { foot: { url: endpoint + "/route/v1", profile: "driving", preparedMode: "foot", dataset: "recorded foot fixture", verification: "local recorded fixture" } } } } }));
  writeFileSync(join(root, "walk.gpx"), gpx);
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); cleanup(root); });

describe("actual brain geo command contracts", () => {
  test("forward geocoding emits one nonempty qualified JSON document and shares the disk cache across commands", async () => {
    const first = await runCli(root, ["geo", "geocode", "Harbour", "--json"]);
    // Failing-first assertion observes the real command envelope before any JSON parsing or request assertion.
    expect(first.stdout).toContain('"operation": "geocode"');
    expect(first.code).toBe(0); const result = JSON.parse(first.stdout);
    expect(result.value).toHaveLength(2); expect(result.status).toBe("ambiguous");
    expect(result.request).toEqual({ query: "Harbour" });
    expect(result.value[0].accuracyM).toBeNull(); expect(result.source.transfer.sent).toBe(true);
    const cached = await runCli(root, ["geo", "geocode", "Harbour"]);
    expect(JSON.parse(cached.stdout).source.fromCache).toBe(true); expect(requests).toHaveLength(1);
    expect(requests[0]!.userAgent).toBe("brain-geo-cli-fixture/1.0");
    expect(existsSync(join(root, "brain.db"))).toBe(false);
  });

  test("reverse geocoding retains explicit coordinates, unknown accuracy and actual coordinate transfer", async () => {
    const response = await runCli(root, ["geo", "geocode", "--reverse", "38.36,20.72", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.operation).toBe("reverse"); expect(result.request).toEqual({ lat: 38.36, lon: 20.72 });
    expect(result.value).toHaveLength(1); expect(result.value[0].point).toEqual({ lat: 38.36, lon: 20.72 });
    expect(result.source.transfer).toEqual({ data: "coordinates", sent: true });
    expect(requests[0]!.path).toContain("lat=38.36");
  });

  test("routing preserves all requested legs, declared foot dataset, source and actual zero estimates", async () => {
    const response = await runCli(root, ["geo", "route", "0,0", "0,0.001", "0,0.002", "--mode", "foot", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.operation).toBe("route"); expect(result.request.mode).toBe("foot");
    expect(result.value.geometry[0]).toHaveLength(3); expect(result.value.legs).toHaveLength(2);
    expect(result.value.legs[1].distanceM).toBe(0); expect(result.value.measurements.duration).toEqual({ value: 0, unit: "s" });
    expect(result.source.dataset.preparedMode).toBe("foot"); expect(result.source.fallback.used).toBe(false);
    expect(requests).toHaveLength(1); expect(requests[0]!.path).toContain("/driving/0,0;0.001,0;0.002,0");
  });

  test("near POIs use repeatable exact tags, preserve mapped-hours unknowns and cache the same query", async () => {
    const args = ["geo", "poi", "--near", "0,0", "--radius-m", "100", "--tag", "amenity=cafe", "--tag", "name", "--json"];
    const response = await runCli(root, args); expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.operation).toBe("poi"); expect(result.value).toHaveLength(1);
    expect(result.query.tags).toEqual({ amenity: "cafe", name: true });
    expect(result.value[0].openingHours).toEqual({ value: null, interpreted: false });
    expect(JSON.parse((await runCli(root, args)).stdout).source.fromCache).toBe(true); expect(requests).toHaveLength(1);
    const query = new URLSearchParams(requests[0]!.body).get("data")!;
    expect(query).toContain('["amenity"="cafe"]["name"]');
  });

  test("along-track POIs preserve recovered counts and separate query sections without changing the source", async () => {
    const response = await runCli(root, ["geo", "poi", "--along", "walk.gpx", "--radius-m", "50", "--tag", "amenity=cafe", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.value).toHaveLength(1); expect(result.track.partial).toBe(true);
    expect(result.track.counts).toEqual({ input: 5, retained: 4, omitted: 1, segments: 2 });
    expect(result.query.sections).toBe(2);
    const query = new URLSearchParams(requests[0]!.body).get("data")!;
    expect(query.match(/around:/g)).toHaveLength(2);
    expect(readFileSync(join(root, "walk.gpx"), "utf8")).toBe(gpx);
  });

  test("track JSON exposes usable-section measurements, exact omissions, nearest interiors and directional comparison", async () => {
    const response = await runCli(root, ["geo", "track", "walk.gpx", "--near", "0,0.0005", "--compare", "walk.gpx", "--tolerance-m", "5", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.operation).toBe("track"); expect(result.status).toBe("partial");
    expect(result.source).toEqual({ kind: "file", path: "walk.gpx" }); expect(result.geometry).toHaveLength(2);
    expect(result.counts).toEqual({ input: 5, retained: 4, omitted: 1, segments: 2 });
    expect(result.omissions).toHaveLength(1); expect(result.omissions[0].index).toBe(2);
    expect(result.measurements.distance.value).toBeGreaterThan(200); expect(result.measurements.distance.value).toBeLessThan(230);
    expect(result.measurements.elapsed).toEqual({ value: 180, unit: "s", scope: "usable_sections" });
    expect(result.measurements.ascent.value).toBe(0); expect(result.measurements.descent.value).toBe(0);
    expect(result.measurements.movingTime.value).toBeNull();
    expect(result.nearest.distance.value).toBeLessThan(0.001); expect(result.nearest.location.fraction).toBeCloseTo(0.5);
    expect(result.comparison.coverage.direction).toBe("A_relative_to_B"); expect(result.comparison.coverage.ratio).toBeGreaterThanOrEqual(0.99);
    expect(readFileSync(join(root, "walk.gpx"), "utf8")).toBe(gpx); expect(requests).toHaveLength(0);
  });

  test("map writes a real local PNG, qualified JSON and every stop without serializing image bytes", async () => {
    const response = await runCli(root, ["geo", "map", "walk.gpx", "--pin", "0,0,Departure, harbour", "--pin", "0,0.005,Viewpoint", "--width", "320", "--no-background", "--out", "walk.png", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.operation).toBe("map"); expect(result.kind).toBe("track_only"); expect(result.status).toBe("partial");
    expect(result.tracks[0].summary.counts).toEqual({ input: 5, retained: 4, omitted: 1, segments: 2 });
    expect(result.pins).toHaveLength(2); expect(result.text).toContain("Stop 1: Departure, harbour");
    expect(result.artifact).toMatchObject({ path: "walk.png", format: "png" });
    const png = readFileSync(join(root, "walk.png")); expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(320); expect(result.artifact.bytes).toBe(png.byteLength);
    expect(result.png).toBeUndefined(); expect(result.svg).toBeUndefined(); expect(result.attribution).toEqual([]);
    expect(readFileSync(join(root, "walk.gpx"), "utf8")).toBe(gpx); expect(requests).toHaveLength(0);
  });

  test("map resolves requested routing before rasterization and retains every missing leg and cropped stop", async () => {
    writeFileSync(join(root, "brain.config.json"), "{}");
    const response = await runCli(root, ["geo", "map", "--point", "0,0", "--point", "0,0.001", "--point", "0,0.3", "--mode", "foot",
      "--bbox", "-0.001,-0.001,0.002,0.001", "--no-background", "--out", "missing.png", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.legs).toHaveLength(2); expect(result.pins).toHaveLength(3);
    expect(result.legs.every((leg: { available: boolean }) => !leg.available)).toBe(true);
    expect(result.pins[2].drawn).toBe(false); expect(result.text).toContain("Route 1 leg 2");
    expect(result.artifact.bytes).toBeGreaterThan(1000); expect(requests).toHaveLength(0);
  });

  test("map resolves actual routing once and renders the calculated geometry and zero estimates", async () => {
    const response = await runCli(root, ["geo", "map", "--point", "0,0", "--point", "0,0.001", "--mode", "foot",
      "--no-background", "--out", "calculated.png", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.routes[0].value.geometry[0]).toHaveLength(2); expect(result.legs).toHaveLength(1);
    expect(result.legs[0]).toMatchObject({ available: true, distanceM: 0, durationS: 0 });
    expect(result.text).toContain("dataset recorded foot fixture"); expect(result.text).toContain("calculated geometry available");
    expect(result.attribution).toHaveLength(1); expect(result.artifact.bytes).toBeGreaterThan(1000);
    expect(requests).toHaveLength(1);
  });

  test("a directory changed by the real service response is rechecked before writing the map", async () => {
    const outside = makeTempBrain({ empty: true }); mkdirSync(join(root, "assets"));
    try {
      onRequest = () => { rmSync(join(root, "assets"), { recursive: true }); symlinkSync(outside, join(root, "assets")); };
      const response = await runCli(root, ["geo", "map", "--point", "0,0", "--point", "0,0.001", "--mode", "foot",
        "--no-background", "--out", "assets/race.png", "--json"]);
      expect(existsSync(join(outside, "race.png"))).toBe(false);
      expect(response.code).toBe(1); expect(response.stderr).toContain("no longer remains inside");
      expect(requests).toHaveLength(1); expect(existsSync(join(outside, "race.png"))).toBe(false);
    } finally { cleanup(outside); }
  });

  test("a symlinked brain root retains relative file and artifact paths", async () => {
    const aliases = makeTempBrain({ empty: true }); symlinkSync(root, join(aliases, "brain"));
    try {
      const alias = join(aliases, "brain");
      const track = await runCli(alias, ["geo", "track", "walk.gpx", "--json"]);
      expect(track.code).toBe(0); expect(JSON.parse(track.stdout).source.path).toBe("walk.gpx");
      const map = await runCli(alias, ["geo", "map", "walk.gpx", "--no-background", "--out", "alias.png", "--json"]);
      expect(map.code).toBe(0); expect(JSON.parse(map.stdout).artifact.path).toBe("alias.png");
      expect(readFileSync(join(root, "alias.png")).byteLength).toBeGreaterThan(1000);
    } finally { cleanup(aliases); }
  });

  test("disabled services and typed invalid route requests remain one JSON document with the documented exit status", async () => {
    writeFileSync(join(root, "brain.config.json"), "{}");
    const disabled = await runCli(root, ["geo", "geocode", "Harbour", "--json"]);
    expect(disabled.code).toBe(2); expect(JSON.parse(disabled.stdout)).toMatchObject({ operation: "geocode", status: "disabled", value: null });
    const invalid = await runCli(root, ["geo", "route", "0,0", "--mode", "foot", "--json"]);
    expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stdout)).toMatchObject({ operation: "route", error: { code: "input" }, value: null });
    expect(requests).toHaveLength(0);
  });

  test("polar track map returns full text/source with a null artifact and leaves the output path absent", async () => {
    const polar = '<gpx version="1.1"><trk><trkseg><trkpt lat="90" lon="0"/><trkpt lat="89" lon="1"/></trkseg></trk></gpx>';
    writeFileSync(join(root, "polar.gpx"), polar);
    const response = await runCli(root, ["geo", "map", "polar.gpx", "--out", "polar.png", "--json"]);
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.kind).toBe("none"); expect(result.reason).toBe("unsupported_projection"); expect(result.artifact).toBeNull();
    expect(result.tracks[0].summary.geometry[0][0].lat).toBe(90); expect(result.text).toContain("polar.gpx");
    expect(existsSync(join(root, "polar.png"))).toBe(false); expect(requests).toHaveLength(0);
    expect(readFileSync(join(root, "polar.gpx"), "utf8")).toBe(polar);
  });

  test("human output retains unknowns, partial source and qualifications", async () => {
    const response = await runCli(root, ["geo", "track", "walk.gpx", "--human"]);
    expect(response.code).toBe(0); expect(response.stdout).toContain("walk.gpx"); expect(response.stdout).toContain("partial");
    expect(response.stdout).toContain("Moving time: unknown"); expect(response.stdout).toContain("usable sections");
    expect(response.stdout).toContain("does not prove travel"); expect(response.stdout).not.toStartWith("{");
  });

  test("a large real track response finishes its single JSON document before the process exits", async () => {
    writeFileSync(join(root, "large.gpx"), `<gpx version="1.1"><trk><trkseg>${'<trkpt lat="0" lon="0"/>'.repeat(5000)}</trkseg></trk></gpx>`);
    const response = await runCli(root, ["geo", "track", "large.gpx", "--json"]);
    expect(response.stdout.trimEnd().slice(-60)).toEndWith('  "comparison": null\n}');
    expect(response.code).toBe(0); const result = JSON.parse(response.stdout);
    expect(result.geometry[0]).toHaveLength(5000); expect(result.counts.retained).toBe(5000);
  });

  test("invalid coordinates, mixed query forms and irrelevant options are usage failures without service traffic", async () => {
    for (const args of [["geocode", "--reverse", "91,0"], ["geocode", "Harbour", "--reverse", "0,0"],
      ["route", "0,0", "0,1"], ["route", "0,0", "0,1", "--mode", "foot", "--near", "0,0"],
      ["poi", "--near", "0,0", "--along", "walk.gpx", "--radius-m", "10", "--tag", "amenity=cafe"],
      ["track", "walk.gpx", "--near", "0,0"], ["map", "walk.gpx"], ["map", "walk.gpx", "--out", "../escape.png"]]) {
      const response = await runCli(root, ["geo", ...args, "--json"]);
      expect(response.code).toBe(1); expect(response.stdout).toBe("");
    }
    expect(requests).toHaveLength(0);
  });

  test("missing explicit routing mode sends no native request", async () => {
    const response = await runCli(root, ["geo", "route", "0,0", "0,0.001", "--json"]);
    expect(requests).toHaveLength(0); expect(response.code).toBe(1); expect(response.stdout).toBe("");
  });

  test("a symlinked source/output cannot leave the brain and no-config map cannot write", async () => {
    const outside = makeTempBrain({ empty: true });
    try {
      writeFileSync(join(outside, "original.gpx"), gpx); symlinkSync(outside, join(root, "outside"));
      for (const args of [["track", "outside/original.gpx"], ["map", "walk.gpx", "--out", "outside/out.png"]]) {
        const response = await runCli(root, ["geo", ...args, "--json"]); expect(response.code).toBe(1);
      }
      expect(existsSync(join(outside, "out.png"))).toBe(false);
      for (const args of [["geo", "map", "original.gpx", "--no-background", "--out", "out.png", "--json"],
        ["geo", "--json", "map", "original.gpx", "--no-background", "--out", "out.png"],
        ["geo", "--json", "--out", "out.png", "--no-background", "--", "map", "original.gpx"]]) {
        const response = await runCli(outside, args);
        expect(existsSync(join(outside, "out.png"))).toBe(false);
        expect(response.code).toBe(1); expect(response.stderr).toContain("uninitialized"); expect(existsSync(join(outside, "out.png"))).toBe(false);
      }
    } finally { cleanup(outside); }
  });
});
