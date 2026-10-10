import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND_ASSET_SPECIFIER,
  BRAND_RASTERS,
  HTML_ICON_LINKS,
  WEB_APP_COLORS,
  WEB_APP_MANIFEST_ICONS,
} from "../src/brand.js";
import { BRAND_DIR, renderBrandRasters } from "../tools/brand/generate.js";
import { decodePng, type Rgba } from "./_png.js";

const PACKAGE = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(BRAND_DIR, file));
const png = (file: string) => decodePng(read(file));

/** The images inside an ICO, from its directory: declared size and PNG bytes. */
function icoImages(bytes: Buffer) {
  expect(bytes.readUInt16LE(2), "ICO type").toBe(1);
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + 16 * i;
    const size = bytes.readUInt8(entry) || 256;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    return { size, image: decodePng(bytes.subarray(offset, offset + length)) };
  });
}

function pixel(img: Rgba, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

const hex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

describe("brand rasters", () => {
  test("each PNG has the pixel dimensions its name states", () => {
    const want: Record<string, [number, number]> = {
      "apple-touch-icon.png": [180, 180],
      "icon-192.png": [192, 192],
      "icon-512.png": [512, 512],
      "icon-maskable-512.png": [512, 512],
      "social-card.png": [1200, 630],
    };
    expect(Object.keys(want).sort()).toEqual(BRAND_RASTERS.filter((f) => f.endsWith(".png")).sort());
    for (const [file, [w, h]] of Object.entries(want)) {
      const img = png(file);
      expect([img.width, img.height], file).toEqual([w, h]);
    }
  });

  test("favicon.ico holds 16, 32 and 48px images of those sizes", () => {
    const images = icoImages(read("favicon.ico"));
    expect(images.map((i) => i.size)).toEqual([16, 32, 48]);
    for (const { size, image } of images) expect([image.width, image.height], `${size}px`).toEqual([size, size]);
  });

  test("apple-touch-icon.png has no transparent pixel", () => {
    const img = png("apple-touch-icon.png");
    const translucent: string[] = [];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) if (pixel(img, x, y)[3] !== 255) translucent.push(`${x},${y}`);
    }
    expect(img.width * img.height).toBeGreaterThan(0);
    expect(translucent).toEqual([]);
  });

  test("the maskable icon draws nothing outside the central 80% circle", () => {
    const img = png("icon-maskable-512.png");
    const ground = pixel(img, 0, 0);
    expect(ground[3], "full-bleed ground").toBe(255);
    const radius = 0.4 * img.width;
    const c = img.width / 2;
    let drawn = 0;
    const outside: string[] = [];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (pixel(img, x, y).every((v, i) => v === ground[i])) continue;
        drawn++;
        if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > radius) outside.push(`${x},${y}`);
      }
    }
    expect(drawn, "the mark is drawn at all").toBeGreaterThan(1000);
    expect(outside).toEqual([]);
  });

  test("the manifest colours are the install icons' ground", () => {
    expect(WEB_APP_COLORS.theme_color).toBe("#0c1417");
    expect(WEB_APP_COLORS.background_color).toBe("#0c1417");
    for (const file of ["icon-maskable-512.png", "apple-touch-icon.png"]) {
      expect(hex(pixel(png(file), 0, 0).slice(0, 3)), file).toBe(WEB_APP_COLORS.background_color);
    }
  });

  test("re-running the generator reproduces the committed files byte for byte", () => {
    const rendered = renderBrandRasters();
    expect(Object.keys(rendered).sort()).toEqual([...BRAND_RASTERS].sort());
    for (const file of BRAND_RASTERS) {
      expect(rendered[file].length, file).toBeGreaterThan(0);
      expect(rendered[file].equals(read(file)), file).toBe(true);
    }
  });
});

describe("the exported icon lists match the shipped files", () => {
  const resolve = (file: string) => Bun.resolveSync(`${BRAND_ASSET_SPECIFIER}${file}`, PACKAGE);

  test("every manifest icon resolves to a file of its stated size and type", () => {
    expect(WEB_APP_MANIFEST_ICONS.length).toBeGreaterThan(0);
    for (const icon of WEB_APP_MANIFEST_ICONS) {
      const img = decodePng(readFileSync(resolve(icon.src)));
      expect(icon.type).toBe("image/png");
      expect(`${img.width}x${img.height}`, icon.src).toBe(icon.sizes);
    }
    expect(WEB_APP_MANIFEST_ICONS.map((i) => i.purpose).sort()).toEqual(["any", "any", "maskable"]);
  });

  test("every shipped install icon is listed in the manifest icons, once", () => {
    const shipped = BRAND_RASTERS.filter((f) => f.startsWith("icon-"));
    expect(shipped.length).toBeGreaterThan(0);
    expect(WEB_APP_MANIFEST_ICONS.map((i) => i.src).sort()).toEqual([...shipped].sort());
  });

  test("every head link resolves to a shipped file", () => {
    expect(HTML_ICON_LINKS.length).toBeGreaterThan(0);
    for (const link of HTML_ICON_LINKS) expect(readFileSync(resolve(link.href)).length, link.href).toBeGreaterThan(0);
  });
});
