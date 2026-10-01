import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import sharp from "sharp";
import * as exifr from "exifr";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import type { PhotoReport } from "../src/photo.js";
import { writePhotoCopy } from "../src/photo.js";
import { metadataMarkers, taggedPhoto } from "./photo-fixtures.js";

const roots: string[] = [];
let tagged: Buffer, small: Buffer, animated: Buffer;
function write(root: string, name: string, bytes: string | Uint8Array): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path;
}
function brain(): string {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  write(root, "brain.config.json", JSON.stringify({ modules: { "@schlessera/brain-module-travel": {} } }));
  return root;
}
function hash(bytes: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }
function report(stdout: string): PhotoReport { return JSON.parse(stdout).photo; }
const ALL_TAGS = { reviveValues: false, xmp: true, icc: true, iptc: true };
beforeAll(async () => {
  tagged = await taggedPhoto();
  small = await sharp({ create: { width: 24, height: 12, channels: 4, background: { r: 120, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const frames = Buffer.alloc(20 * 20 * 3);
  frames.fill(Buffer.from([207, 73, 52]), 0, frames.length / 2);
  frames.fill(Buffer.from([33, 91, 215]), frames.length / 2);
  animated = await sharp(frames, { raw: { width: 20, height: 20, pageHeight: 10, channels: 3 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const tags = await exifr.parse(tagged, ALL_TAGS);
  expect(tags.Artist).toBe("Odysseus"); expect(tags.DateTimeOriginal).toBe("2026:07:15 12:34:56");
  expect(tags.latitude).toBeCloseTo(38.37); expect(tags.longitude).toBeCloseTo(20.73);
  expect(tags.title).toBe("Odysseus in Ithaca"); expect(tags.ProfileDescription).toBeTruthy();
  expect(tags.ObjectName).toBe("Odysseus at the headland");
  expect(metadataMarkers(tagged)).toEqual(expect.arrayContaining([0xe1, 0xe2, 0xed, 0xfe]));
  expect((await sharp(tagged).metadata()).orientation).toBe(6);
  expect((await sharp(animated).metadata()).pages).toBe(2);
});

describe("photo publication through the actual filesystem", () => {
  test("a destination arriving after the existence check survives the atomic publish", () => {
    const root = brain(), directory = join(root, "photos"), target = join(directory, "ithaca.jpg");
    mkdirSync(directory);
    const arriving = Buffer.from("Odysseus keeps the concurrent writer's file");
    const original = fs.lstatSync;
    let injected = false;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: { throwIfNoEntry?: boolean }) => {
      const entry = original(path, options);
      if (String(path) === target && !entry && !injected) {
        writeFileSync(target, arriving); injected = true;
      }
      return entry;
    }) as typeof fs.lstatSync);
    let output: string;
    try { output = writePhotoCopy(directory, "ithaca", small); }
    finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect(hash(readFileSync(target))).toBe(hash(arriving));
    expect(output!).toBe(join(directory, "ithaca-2.jpg"));
    expect(hash(readFileSync(output!))).toBe(hash(small));
    expect(readdirSync(directory).sort()).toEqual(["ithaca-2.jpg", "ithaca.jpg"]);
  });

  test("cleanup failure after publication still reports the completed copy", () => {
    const root = brain(), directory = join(root, "photos"); mkdirSync(directory);
    const spy = spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture cleanup unavailable"), { code: "EIO" });
    });
    let output: string;
    try { output = writePhotoCopy(directory, "ithaca", small); }
    finally { spy.mockRestore(); }
    expect(output!).toBe(join(directory, "ithaca.jpg"));
    expect(hash(readFileSync(output!))).toBe(hash(small));
    const temporary = readdirSync(directory).filter(name => name.endsWith(".tmp"));
    expect(temporary).toHaveLength(1);
    expect(hash(readFileSync(join(directory, temporary[0])))).toBe(hash(small));
  });

  test("partial bytes from a failed disk write are removed before any publication", () => {
    const root = brain(), directory = join(root, "photos"); mkdirSync(directory);
    let written = 0;
    const spy = spyOn(fs, "writeFileSync").mockImplementation((file, data) => {
      if (typeof file !== "number" || !(data instanceof Uint8Array)) throw new Error("Unexpected fixture write");
      written += fs.writeSync(file, data.subarray(0, 8));
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    });
    try { expect(() => writePhotoCopy(directory, "ithaca", small)).toThrow("fixture disk full"); }
    finally { spy.mockRestore(); }
    expect(written).toBeGreaterThan(0);
    expect(readdirSync(directory)).toEqual([]);
  });
});
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

describe("real travel photo CLI", () => {
  test("reports original capture time and GPS without inventing a timezone", async () => {
    const root = brain(); write(root, "inputs/ithaca.jpg", tagged);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "trips/ithaca/photos", "--json"]);
    expect(result.code).toBe(0); const photo = report(result.stdout);
    expect(photo.files).toHaveLength(1); expect(photo.errors).toEqual([]);
    expect(photo.files[0].captured_at).toBe("2026-07-15T12:34:56+02:00");
    expect(photo.files[0].location?.lat).toBeCloseTo(38.37); expect(photo.files[0].location?.lon).toBeCloseTo(20.73);
    expect(photo.files[0].output).toBe("trips/ithaca/photos/ithaca.jpg");
    expect(photo.files[0].bytes).toBe(readFileSync(join(root, photo.files[0].output)).length);
    const noOffset = await taggedPhoto({ offset: "" });
    write(root, "inputs/scheria.jpg", noOffset);
    const local = await runCli(root, ["travel", "photo", "inputs/scheria.jpg", "--to", "photos"], { TZ: "Pacific/Honolulu" });
    expect(local.code).toBe(0); expect(report(local.stdout).files[0].captured_at).toBe("2026-07-15T12:34:56");
  });

  test("retains fractional capture time and signed coordinates from a WebP EXIF block", async () => {
    const root = brain();
    const original = await taggedPhoto({ fraction: "1234", offset: "-03:30", southWest: true });
    const webp = await sharp(original).keepMetadata().webp().toBuffer();
    expect((await sharp(webp).metadata()).exif?.length).toBeGreaterThan(0);
    write(root, "inputs/ithaca.webp", webp);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.webp", "--to", "photos"]);
    expect(result.code).toBe(0); const file = report(result.stdout).files[0];
    expect(file.captured_at).toBe("2026-07-15T12:34:56.1234-03:30");
    expect(file.location?.lat).toBeCloseTo(-38.37); expect(file.location?.lon).toBeCloseTo(-20.73);
    expect(metadataMarkers(readFileSync(join(root, file.output)))).toEqual([]);
  });

  test("reduces and rotates actual pixels before dropping orientation", async () => {
    const root = brain(); write(root, "inputs/ithaca.jpg", tagged);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(0); const file = report(result.stdout).files[0];
    const path = join(root, file.output), info = await sharp(path).metadata();
    expect([info.width, info.height]).toEqual([1000, 1600]);
    expect([file.width, file.height]).toEqual([info.width, info.height]);
    expect(info.orientation).toBeUndefined(); expect(info.isProgressive).toBe(true);
    const decoded = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y, colour] of [[100, 100, [33, 91, 215]], [900, 100, [224, 49, 40]], [100, 1500, [237, 195, 49]], [900, 1500, [56, 163, 92]]] as const) {
      const pixel = (y * decoded.info.width + x) * decoded.info.channels;
      for (let c = 0; c < 3; c++) expect(Math.abs(decoded.data[pixel + c] - colour[c])).toBeLessThan(12);
    }
  });

  test("an independent metadata reader finds no EXIF GPS XMP ICC IPTC or comments in the copy", async () => {
    const root = brain(); write(root, "inputs/ithaca.jpg", tagged);
    const original = await exifr.parse(tagged, ALL_TAGS);
    expect(Object.keys(original).length).toBeGreaterThan(10);
    expect(metadataMarkers(tagged).length).toBeGreaterThan(4);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(0); expect(report(result.stdout).files).toHaveLength(1);
    const bytes = readFileSync(join(root, report(result.stdout).files[0].output));
    expect(await exifr.parse(bytes, ALL_TAGS)).toBeUndefined();
    expect(metadataMarkers(bytes)).toEqual([]);
    const decoded = await sharp(bytes).metadata();
    expect(decoded.format).toBe("jpeg"); expect(decoded.hasProfile).toBe(false);
    for (const key of ["exif", "xmp", "icc", "iptc"] as const) expect(decoded[key]).toBeUndefined();
  });

  test("existing output bytes survive and reruns choose deterministic suffixes", async () => {
    const root = brain(); write(root, "inputs/ithaca.jpg", tagged);
    const existing = Buffer.from("Odysseus keeps this existing photo");
    write(root, "photos/ithaca.jpg", existing);
    expect(existing.length).toBeGreaterThan(0);
    const first = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(first.code).toBe(0);
    expect(hash(readFileSync(join(root, "photos/ithaca.jpg")))).toBe(hash(existing));
    expect(report(first.stdout).files[0].output).toBe("photos/ithaca-2.jpg");
    const second = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(second.code).toBe(0); expect(report(second.stdout).files[0].output).toBe("photos/ithaca-3.jpg");
    expect(hash(readFileSync(join(root, "inputs/ithaca.jpg")))).toBe(hash(tagged));
    expect(readdirSync(join(root, "photos")).sort()).toEqual(["ithaca-2.jpg", "ithaca-3.jpg", "ithaca.jpg"]);
  });

  test("a source in the output directory is never replaced by its stripped copy", async () => {
    const root = brain(); write(root, "photos/ithaca.jpg", tagged);
    const result = await runCli(root, ["travel", "photo", "photos/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(0); expect(report(result.stdout).files[0].output).toBe("photos/ithaca-2.jpg");
    expect(hash(readFileSync(join(root, "photos/ithaca.jpg")))).toBe(hash(tagged));
    expect((await exifr.parse(readFileSync(join(root, "photos/ithaca.jpg")), ALL_TAGS)).Artist).toBe("Odysseus");
  });

  test("small transparent inputs become white-backed JPEGs without upscaling or fabricated capture data", async () => {
    const root = brain(); write(root, "inputs/penelope.png", small);
    const result = await runCli(root, ["travel", "photo", "inputs/penelope.png", "--to", "photos"]);
    expect(result.code).toBe(0); const file = report(result.stdout).files[0];
    const bytes = readFileSync(join(root, file.output)), info = await sharp(bytes).metadata();
    expect(info.format).toBe("jpeg"); expect([info.width, info.height]).toEqual([24, 12]);
    expect(file.captured_at).toBeNull(); expect(file.location).toBeNull();
    const pixels = await sharp(bytes).raw().toBuffer();
    expect([...pixels.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  test("valid zero GPS coordinates survive and impossible EXIF dates stay unknown", async () => {
    const root = brain(); const invalidDate = await taggedPhoto({ date: "2026:02:30 12:00:00", zeroGps: true });
    write(root, "inputs/ithaca.jpg", invalidDate);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(0); const file = report(result.stdout).files[0];
    expect(file.location).toEqual({ lat: 0, lon: 0 }); expect(file.captured_at).toBeNull();
  });

  test("explicit source files outside the brain are read without storage or modification", async () => {
    const root = brain(), originals = brain(), input = write(originals, "camera/ithaca.jpg", tagged);
    const result = await runCli(root, ["travel", "photo", input, "--to", "photos"]);
    expect(result.code).toBe(0); expect(report(result.stdout).files).toHaveLength(1);
    expect(hash(readFileSync(input))).toBe(hash(tagged));
    expect(readdirSync(join(originals, "camera"))).toEqual(["ithaca.jpg"]);
  });

  test("batch errors name invalid inputs and never leave misleading completed files", async () => {
    const root = brain(); write(root, "inputs/ithaca.jpg", tagged); write(root, "inputs/troy.jpg", "not an image");
    const result = await runCli(root, ["travel", "photo", "inputs/troy.jpg", "inputs/absent.jpg", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(2); const photo = report(result.stdout);
    expect(photo.files.map(file => file.source)).toEqual(["inputs/ithaca.jpg"]);
    expect(photo.errors.map(error => error.source)).toEqual(["inputs/troy.jpg", "inputs/absent.jpg"]);
    expect(photo.errors.every(error => error.message.length > 0)).toBe(true);
    expect(readdirSync(join(root, "photos"))).toEqual(["ithaca.jpg"]);
    expect(readFileSync(join(root, "inputs/troy.jpg"), "utf8")).toBe("not an image");
  });

  test("truncated pixel data fails before publishing even when its header is readable", async () => {
    const root = brain();
    const scan = tagged.indexOf(Buffer.from([0xff, 0xda]));
    const truncated = tagged.subarray(0, scan + 20);
    expect((await sharp(truncated).metadata()).width).toBe(3200);
    write(root, "inputs/ithaca.jpg", truncated);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(2); const photo = report(result.stdout);
    expect(photo.errors).toHaveLength(1); expect(photo.files).toEqual([]);
    expect(readdirSync(join(root, "photos"))).toEqual([]);
  });

  test("animations are refused instead of silently retaining only one frame", async () => {
    const root = brain(); write(root, "inputs/ithaca.gif", animated);
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.gif", "--to", "photos"]);
    expect(result.code).toBe(2); const photo = report(result.stdout);
    expect(photo.files).toEqual([]); expect(photo.errors[0].message).toMatch(/frame|page|animated/i);
  });

  test("escaping and symlinked output directories are refused through the CLI", async () => {
    const root = brain(), outside = brain(); write(root, "inputs/ithaca.jpg", tagged);
    symlinkSync(outside, join(root, "outside-link"));
    symlinkSync(join(outside, "new"), join(root, "dangling-link"));
    mkdirSync(join(root, "photos")); symlinkSync("photos", join(root, "inside-link"));
    for (const to of [outside, "../" + outside.split("/").at(-1), "outside-link", "dangling-link", "inside-link"]) {
      const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", to]);
      expect(result.code).toBe(1); expect(result.stderr).toMatch(/root|symlink|outside/i);
    }
    expect(readdirSync(join(root, "photos"))).toEqual([]);
    expect(readdirSync(outside).sort()).toEqual(["brain.config.json", "node_modules"]);
  });

  test("a symlink at the output filename cannot overwrite its target", async () => {
    const root = brain(), outside = brain(); write(root, "inputs/ithaca.jpg", tagged);
    const retained = write(outside, "retained.jpg", "Odysseus retains this");
    mkdirSync(join(root, "photos")); symlinkSync(retained, join(root, "photos/ithaca.jpg"));
    const result = await runCli(root, ["travel", "photo", "inputs/ithaca.jpg", "--to", "photos"]);
    expect(result.code).toBe(2); expect(report(result.stdout).files).toEqual([]);
    expect(report(result.stdout).errors[0].message).toMatch(/symlink/i);
    expect(readFileSync(retained, "utf8")).toBe("Odysseus retains this");
  });

  test("argument errors do no work and dash-leading filenames remain positional after --", async () => {
    const root = brain(); write(root, "-ithaca.png", small);
    for (const args of [[], ["--to", "photos"], ["-ithaca.png"], ["-ithaca.png", "--to"], ["--to", "photos", "--to", "other", "inputs/no.jpg"]]) {
      const result = await runCli(root, ["travel", "photo", ...args]);
      expect(result.code).toBe(1);
    }
    const result = await runCli(root, ["travel", "photo", "--to", "photos", "--json", "--", "-ithaca.png"]);
    expect(result.code).toBe(0); expect(report(result.stdout).files[0].source).toBe("-ithaca.png");
    const human = await runCli(root, ["travel", "photo", "--to", "photos", "--human", "--", "-ithaca.png"]);
    expect(human.code).toBe(0); expect(human.stdout).toContain("photos/-ithaca-2.jpg");
  });
});
