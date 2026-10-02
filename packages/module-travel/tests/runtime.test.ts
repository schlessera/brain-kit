import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "fs";
import { dirname, join } from "path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import { readTravelCorpus, summarizePlaceVisits } from "../src/content.js";

const SPEAKING = "@schlessera/brain-module-speaking";
const TRAVEL = "@schlessera/brain-module-travel";
const roots: string[] = [];
const party = [{ name: "Odysseus" }, { name: "Penelope", requirementsDoc: "people/penelope.md" }];
function write(root: string, path: string, source: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}
function brain(modules: Record<string, unknown> = { [TRAVEL]: {} }): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  write(root, "brain.config.json", JSON.stringify({ modules }));
  return root;
}
const itinerary = "---\ntype: travel\ntitle: Homecoming to Ithaca\ncreated: 2026-07-15\nupdated: 2026-07-15\ntags: [travel]\n---\n[[travel/ithaca/itinerary]]\n";
const trip = "---\ntype: trip\ntitle: Ithaca headland\ntrip_status: done\nvisits:\n  - id: homecoming\n    date: null\n    places: [places/ithaca.md]\n---\nOdysseus and Penelope return.\n";
const place = "---\ntype: place\ntitle: Ithaca\nplace_kind: spot\ncoordinates: null\nvisits:\n  - {document: trips/headland.md, visit: homecoming}\n  - {document: trips/headland.md, visit: homecoming}\nvisit_count: 999\nfirst_visit: 1900-01-01\n---\n";
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

describe("real travel module and CLI", () => {
  test("travel alone and both modules load and lint without duplicate ownership", async () => {
    for (const modules of [{ [TRAVEL]: {} }, { [SPEAKING]: {}, [TRAVEL]: {} }]) {
      const root = brain(modules);
      const listed = await runCli(root, ["module", "list", "--json"]);
      expect(listed.code).toBe(0);
      const enabled = JSON.parse(listed.stdout).enabled;
      expect(enabled.find((entry: { name: string }) => entry.name === "travel").types).toEqual(["travel", "trip", "place"]);
      if (SPEAKING in modules) expect(enabled.find((entry: { name: string }) => entry.name === "speaking").types).toEqual(["talk", "conference"]);
      const linted = await runCli(root, ["module", "lint", "travel", "--json"]);
      expect(linted.code).toBe(0);
      expect(JSON.parse(linted.stdout).errors).toBe(0);
    }
  });

  test("legacy speaking-only config loads, retains party data and gives an upgrade action", async () => {
    const root = brain({ [SPEAKING]: { travelParty: party } });
    const source = readFileSync(join(root, "brain.config.json"), "utf8");
    const listed = await runCli(root, ["module", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).enabled[0].types).toEqual(["talk", "conference"]);
    expect(listed.stderr).toContain("brain travel migrate");
    expect(readFileSync(join(root, "brain.config.json"), "utf8")).toBe(source);
    expect(JSON.parse(source).modules[SPEAKING].travelParty).toEqual(party);
  });

  test("real migration preview/apply/reload preserves all settings and document bytes, then is a no-op", async () => {
    const root = brain({ [SPEAKING]: { travelParty: party }, [TRAVEL]: {} });
    write(root, "travel/ithaca/itinerary.md", itinerary);
    const source = readFileSync(join(root, "brain.config.json"), "utf8");
    expect(party.length).toBeGreaterThan(0);
    const preview = await runCli(root, ["travel", "migrate", "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({ migration: { path: "brain.config.json", changed: true, dry_run: true } });
    expect(readFileSync(join(root, "brain.config.json"), "utf8")).toBe(source);
    const applied = await runCli(root, ["travel", "migrate", "--json"]);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).migration.changed).toBe(true);
    const migrated = readFileSync(join(root, "brain.config.json"), "utf8");
    expect(JSON.parse(migrated).modules[TRAVEL].travelParty).toEqual(party);
    expect(JSON.parse(migrated).modules[SPEAKING]).toEqual({});
    const config = await runCli(root, ["config", "get", "modules"]);
    expect(config.code).toBe(0);
    expect(JSON.parse(config.stdout)[TRAVEL].travelParty).toEqual(party);
    const again = await runCli(root, ["travel", "migrate", "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).migration.changed).toBe(false);
    expect(readFileSync(join(root, "brain.config.json"), "utf8")).toBe(migrated);
    expect(readFileSync(join(root, "travel/ithaca/itinerary.md"), "utf8")).toBe(itinerary);
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code).toBe(0);
    const found = await runCli(root, ["search", "Homecoming", "--mode", "fts", "--json"]);
    expect(found.code).toBe(0);
    expect(JSON.parse(found.stdout).results.map((hit: { path: string }) => hit.path)).toContain("travel/ithaca/itinerary.md");
  });

  test("real TypeScript migration preserves logic, reloads and never edits content", async () => {
    const root = brain();
    const source = `import { defineConfig } from "@schlessera/brain";\nconst retained = () => "unrelated logic";\nexport default defineConfig({modules:{"${SPEAKING}":{travelParty:${JSON.stringify(party)}},"${TRAVEL}":{}}});\n`;
    write(root, "brain.config.ts", source);
    write(root, "travel/ithaca/itinerary.md", itinerary);
    const applied = await runCli(root, ["travel", "migrate", "--json"]);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).migration.changed).toBe(true);
    expect(readFileSync(join(root, "brain.config.ts"), "utf8")).toContain('const retained = () => "unrelated logic";');
    const config = await runCli(root, ["config", "get", "modules"]);
    expect(config.code).toBe(0);
    expect(JSON.parse(config.stdout)[TRAVEL].travelParty).toEqual(party);
    expect(readFileSync(join(root, "travel/ithaca/itinerary.md"), "utf8")).toBe(itinerary);
  });

  test("conflicts and saved settings write nothing through the real CLI", async () => {
    const root = brain({ [SPEAKING]: { travelParty: party }, [TRAVEL]: { travelParty: [{ name: "Telemachus" }] } });
    const original = readFileSync(join(root, "brain.config.json"), "utf8");
    const conflict = await runCli(root, ["travel", "migrate", "--json"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toMatch(/conflict/i);
    expect(readFileSync(join(root, "brain.config.json"), "utf8")).toBe(original);
    write(root, "settings/travel.json", JSON.stringify({ travelParty: party }));
    const saved = await runCli(root, ["travel", "migrate", "--json"]);
    expect(saved.code).toBe(1);
    expect(saved.stderr).toContain("settings/travel.json");
    expect(readFileSync(join(root, "brain.config.json"), "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(join(root, "settings/travel.json"), "utf8")).travelParty).toEqual(party);
  });

  for (const module of ["speaking", "travel"]) {
    for (const empty of [false, true]) {
      const filename = `settings/${module}.json`;
      const label = `${filename} (${empty ? "empty" : "nonempty"})`;
      const refusalFixture = () => {
        const fullParty = party.map((member, index) => ({ ...member, role: index === 0 ? "traveler" : "partner" }));
        expect(fullParty).toHaveLength(2);
        expect(fullParty[1]!.requirementsDoc).toBe("people/penelope.md");
        const root = brain({ [SPEAKING]: { travelParty: fullParty }, [TRAVEL]: {} });
        write(root, filename, empty ? "{}\n" : JSON.stringify({ travelParty: fullParty }, null, 2) + "\n");
        write(root, "travel/ithaca/itinerary.md", itinerary);
        write(root, "people/penelope.md", "---\ntype: person\ntitle: Penelope\n---\nTravel requirements fixture.\n");
        const paths = ["brain.config.json", filename, "travel/ithaca/itinerary.md", "people/penelope.md"];
        const snapshot = () => paths.map((path) => [path, readFileSync(join(root, path))]);
        return { root, snapshot };
      };

      test(`${label} migration refusal preserves config, settings and content bytes`, async () => {
        const { root, snapshot } = refusalFixture();
        const before = snapshot();
        expect(before).toHaveLength(4);
        for (const flags of [[], ["--dry-run"]]) {
          const result = await runCli(root, ["travel", "migrate", ...flags, "--json"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(filename);
          expect(result.stderr).toContain("no changes made");
          expect(result.stdout).toBe("");
          expect(snapshot()).toEqual(before);
        }
      });

      test(`${label} refusal names the reviewed manual upgrade instead of an unavailable planner`, async () => {
        const { root } = refusalFixture();
        const result = await runCli(root, ["travel", "migrate", "--json"]);
        // Assert the corrected action separately: filename and refusal already
        // worked before this diagnostic repair and cannot prove its guidance.
        expect(result.stderr).toContain("Review canonical config and saved settings precedence");
        expect(result.stderr).toContain("manual upgrade");
        expect(result.stderr).toContain("packages/module-travel/README.md");
        expect(result.stderr).toContain("Upgrade from speaking");
        expect(result.stderr).not.toContain("module-settings migration");
        expect(result.stderr).not.toContain("brain module settings travel --migrate");
      });
    }
  }

  test("an in-root config symlink is refused without overwriting its target", async () => {
    const root = brain({ [SPEAKING]: { travelParty: party }, [TRAVEL]: {} });
    write(root, "actual.json", readFileSync(join(root, "brain.config.json"), "utf8"));
    const original = readFileSync(join(root, "actual.json"), "utf8");
    const { unlinkSync } = await import("fs");
    unlinkSync(join(root, "brain.config.json"));
    symlinkSync("actual.json", join(root, "brain.config.json"));
    const result = await runCli(root, ["travel", "migrate", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("symlink");
    expect(readFileSync(join(root, "actual.json"), "utf8")).toBe(original);
  });

  test("actual domain validation catches a dangling visit, escaped asset and missing route", async () => {
    const root = brain();
    write(root, "travel/ithaca/itinerary.md", itinerary);
    write(root, "trips/headland.md", trip);
    write(root, "places/ithaca.md", place);
    const valid = await runCli(root, ["travel", "validate", "--json"]);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual({ validation: { valid: true, files: 3, issues: [] } });
    write(root, "places/ithaca.md", place.replaceAll("visit: homecoming", "visit: missing"));
    const invalid = await runCli(root, ["travel", "validate", "--json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).validation.issues.map((issue: { message: string }) => issue.message))
      .toContain("Unknown visit reference: trips/headland.md#missing");
    write(root, "places/ithaca.md", place);
    write(root, "trips/headland.md", trip.replace("    date: null", "    date: null\n    track: ../../outside.gpx"));
    const escaped = await runCli(root, ["travel", "validate", "--json"]);
    expect(escaped.code).toBe(1);
    expect(escaped.stdout).toContain("escaping asset reference");
    write(root, "trips/headland.md", trip.replace("    date: null", "    date: null\n    route: absent"));
    const missingRoute = await runCli(root, ["travel", "validate", "--json"]);
    expect(missingRoute.code).toBe(1);
    expect(missingRoute.stdout).toContain("unknown route");
  });

  test("canonical hierarchy and relative assets resolve without network or content writes", async () => {
    const root = brain();
    write(root, "places/country.md", "---\ntype: place\ntitle: Ithaca realm\nplace_kind: country\n---\n");
    write(root, "places/town.md", "---\ntype: place\ntitle: Ithaca town\nplace_kind: town\nparent_place: places/country.md\n---\n");
    const spot = place.replace("coordinates: null", "coordinates: {lat: 0, lon: 0}\nparent_place: places/town.md");
    write(root, "places/ithaca.md", spot);
    const source = trip.replace("trip_status: done", "trip_status: done\ncover: ../assets/cover.jpg\nroutes: [{label: north, kind: planned, primary: true, gpx: routes/north.gpx}]")
      .replace("    date: null", "    date: null\n    route: north\n    track: routes/north.gpx\n    photos: [../assets/cover.jpg]");
    write(root, "trips/headland.md", source);
    write(root, "trips/routes/north.gpx", "<gpx/>");
    write(root, "assets/cover.jpg", "fixture asset");
    const valid = await runCli(root, ["travel", "validate", "--json"]);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout).validation.files).toBe(4);
    expect(readFileSync(join(root, "trips/headland.md"), "utf8")).toBe(source);
    write(root, "places/country.md", "---\ntype: place\ntitle: Ithaca realm\nplace_kind: country\nparent_place: places/ithaca.md\n---\n");
    const invalid = await runCli(root, ["travel", "validate", "--json"]);
    expect(invalid.code).toBe(1);
    const messages = JSON.parse(invalid.stdout).validation.issues.map((issue: {message: string}) => issue.message);
    expect(messages).toContain("Place hierarchy contains a cycle");
    expect(messages).toContain("Place hierarchy must run from country to city/town to spot");
  });

  test("place counts deduplicate canonical events and ignore competing rendered totals", () => {
    const root = brain();
    write(root, "trips/headland.md", trip);
    write(root, "places/ithaca.md", place);
    const corpus = readTravelCorpus(root);
    expect(corpus.issues).toEqual([]);
    expect(corpus.documents.size).toBe(2);
    expect(summarizePlaceVisits(corpus, "places/ithaca.md")).toEqual({
      path: "places/ithaca.md", visit_count: 1, first_visit: null, last_visit: null,
      visits: [{ document: "trips/headland.md", visit: "homecoming", date: null }],
    });
    expect(readFileSync(join(root, "places/ithaca.md"), "utf8")).toBe(place);
  });

  test("travel-only indexing does not inherit slide-deck exclusions", async () => {
    const root = brain();
    write(root, "travel/versions/itinerary.md", itinerary);
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code).toBe(0);
    const found = await runCli(root, ["search", "Homecoming", "--mode", "fts", "--json"]);
    expect(found.code).toBe(0);
    expect(JSON.parse(found.stdout).results.map((hit: { path: string }) => hit.path)).toContain("travel/versions/itinerary.md");
  });

  test("legacy directory links retain every shared anchor with travel alone", async () => {
    const root = brain();
    for (const anchor of ["status.md", "itinerary.md", "outline.md"]) {
      const slug = anchor.slice(0, -3);
      write(root, `travel/${slug}/${anchor}`, itinerary.replace("[[travel/ithaca/itinerary]]", ""));
    }
    write(root, "travel/links.md", itinerary.replace("[[travel/ithaca/itinerary]]",
      "[[travel/status/]]\n[[travel/itinerary/]]\n[[travel/outline/]]"));
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code).toBe(0);
    const result = await runCli(root, ["validate", "--json"]);
    expect(result.code).toBe(0);
    const issues = JSON.parse(result.stdout).issues;
    expect(issues.filter((issue: { message: string }) => issue.message.includes("wiki-link"))).toEqual([]);
    const stats = await runCli(root, ["stats", "--json"]);
    expect(stats.code).toBe(0);
    expect(JSON.parse(stats.stdout).brokenLinks).toBe(0);
  });

  test("known visit bounds derive from complete nonempty history, with unknown bounds retained", () => {
    const root = brain();
    const history = trip.replace("    date: null", "    date: 2026-07-15")
      .replace("---\nOdysseus", "  - id: earlier\n    date: 2026-06-01\n    places: [places/ithaca.md]\n---\nOdysseus");
    write(root, "trips/headland.md", history);
    write(root, "places/ithaca.md", place);
    const known = summarizePlaceVisits(readTravelCorpus(root), "places/ithaca.md");
    expect(known.visits).toHaveLength(2);
    expect(known.visits.map((visit) => visit.date).sort()).toEqual(["2026-06-01", "2026-07-15"]);
    expect(known.first_visit).toBe("2026-06-01");
    expect(known.last_visit).toBe("2026-07-15");
    const three = history.replace("---\nOdysseus", "  - id: return\n    date: null\n    places: [places/ithaca.md]\n---\nOdysseus");
    write(root, "trips/headland.md", three);
    const unknown = summarizePlaceVisits(readTravelCorpus(root), "places/ithaca.md");
    expect(unknown.visits).toHaveLength(3);
    expect(unknown.visit_count).toBe(3);
    expect(unknown.first_visit).toBeNull();
    expect(unknown.last_visit).toBeNull();
  });
});
