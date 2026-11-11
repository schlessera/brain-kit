import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import * as exifr from "exifr";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import { taggedPhoto } from "./photo-fixtures.js";
import { validateOutputNaming } from "../src/output-naming.js";

const roots: string[] = [];
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const track = readFileSync(join(import.meta.dir, "fixtures/routes/odysseus.gpx"));
let plain: Buffer, tagged: Buffer, invalid: Buffer;
beforeAll(async () => {
  plain = await sharp({ create: { width: 24, height: 12, channels: 3, background: "white" } }).jpeg().toBuffer();
  tagged = await taggedPhoto({ date: "2026:09:27 00:30:00", offset: "+14:00", fraction: "123" });
  invalid = await taggedPhoto({ date: "2026:02:30 12:00:00" });
  expect(plain.length).toBeGreaterThan(0);
  expect((await exifr.parse(tagged, { reviveValues: false })).DateTimeOriginal).toBe("2026:09:27 00:30:00");
});
function brain(): string {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "@schlessera/brain-module-travel": {} } }));
  mkdirSync(join(root, "inputs"));
  writeFileSync(join(root, "inputs/IMG_4711.jpg"), plain);
  writeFileSync(join(root, "inputs/IMG_4712.jpg"), plain);
  writeFileSync(join(root, "inputs/camera.jpg"), tagged);
  writeFileSync(join(root, "inputs/invalid.jpg"), invalid);
  writeFileSync(join(root, "inputs/Recorded.GPX"), track);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
const photo = (root: string, flags: string[] = [], input = "inputs/IMG_4711.jpg", env = {}) =>
  runCli(root, ["travel", "photo", input, "--to", "copies", ...flags, "--json"], env);
const route = (root: string, flags: string[] = []) =>
  runCli(root, ["travel", "route", "inputs/Recorded.GPX", "--to", "routes", ...flags, "--json"]);

const DATE_REFUSAL = "--date requires a valid calendar date in YYYY-MM-DD form.";
const SLUG_REFUSAL = "--name descriptor must contain an ASCII letter, digit, underscore or hyphen after accent folding.";
const naming = (options: { name?: string; date?: string }, forceDate = false) => {
  try { return validateOutputNaming(options, forceDate); } catch (error) { return (error as Error).message; }
};

describe("output naming rules", () => {
  test("nonexistent, malformed and year-zero dates refuse with the calendar diagnostic", () => {
    const dates = ["2026-02-30", "2026-02-29", "1900-02-29", "2026-04-31", "0000-01-01", "2026-13-01", "2026-1-01", "2026-09-27T00:00:00Z"];
    expect(dates.map((date) => naming({ date }))).toEqual(dates.map(() => DATE_REFUSAL));
    expect(dates.map((date) => naming({ name: "Ferry", date }))).toEqual(dates.map(() => DATE_REFUSAL));
  });

  test("valid leap days and dates before year 100 keep the exact supplied calendar", () => {
    const dates = ["2024-02-29", "2000-02-29", "0001-01-01", "0099-12-31"];
    expect(dates.map((date) => naming({ name: "Ferry", date }))).toEqual(dates.map((date) => ({ slug: "ferry", date })));
  });

  test("descriptors fold accents to the approved slug, and empty slugs refuse", () => {
    const labels = [["Café in Ithaca", "cafe-in-ithaca"], ["Cafe\u0301 in Ithaca", "cafe-in-ithaca"], ["Straße", "stra-e"], ["Plan.v2", "plan-v2"], ["Ferry__to-Scheria", "ferry__to-scheria"]];
    expect(labels.map(([name]) => naming({ name }))).toEqual(labels.map(([, slug]) => ({ slug, date: undefined })));
    expect(["Αθήνα", ".. /"].map((name) => naming({ name, date: "2026-09-27" }))).toEqual([SLUG_REFUSAL, SLUG_REFUSAL]);
  });

  test("forcing the date requires a valid date", () => {
    expect([naming({}, true), naming({ name: "Ferry" }, true), naming({ date: "2026-02-30" }, true), naming({ date: "2026-09-28" }, true)])
      .toEqual(["--force-date requires a valid --date calendar date.", "--force-date requires a valid --date calendar date.", DATE_REFUSAL, { date: "2026-09-28" }]);
  });
});

describe("real CLI output naming", () => {
  test("legacy names report no applied naming date with nonempty capture metadata", async () => {
    const root = brain();
    const p = await photo(root, [], "inputs/camera.jpg");
    expect(p.code).toBe(0); const file = JSON.parse(p.stdout).photo.files[0];
    expect(file.captured_at).toBe("2026-09-27T00:30:00.123+14:00");
    expect(file.output).toBe("copies/camera.jpg");
    expect(file.date_source).toBe("none");
    for (const flags of [["--date", "2026-09-28"], ["--date", "2026-09-28", "--force-date"]]) {
      const p = await photo(root, flags, "inputs/camera.jpg");
      expect(p.code).toBe(0);
      expect(JSON.parse(p.stdout).photo.files[0]).toMatchObject({ date_source: "none", captured_at: file.captured_at });
    }
    const r = await route(root, ["--date", "2026-09-28"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).route).toMatchObject({ gpx: "routes/recorded.gpx", date_source: "none" });
    expect(hash(readFileSync(join(root, "inputs/camera.jpg")))).toBe(hash(tagged));
    expect(hash(readFileSync(join(root, "inputs/Recorded.GPX")))).toBe(hash(track));
  });

  test("named photos use camera calendar date unless a valid flag is forced", async () => {
    const root = brain();
    for (const tz of ["Pacific/Honolulu", "Pacific/Kiritimati"]) {
      const p = await photo(root, ["--name", "Ferry to Scheria", "--date", "2026-09-28"], "inputs/camera.jpg", { TZ: tz });
      expect(p.code).toBe(0); const file = JSON.parse(p.stdout).photo.files[0];
      expect(file.captured_at).toBe("2026-09-27T00:30:00.123+14:00");
      expect(file.output).toMatch(/^copies\/2026-09-27-ferry-to-scheria(?:-2)?\.jpg$/);
      expect(file.date_source).toBe("exif");
    }
    const forced = await photo(root, ["--name", "Ferry to Scheria", "--date", "2026-09-28", "--force-date"], "inputs/camera.jpg");
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.stdout).photo.files[0]).toMatchObject({ output: "copies/2026-09-28-ferry-to-scheria.jpg", date_source: "flag", captured_at: "2026-09-27T00:30:00.123+14:00" });
    const exifOnly = await photo(root, ["--name", "Camera date"], "inputs/camera.jpg");
    expect(exifOnly.code).toBe(0);
    expect(JSON.parse(exifOnly.stdout).photo.files[0]).toMatchObject({ output: "copies/2026-09-27-camera-date.jpg", date_source: "exif" });
    expect(hash(readFileSync(join(root, "inputs/camera.jpg")))).toBe(hash(tagged));
  });

  test("missing or invalid EXIF falls back to the flag or undated", async () => {
    for (const input of ["inputs/IMG_4711.jpg", "inputs/invalid.jpg"]) {
      const root = brain();
      for (const [flags, expected, source] of [
        [["--name", "Ferry to Scheria", "--date", "2026-09-27"], "2026-09-27-ferry-to-scheria.jpg", "flag"],
        [["--name", "Ferry to Scheria"], "undated-ferry-to-scheria.jpg", "none"],
      ] as const) {
        const result = await photo(root, [...flags], input);
        expect(result.code).toBe(0);
        const file = JSON.parse(result.stdout).photo.files[0];
        expect(file).toMatchObject({ output: "copies/" + expected, date_source: source, captured_at: null });
        expect(readFileSync(join(root, file.output)).length).toBeGreaterThan(0);
      }
    }
  });

  test("batch naming and existing outputs retain non-overwriting suffixes", async () => {
    const root = brain(); mkdirSync(join(root, "copies"));
    const occupied = join(root, "copies/2026-09-27-ferry-to-scheria.jpg");
    writeFileSync(occupied, "Odysseus keeps the existing copy");
    const result = await runCli(root, ["travel", "photo", "inputs/IMG_4711.jpg", "inputs/IMG_4712.jpg", "--to", "copies", "--name", "Ferry to Scheria", "--date", "2026-09-27", "--json"]);
    expect(result.code).toBe(0); const report = JSON.parse(result.stdout).photo;
    expect(report.errors).toEqual([]); expect(report.files).toHaveLength(2);
    expect(report.files.map((f: any) => f.output)).toEqual(["copies/2026-09-27-ferry-to-scheria-2.jpg", "copies/2026-09-27-ferry-to-scheria-3.jpg"]);
    expect(report.files.map((f: any) => f.date_source)).toEqual(["flag", "flag"]);
    expect(readFileSync(occupied, "utf8")).toBe("Odysseus keeps the existing copy");
    expect(hash(readFileSync(join(root, "inputs/IMG_4711.jpg")))).toBe(hash(plain));
    expect(hash(readFileSync(join(root, "inputs/IMG_4712.jpg")))).toBe(hash(plain));
    for (const file of report.files) expect((await sharp(join(root, file.output)).metadata()).format).toBe("jpeg");
    const fresh = await runCli(root, ["travel", "photo", "inputs/IMG_4711.jpg", "inputs/IMG_4712.jpg", "--to", "fresh-copies", "--name", "Ferry to Scheria", "--date", "2026-09-27", "--json"]);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.stdout).photo.files.map((f: any) => f.output)).toEqual(["fresh-copies/2026-09-27-ferry-to-scheria.jpg", "fresh-copies/2026-09-27-ferry-to-scheria-2.jpg"]);
  });

  test("named local routes report the applied flag date without using track timestamps", async () => {
    const root = brain();
    for (const [flags, expected, source] of [
      [["--name", "Ferry to Scheria", "--date", "2026-09-27"], "2026-09-27-ferry-to-scheria.gpx", "flag"],
      [["--name", "Ferry to Scheria"], "ferry-to-scheria.gpx", "none"],
    ] as const) {
      const r = await route(root, [...flags]); expect(r.code).toBe(0); const saved = JSON.parse(r.stdout).route;
      expect(saved).toMatchObject({ gpx: "routes/" + expected, date_source: source, source_kind: "local_gpx", points: 4 });
      expect(saved.distance_km).toBeGreaterThan(0);
      expect(readFileSync(join(root, saved.gpx), "utf8")).toContain("<trkpt");
    }
    const repeated = await route(root, ["--name", "Ferry to Scheria", "--date", "2026-09-27"]);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout).route.gpx).toBe("routes/2026-09-27-ferry-to-scheria-2.gpx");
    expect(hash(readFileSync(join(root, "inputs/Recorded.GPX")))).toBe(hash(track));
  });

  test("complete descriptors use exactly approved accent folding in both real commands", async () => {
    // The rule table is owned by "output naming rules"; one combining-accent label proves both commands apply it.
    const root = brain(), label = "Cafe\u0301 in Ithaca";
    const p = await photo(root, ["--name", label, "--date", "2026-09-27"]);
    expect(p.code).toBe(0);
    expect(JSON.parse(p.stdout).photo.files[0]).toMatchObject({ output: "copies/2026-09-27-cafe-in-ithaca.jpg", date_source: "flag" });
    const r = await route(root, ["--name", label, "--date", "2026-09-27"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).route).toMatchObject({ gpx: "routes/2026-09-27-cafe-in-ithaca.gpx", date_source: "flag" });
  });

  test("invalid calendar dates and empty slugs refuse before any output directory", async () => {
    // One date and one slug refusal per command; "output naming rules" owns the full tables.
    for (const flags of [
      ["--date", "2026-02-30"],
      ["--name", "Αθήνα"],
    ]) {
      const root = brain();
      for (const [result, out] of [[await photo(root, flags), "copies"], [await route(root, flags), "routes"]] as const) {
        expect(result.code).toBe(1); expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/calendar date|descriptor/i);
        expect(existsSync(join(root, out))).toBe(false);
      }
      expect(hash(readFileSync(join(root, "inputs/IMG_4711.jpg")))).toBe(hash(plain));
      expect(hash(readFileSync(join(root, "inputs/Recorded.GPX")))).toBe(hash(track));
    }
  });

  test("force requires a valid date even without a name; option values and duplicates refuse", async () => {
    for (const flags of [["--force-date"], ["--force-date", "--date", "2026-02-30"], ["--name"], ["--date"], ["--name", "Ferry", "--name", "Scheria"], ["--date", "2026-09-27", "--date", "2026-09-28"], ["--date", "2026-09-27", "--force-date", "--force-date"]]) {
      const root = brain(), result = await photo(root, flags);
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(existsSync(join(root, "copies"))).toBe(false);
    }
    for (const flags of [["--name"], ["--date"], ["--force-date"], ["--name", "Ferry", "--name", "Scheria"], ["--date", "2026-09-27", "--date", "2026-09-28"]]) {
      const root = brain(), result = await route(root, flags);
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(existsSync(join(root, "routes"))).toBe(false);
    }
  });

  test("a date before year 100 keeps its exact supplied calendar in the route name", async () => {
    const root = brain();
    const r = await route(root, ["--name", "Ferry", "--date", "0001-01-01"]); expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).route).toMatchObject({ gpx: "routes/0001-01-01-ferry.gpx", date_source: "flag" });
  });

  test("named output containment and symlink guards remain active", async () => {
    const root = brain(), outside = brain();
    symlinkSync(outside, join(root, "linked"));
    for (const sub of ["photo", "route"]) {
      const source = sub === "photo" ? "inputs/IMG_4711.jpg" : "inputs/Recorded.GPX";
      for (const to of ["../escaped", "linked/copies"]) {
        const r = await runCli(root, ["travel", sub, source, "--to", to, "--name", "Ferry", "--date", "2026-09-27", "--json"]);
        expect(r.code).toBe(1);
      }
    }
    expect(readdirSync(outside)).not.toContain("copies");
    mkdirSync(join(root, "copies"));
    const retained = join(outside, "retained.jpg"); writeFileSync(retained, "Odysseus keeps the target");
    symlinkSync(retained, join(root, "copies/2026-09-27-ferry.jpg"));
    const r = await photo(root, ["--name", "Ferry", "--date", "2026-09-27"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).photo.errors[0].message).toMatch(/symlink/);
    expect(readFileSync(retained, "utf8")).toBe("Odysseus keeps the target");
  });
});
