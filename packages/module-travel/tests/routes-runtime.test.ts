import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import { parseGpx, routeMetrics } from "../src/route-gpx.js";

const fixture = readFileSync(join(import.meta.dir, "fixtures/routes/odysseus.gpx"), "utf8");
const roots: string[] = [];
function brain(): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "@schlessera/brain-module-travel": {} } }));
  mkdirSync(join(root, "recordings"));
  writeFileSync(join(root, "recordings/odysseus.gpx"), fixture);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

type Reply = { status?: number; body?: string; location?: string };
async function replayCli(root: string, source: string, replies: Record<string, Reply>, privateHosts: string[] = []) {
  const log = join(root, "requests.jsonl"), replay = join(root, "replay.json");
  writeFileSync(log, "");
  writeFileSync(replay, JSON.stringify({ replies, privateHosts, log }));
  // The test runner prepends its network guard; this second preload replaces
  // only fetch and DNS with closed replay transports in the real CLI child.
  const proc = Bun.spawn(["bun", "--preload", join(import.meta.dir, "route-http-replay.ts"), BRAIN_BIN,
    "travel", "route", source, "--to", "routes", "--json"], {
    env: { ...keylessEnv(root), ROUTE_REPLAY: replay }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const requests: { url: string; method: string; headers: Record<string, string> }[] = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
  return { stdout, stderr, code, requests };
}
const publicGpx = "https://routes.example/odysseus.gpx";
const robots = (origin: string, body = "User-agent: *\nAllow: /\n") => ({ [`${origin}/robots.txt`]: { body } });
function komootHtml(id: string, status = "public", lat = 0): string {
  // Schema observed on public tour and smarttour pages; every value is invented.
  const state = { page: { _embedded: { tour: { id, status, distance: 999999, duration: 999999,
    _embedded: { coordinates: { items: [{ lat, lng: 0, alt: 100, t: 0 }, { lat: 0, lng: 0.001, alt: 110, t: 999999 }] } } } } } };
  return `<script>throw new Error("must never execute"); kmtBoot.setProps(${JSON.stringify(JSON.stringify(state))});</script>`;
}

describe("real route CLI", () => {
  test("route accepts --human and imports a nonempty recording with human metrics", async () => {
    const root = brain();
    expect(parseGpx(fixture).segments[0]).toHaveLength(4);
    const result = await runCli(root, ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", "--human"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("routes/odysseus.gpx: 0.333585 km, ascent 20 m, one_way.\n");
    expect(result.stderr).not.toContain("brain travel —");
    const written = parseGpx(readFileSync(join(root, "routes/odysseus.gpx"), "utf8"));
    expect(written.segments[0]).toHaveLength(4);
    expect(readFileSync(join(root, "recordings/odysseus.gpx"), "utf8")).toBe(fixture);
  });

  test("imports a local recording and reports metrics of the written GPX", async () => {
    const root = brain();
    const result = await runCli(root, ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", "--json"]);
    expect(result.code).toBe(0);
    const { route } = JSON.parse(result.stdout);
    expect(route.source_kind).toBe("local_gpx");
    expect(route.gpx).toBe("routes/odysseus.gpx");
    expect(route.distance_km).toBeCloseTo(0.333585, 6);
    expect(route.ascent_m).toBe(20);
    expect(route.altitude_min_m).toBe(100);
    expect(route.altitude_max_m).toBe(120);
    expect(route.recorded_duration_s).toBe(180);
    expect(route.shape).toBe("one_way");
    expect(route.points).toBe(4);
    expect(readFileSync(join(root, route.gpx), "utf8")).toContain("<trkpt");
    expect(readFileSync(join(root, "recordings/odysseus.gpx"), "utf8")).toBe(fixture);
  });

  test("trims both ends without keeping original coordinates in metadata", async () => {
    const root = brain();
    const result = await runCli(root, ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", "--trim-start-m", "100", "--trim-end-m", "100", "--json"]);
    expect(result.code).toBe(0);
    const { route } = JSON.parse(result.stdout);
    const written = readFileSync(join(root, route.gpx), "utf8");
    expect(route.distance_km).toBeCloseTo(0.133585, 6);
    expect(written).not.toContain('lon="0"');
    expect(written).not.toContain('lon="0.003"');
    expect(written).not.toContain("<wpt");
    expect(written).not.toContain("<extensions");
    expect(written).not.toContain("Departure to be trimmed");
    expect(route.recorded_duration_s).toBeCloseTo(72.081556, 2);
    expect(route.altitude_min_m).toBeGreaterThan(100);
    expect(route.altitude_max_m).toBeLessThan(120);
    expect(readFileSync(join(root, "recordings/odysseus.gpx"), "utf8")).toBe(fixture);
  });

  test("direct GPX and both public Komoot page kinds run through HTTP, robots and the actual CLI", async () => {
    for (const [source, body, kind] of [[publicGpx, fixture, "gpx_url"],
      ["https://www.komoot.com/tour/42?share_token=fixture", komootHtml("42"), "komoot_tour"],
      ["https://www.komoot.com/smarttour/e42", komootHtml("e42"), "komoot_smarttour"]]) {
      const root = brain(), url = new URL(source!); url.search = "";
      const result = await replayCli(root, source!, { ...robots(url.origin), [url.href]: { body } });
      expect(result.code).toBe(0);
      expect(result.requests.map((r) => r.url)).toEqual([`${url.origin}/robots.txt`, url.href]);
      expect(result.requests.every((r) => r.method === "GET" && r.headers["user-agent"]?.includes("brain-scrape"))).toBe(true);
      expect(result.requests.some((r) => r.headers.cookie || r.headers.authorization)).toBe(false);
      const { route } = JSON.parse(result.stdout);
      const saved = parseGpx(readFileSync(join(root, route.gpx), "utf8"));
      expect(saved.segments[0]!.length).toBeGreaterThan(1);
      expect(route).toMatchObject({ source_kind: kind, ...routeMetrics(saved.segments) });
      if (kind !== "gpx_url") expect(route).toMatchObject({ recorded_duration_s: null, distance_km: 0.111195, ascent_m: 10 });
    }
  });

  test("private, deleted and malformed sources refuse without writing an output", async () => {
    for (const reply of [{ status: 401 }, { status: 403 }, { status: 404 }, { body: fixture.replace("</trkseg>", "") }]) {
      const root = brain(), result = await replayCli(root, publicGpx, { ...robots("https://routes.example"), [publicGpx]: reply });
      expect(result.requests).toHaveLength(2);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(existsSync(join(root, "routes"))).toBe(false);
    }
    for (const body of [komootHtml("42", "private"), komootHtml("43"), "<html>login</html>", '<script>kmtBoot.setProps("malformed");</script>']) {
      const root = brain(), url = "https://www.komoot.com/tour/42";
      const result = await replayCli(root, url, { ...robots("https://www.komoot.com"), [url]: { body } });
      expect(result.requests).toHaveLength(2);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/private|matching|Malformed/);
      expect(existsSync(join(root, "routes"))).toBe(false);
    }
  });

  test("invalid nonempty Komoot coordinates fail at the parser rather than exporting them", async () => {
    const root = brain(), url = "https://www.komoot.com/tour/42", body = komootHtml("42", "public", 91);
    expect(body).toContain('\\"lat\\":91');
    const result = await replayCli(root, url, { ...robots("https://www.komoot.com"), [url]: { body } });
    expect(result.requests).toHaveLength(2);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("coordinates");
    expect(existsSync(join(root, "routes"))).toBe(false);
  });

  test("unknown optional GPX data remains unknown through the writer and CLI envelope", async () => {
    const root = brain();
    writeFileSync(join(root, "recordings/odysseus.gpx"), fixture.replace("<ele>110</ele>", "<ele>NaN</ele>").replace("<time>2026-07-15T00:01:00Z</time>", ""));
    const result = await runCli(root, ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", "--json"]);
    expect(result.code).toBe(0);
    const { route } = JSON.parse(result.stdout), saved = parseGpx(readFileSync(join(root, route.gpx), "utf8"));
    expect(saved.segments[0]).toHaveLength(4);
    expect(route).toMatchObject({ ascent_m: null, altitude_min_m: null, altitude_max_m: null, recorded_duration_s: null });
    expect(saved.segments[0]![1]).toMatchObject({ elevation_m: null, time: null });
    expect(route.warnings.length).toBeGreaterThan(0);
  });

  test("oversized HTTP input refuses before it can create a route", async () => {
    const root = brain(), result = await replayCli(root, publicGpx,
      { ...robots("https://routes.example"), [publicGpx]: { body: " ".repeat(20 * 1024 * 1024 + 1) } });
    expect(result.requests).toHaveLength(2);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("size limit");
    expect(existsSync(join(root, "routes"))).toBe(false);
  });

  test("robots disallow stops before dispatch, including a redirected destination", async () => {
    const root = brain(), denied = "https://denied.example/route.gpx";
    const result = await replayCli(root, publicGpx, { ...robots("https://routes.example"), [publicGpx]: { status: 302, location: denied },
      ...robots("https://denied.example", "User-agent: *\nDisallow: /\n"), [denied]: { body: fixture } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("robots.txt disallows");
    expect(result.requests.map((r) => r.url)).toEqual(["https://routes.example/robots.txt", publicGpx, "https://denied.example/robots.txt"]);
    const initial = await replayCli(brain(), publicGpx, { ...robots("https://routes.example", "User-agent: *\nDisallow: /\n"), [publicGpx]: { body: fixture } });
    expect(initial.code).toBe(1);
    expect(initial.requests.map((r) => r.url)).toEqual(["https://routes.example/robots.txt"]);
  });

  test("invalid URLs and private addresses refuse before fetch, including redirect hops", async () => {
    for (const source of ["ftp://routes.example/file.gpx", "https://user:secret@routes.example/a.gpx", "https://localhost/a.gpx",
      "http://2130706433/a.gpx", "http://[::1]/a.gpx", "https://private.example/a.gpx"]) {
      const result = await replayCli(brain(), source, {}, ["private.example"]);
      expect(result.code).toBe(1);
      expect(result.requests).toHaveLength(0);
      expect(result.stderr).toMatch(/HTTP|credentials|public/);
    }
    for (const target of ["https://private.example/a.gpx", "ftp://routes.example/a.gpx", "https://user:secret@routes.example/a.gpx"]) {
      const result = await replayCli(brain(), publicGpx, { ...robots("https://routes.example"), [publicGpx]: { status: 302, location: target } }, ["private.example"]);
      expect(result.code).toBe(1);
      expect(result.requests.map((r) => r.url)).toEqual(["https://routes.example/robots.txt", publicGpx]);
    }
  });

  test("Outdooractive gives its permission action without attempting the disallowed API", async () => {
    const result = await replayCli(brain(), "https://www.outdooractive.com/en/route/fixture/42/", {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("written site permission");
    expect(result.requests).toHaveLength(0);
  });

  test("repeated imports preserve existing files and the original recording", async () => {
    const root = brain(); mkdirSync(join(root, "routes"));
    writeFileSync(join(root, "routes/odysseus.gpx"), "existing file");
    const args = ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", "--json"];
    const first = await runCli(root, args), second = await runCli(root, args);
    expect(first.code).toBe(0); expect(second.code).toBe(0);
    expect(JSON.parse(first.stdout).route.gpx).toBe("routes/odysseus-2.gpx");
    expect(JSON.parse(second.stdout).route.gpx).toBe("routes/odysseus-3.gpx");
    expect(readFileSync(join(root, "routes/odysseus.gpx"), "utf8")).toBe("existing file");
    expect(readFileSync(join(root, "recordings/odysseus.gpx"), "utf8")).toBe(fixture);
    expect(readFileSync(join(root, "routes/odysseus-2.gpx"), "utf8")).toBe(readFileSync(join(root, "routes/odysseus-3.gpx"), "utf8"));
  });

  test("input and output containment covers traversal, outside symlinks and a symlinked root", async () => {
    const root = brain(), outside = brain();
    symlinkSync(join(outside, "recordings/odysseus.gpx"), join(root, "outside.gpx"));
    symlinkSync(outside, join(root, "outside-dir"));
    for (const [input, output] of [["../outside.gpx", "routes"], ["outside.gpx", "routes"],
      ["recordings/odysseus.gpx", "../outside"], ["recordings/odysseus.gpx", "outside-dir/routes"]]) {
      const result = await runCli(root, ["travel", "route", input!, "--to", output!, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("escapes the brain root");
    }
    const parent = brain(); symlinkSync(root, join(parent, "linked"));
    const result = await runCli(join(parent, "linked"), ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).route.gpx).toBe("routes/odysseus.gpx");
    expect(existsSync(join(outside, "routes"))).toBe(false);
  });

  test("invalid flags, over-trimming and missing inputs refuse without changing recordings", async () => {
    const root = brain();
    for (const extras of [["--trim-start-m", "-1"], ["--trim-end-m", "Infinity"], ["--trim-start-m", "400"],
      ["--trim-start-m", "0.00001"],
      ["--trim-start-m", "200", "--trim-end-m", "200"], ["--trim-start-m"], ["--to", "other"], ["--unknown"]]) {
      const result = await runCli(root, ["travel", "route", "recordings/odysseus.gpx", "--to", "routes", ...extras, "--json"]);
      expect(result.code).toBe(1); expect(result.stdout).toBe("");
      expect(existsSync(join(root, "routes"))).toBe(false);
    }
    const missing = await runCli(root, ["travel", "route", "missing.gpx", "--to", "routes", "--json"]);
    expect(missing.code).toBe(1);
    expect(readFileSync(join(root, "recordings/odysseus.gpx"), "utf8")).toBe(fixture);
  });
});
