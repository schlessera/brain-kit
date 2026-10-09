import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from "fs";
import { dirname, join, posix } from "path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import { readGeneratedRegion } from "../../core/src/lib/generated-regions.js";
import { taggedPhoto } from "./photo-fixtures.js";

const SPEAKING = "@schlessera/brain-module-speaking";
const TRAVEL = "@schlessera/brain-module-travel";
const GPX = join(import.meta.dir, "fixtures/routes/odysseus.gpx");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

function write(root: string, path: string, source: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}
const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");
function brain(modules: Record<string, unknown> = { [TRAVEL]: {} }): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  write(root, "brain.config.json", JSON.stringify({ modules }, null, 2) + "\n");
  return root;
}
/** Every brain file except Git, index state and the harness's dependency link, with its bytes. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(root, dir))) {
      const path = dir ? `${dir}/${name}` : name;
      if ([".git", ".brain", "node_modules"].includes(name) || name.startsWith("brain.db")) continue;
      if (lstatSync(join(root, path)).isDirectory()) walk(path);
      else files.set(path, readFileSync(join(root, path)).toString("base64"));
    }
  };
  walk("");
  return files;
}
const doc = (frontmatter: string, body = ""): string =>
  `---\n${frontmatter}\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [travel]\n---\n${body}`;
const region = (root: string, path: string, name: string): string | null => readGeneratedRegion(read(root, path), name);
async function sync(root: string, ...flags: string[]): Promise<{ code: number; files: string[]; stderr: string }> {
  const result = await runCli(root, ["travel", "sync", ...flags, "--json"]);
  return { code: result.code, files: result.stdout ? JSON.parse(result.stdout).sync.files : [], stderr: result.stderr };
}

/** With `linked`, Ithaca and its headland also reference trips/headland.md#first themselves. */
function places(root: string, linked = false): void {
  const reference = "\nvisits:\n  - {document: trips/headland.md, visit: first}";
  write(root, "places/ithaca.md", doc(`type: place\ntitle: Ithaca\nplace_kind: country${linked ? reference : ""}`));
  write(root, "places/ithaca/headland.md", doc(`type: place\ntitle: Headland\nplace_kind: spot\nparent_place: places/ithaca.md\ncoordinates: {lat: 38.37, lon: 20.72}${linked ? `${reference}\n  - {document: trips/headland.md, visit: first}\nvisit_count: 99\nfirst_visit: 1900-01-01` : ""}`));
  write(root, "places/scheria.md", doc("type: place\ntitle: Scheria\nplace_kind: country"));
  write(root, "places/scheria/palace.md", doc("type: place\ntitle: Palace of Alcinous\nplace_kind: spot\nparent_place: places/scheria.md\ncoordinates: null"));
}

describe("travel sync", () => {
  test("migration, journey, proposal, imported assets, visits, dismissal and sync form one deterministic flow", async () => {
    const party = [{ name: "Odysseus" }, { name: "Penelope", role: "partner", requirementsDoc: "people/penelope.md" }];
    const root = brain({ [SPEAKING]: { travelParty: party }, [TRAVEL]: {} });

    // 1. Upgrade a speaking-only party into travel.
    const migrated = await runCli(root, ["travel", "migrate", "--json"]);
    expect(migrated.code).toBe(0);
    expect(JSON.parse(migrated.stdout).migration.changed).toBe(true);
    expect(JSON.parse(read(root, "brain.config.json")).modules[TRAVEL].travelParty).toEqual(party);

    // 2. A conference links its journey; the journey records its visit and place.
    write(root, "people/penelope.md", doc("type: note\ntitle: Penelope"));
    write(root, "conferences/scheria-games-2026/status.md", doc("type: conference\ntitle: Scheria games 2026", "## Travel\n\n[[travel/scheria/itinerary]]\n"));
    write(root, "travel/scheria/itinerary.md", doc("type: travel\ntitle: Voyage to Scheria\nplaces: [places/scheria/palace.md]\nvisits:\n  - {id: games, date: 2026-07-12, party: [Odysseus]}", "[[conferences/scheria-games-2026/status]]\n"));
    places(root);

    // 3. Propose two trips with alternative routes; nothing is visited yet.
    write(root, "recordings/odysseus.gpx", readFileSync(GPX));
    const route = await runCli(root, ["travel", "route", "recordings/odysseus.gpx", "--to", "trips/routes", "--name", "North path", "--json"]);
    expect(route.code).toBe(0);
    const imported = JSON.parse(route.stdout).route;
    expect(imported.gpx).toBe("trips/routes/north-path.gpx");
    expect(imported.distance_km).toBeGreaterThan(0);
    const routes = `routes:\n  - {label: north-path, source: own plan, kind: planned, gpx: routes/north-path.gpx, distance_km: ${imported.distance_km}, ascent_m: ${imported.ascent_m}, primary: true}\n  - {label: coast, source: official, kind: reference, url: "https://example.org/ithaca/coast"}`;
    const proposed = doc(`type: trip\ntitle: Ithaca headland\ntrip_status: proposed\nplaces: [places/ithaca/headland.md]\n${routes}`, "A walk to the headland.\n");
    write(root, "trips/headland.md", proposed);
    write(root, "trips/cyclops-cave.md", doc("type: trip\ntitle: Cyclops cave\ntrip_status: proposed\nplaces: [places/ithaca.md]"));
    expect((await sync(root)).files).toEqual(["trips/_index.md", "places/_index.md"]);
    expect(region(root, "trips/_index.md", "travel-trips")).toContain(
      `### Proposed\n\n| Trip | Primary route | Distance (km) | Ascent (m) | Places |\n|---|---|---|---|---|\n| [Cyclops cave](cyclops-cave.md) | — | — | — | [Ithaca](../places/ithaca.md) |\n| [Ithaca headland](headland.md) | north-path | ${imported.distance_km} | ${imported.ascent_m} | [Headland](../places/ithaca/headland.md) |\n`);

    // 4. Human prose around the region belongs to its author.
    const created = read(root, "trips/_index.md");
    expect(created).toContain("## Choosing rules");
    const prose = created.replace("## Choosing rules\n\n", "## Choosing rules\n\n- Flat routes when recovering.\n\n") + "\nNotes kept by hand.\n";
    write(root, "trips/_index.md", prose);

    // 5. Record two visits with a reduced photo, a cover and a recording; dismiss the cave.
    write(root, "camera/IMG_0001.jpg", await taggedPhoto());
    const photo = await runCli(root, ["travel", "photo", "camera/IMG_0001.jpg", "--to", "trips/photos", "--name", "Headland", "--json"]);
    expect(photo.code).toBe(0);
    const output = JSON.parse(photo.stdout).photo.files[0].output as string;
    const relativePhoto = posix.relative("trips", output);
    expect(relativePhoto).toBe("photos/2026-07-15-headland.jpg");
    const done = doc(`type: trip\ntitle: Ithaca headland\ntrip_status: done\nplaces: [places/ithaca/headland.md]\n${routes}\nvisits:\n  - {id: first, date: 2026-06-01, party: [Odysseus, Penelope], route: north-path, track: routes/north-path.gpx, actual: {distance_km: ${imported.distance_km}, ascent_m: null, duration_s: null}, verdict: Steep but worth it, photos: [${relativePhoto}], places: [places/ithaca/headland.md]}\n  - {id: second, date: 2027-04-02, party: [Odysseus], route: coast, verdict: Flat and easy}\ncover: ${relativePhoto}`, "A walk to the headland.\n");
    write(root, "trips/headland.md", done);
    write(root, "trips/cyclops-cave.md", doc("type: trip\ntitle: Cyclops cave\ntrip_status: dismissed\nplaces: [places/ithaca.md]"));
    places(root, true);
    const validation = await runCli(root, ["travel", "validate", "--json"]);
    expect(JSON.parse(validation.stdout).validation).toEqual({ valid: true, files: 7, issues: [] });

    expect((await sync(root)).files).toEqual(["trips/_index.md", "places/_index.md"]);
    const trips = read(root, "trips/_index.md");
    const [before, after] = prose.split(/<!-- brain:generated:travel-trips -->[\s\S]*<!-- \/brain:generated:travel-trips -->/);
    expect(trips.startsWith(before.replace(/^updated: .*$/m, trips.match(/^updated: .*$/m)![0]))).toBe(true);
    expect(trips.endsWith(after)).toBe(true);
    expect(after).toBe("\n\nNotes kept by hand.\n");
    expect(region(root, "trips/_index.md", "travel-trips")).toBe([
      "_Generated from each trip's frontmatter by `brain travel sync`. Edit the trips, not these tables._",
      "",
      "### Done",
      "",
      "| Trip | Visits | First | Last | Primary route | Distance (km) | Ascent (m) | Places |",
      "|---|---|---|---|---|---|---|---|",
      `| [Ithaca headland](headland.md) | 2 | 2026-06-01 | 2027-04-02 | north-path | ${imported.distance_km} | ${imported.ascent_m} | [Headland](../places/ithaca/headland.md) |`,
      "",
      "### Proposed",
      "",
      "_None._",
      "",
      "### Dismissed",
      "",
      "| Trip | Visits |",
      "|---|---|",
      "| [Cyclops cave](cyclops-cave.md) | 0 |",
    ].join("\n"));

    // Ithaca's own reference, the headland's duplicate references and the trip's
    // place link all name trips/headland.md#first: one visit, counted once.
    expect(region(root, "places/_index.md", "travel-places")).toBe([
      "_Generated from canonical journey, trip and place records by `brain travel sync`. Edit those records, not these tables._",
      "",
      "### Countries visited",
      "",
      "Each country counts its own visits and those of the places within it, once per visit.",
      "",
      "| Country | Visits | First | Last |",
      "|---|---|---|---|",
      "| [Ithaca](ithaca.md) | 2 | 2026-06-01 | 2027-04-02 |",
      "| [Scheria](scheria.md) | 1 | 2026-07-12 | 2026-07-12 |",
      "",
      "### Places",
      "",
      "Visits are each place's own canonical visits; dates stay unknown when any of its visits is undated.",
      "",
      "| Place | Kind | Within | Visits | First | Last | Coordinates |",
      "|---|---|---|---|---|---|---|",
      "| [Ithaca](ithaca.md) | country | — | 1 | 2026-06-01 | 2026-06-01 | unknown |",
      "| [Headland](ithaca/headland.md) | spot | [Ithaca](ithaca.md) | 2 | 2026-06-01 | 2027-04-02 | 38.37, 20.72 |",
      "| [Scheria](scheria.md) | country | — | 0 | unknown | unknown | unknown |",
      "| [Palace of Alcinous](scheria/palace.md) | spot | [Scheria](scheria.md) | 1 | 2026-07-12 | 2026-07-12 | unknown |",
      "",
      "### By year",
      "",
      "#### 2027",
      "",
      "| Place | Visits |",
      "|---|---|",
      "| [Headland](ithaca/headland.md) | 1 |",
      "",
      "#### 2026",
      "",
      "| Place | Visits |",
      "|---|---|",
      "| [Ithaca](ithaca.md) | 1 |",
      "| [Headland](ithaca/headland.md) | 1 |",
      "| [Palace of Alcinous](scheria/palace.md) | 1 |",
    ].join("\n"));

    // 6. An unchanged brain syncs to zero diff, and --check agrees.
    const settled = snapshot(root);
    expect(settled.size).toBeGreaterThan(10);
    expect((await sync(root)).files).toEqual([]);
    const check = await sync(root, "--check");
    expect(check.code).toBe(0);
    expect(check.files).toEqual([]);
    expect(snapshot(root)).toEqual(settled);

    // 7. Core sees every link, including speaking's link to its journey.
    const core = await runCli(root, ["validate", "--json"]);
    expect(core.code).toBe(0);
    const issues = JSON.parse(core.stdout).issues as { file: string; level: string; message: string }[];
    expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
    expect(issues.filter((issue) => /link/i.test(issue.message))).toEqual([]);
  });

  test("an undated visit keeps bounds unknown and lists the place under an unknown year", async () => {
    const root = brain();
    write(root, "places/ithaca.md", doc("type: place\ntitle: Ithaca\nplace_kind: country\ncoordinates: {lat: 0, lon: 0}"));
    write(root, "trips/shore.md", doc("type: trip\ntitle: Shore\ntrip_status: done\nplaces: [places/ithaca.md]\nvisits:\n  - {id: dated, date: 2026-07-12}\n  - {id: undated, date: null}\n  - {id: omitted}"));
    expect((await sync(root)).files).toEqual(["trips/_index.md", "places/_index.md"]);
    expect(region(root, "trips/_index.md", "travel-trips")).toContain("| [Shore](shore.md) | 3 | unknown | unknown | — | — | — | [Ithaca](../places/ithaca.md) |");
    const placesRegion = region(root, "places/_index.md", "travel-places")!;
    expect(placesRegion).toContain("| [Ithaca](ithaca.md) | 3 | unknown | unknown |\n");
    expect(placesRegion).toContain("| [Ithaca](ithaca.md) | country | — | 3 | unknown | unknown | 0, 0 |");
    expect(placesRegion).toContain("#### 2026\n\n| Place | Visits |\n|---|---|\n| [Ithaca](ithaca.md) | 1 |\n\n#### Unknown date\n\n| Place | Visits |\n|---|---|\n| [Ithaca](ithaca.md) | 2 |");
  });

  test("an invalid record fails clearly and writes no registry", async () => {
    const root = brain();
    write(root, "trips/_index.md", "---\ntype: index\ntitle: Trips\n---\nHand-written.\n");
    write(root, "trips/shore.md", doc("type: trip\ntitle: Shore\ntrip_status: done\nvisits:\n  - {id: first, date: 2026-07-12, route: missing}"));
    const before = snapshot(root);
    expect(before.get("trips/shore.md")).toBeDefined();
    const result = await runCli(root, ["travel", "sync", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("trips/shore.md: Visit first names an unknown route: missing");
    expect(result.stderr).toContain("nothing written");
    expect(existsSync(join(root, "places/_index.md"))).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  test("malformed markers in one registry leave both registries untouched", async () => {
    const root = brain();
    places(root);
    write(root, "trips/headland.md", doc("type: trip\ntitle: Headland\ntrip_status: done\nvisits:\n  - {id: first, date: 2026-07-12}"));
    write(root, "places/_index.md", "---\ntype: index\ntitle: Places\n---\n<!-- brain:generated:travel-places -->\n<!-- brain:generated:travel-places -->\n");
    const before = snapshot(root);
    const result = await runCli(root, ["travel", "sync"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('places/_index.md: generated region "travel-places" has malformed markers: 2 opening and 0 closing line(s)');
    expect(existsSync(join(root, "trips/_index.md"))).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  test("--check lists stale registries, writes nothing and exits 1", async () => {
    const root = brain();
    write(root, "trips/shore.md", doc("type: trip\ntitle: Shore\ntrip_status: proposed"));
    const before = snapshot(root);
    const check = await sync(root, "--check");
    expect(check.code).toBe(1);
    expect(check.files).toEqual(["trips/_index.md", "places/_index.md"]);
    expect(snapshot(root)).toEqual(before);
    expect((await sync(root)).code).toBe(0);
    expect(await sync(root, "--check")).toEqual({ code: 0, files: [], stderr: "" });
  });

  test("sync refuses an unknown flag without writing", async () => {
    const root = brain();
    write(root, "trips/shore.md", doc("type: trip\ntitle: Shore\ntrip_status: proposed"));
    const result = await runCli(root, ["travel", "sync", "--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown travel argument.");
    expect(existsSync(join(root, "trips/_index.md"))).toBe(false);
  });
});
