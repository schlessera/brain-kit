/**
 * Renders the logo's raster files from its master SVGs (#1425).
 *
 * Browsers, home screens and link previews need PNG and ICO files; the logo is
 * specified as SVG (#1423). Every raster under `assets/brand/` but one is
 * therefore generated here from a committed master, never edited or exported
 * by hand, so the artwork has one source. The exceptions are the social
 * cards, `social-card.png` and `social-card@2x.png`, reviewed raster masters
 * in their own right (#1428): nothing here renders or overwrites them. resvg is pinned, renders without system fonts
 * (the masters contain no text, only outlined paths) and writes no timestamps,
 * so a run on a clean tree reproduces the committed bytes exactly;
 * `tests/brand-rasters.test.ts` holds it to that.
 *
 * Run it after a master changes:
 *
 *   bun run --cwd packages/ui-kit brand:generate
 */

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { BrandRaster } from "../../src/brand.js";

export const BRAND_DIR = resolve(import.meta.dir, "..", "..", "assets", "brand");

/** The rasters this script renders: all of them except the social card masters. */
export type GeneratedRaster = Exclude<BrandRaster, "social-card.png" | "social-card@2x.png">;

/** Each generated raster, the master it comes from, and the pixel widths it holds. */
export const RASTER_SOURCES: Record<GeneratedRaster, { master: string; widths: readonly number[] }> = {
  // The favicon master carries the small-size mark on its dark tile; the ICO
  // is the fallback for clients that do not take an SVG favicon.
  "favicon.ico": { master: "favicon.svg", widths: [16, 32, 48] },
  "apple-touch-icon.png": { master: "apple-touch-icon.svg", widths: [180] },
  "icon-192.png": { master: "icon-512.svg", widths: [192] },
  "icon-512.png": { master: "icon-512.svg", widths: [512] },
  "icon-maskable-512.png": { master: "maskable-512.svg", widths: [512] },
};

function render(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  });
  return Buffer.from(resvg.render().asPng());
}

/**
 * An ICO whose entries are PNG images, which every browser that still asks
 * for `favicon.ico` accepts. Layout: a 6-byte header, one 16-byte directory
 * entry per image, then the PNG bytes in the same order.
 */
export function encodeIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width; 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // no palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** Every generated raster, rendered from the masters in `BRAND_DIR`, by file name. */
export function renderBrandRasters(): Record<GeneratedRaster, Buffer> {
  const out = {} as Record<GeneratedRaster, Buffer>;
  for (const [file, { master, widths }] of Object.entries(RASTER_SOURCES) as [GeneratedRaster, (typeof RASTER_SOURCES)[GeneratedRaster]][]) {
    const svg = readFileSync(join(BRAND_DIR, master), "utf8");
    out[file] = file.endsWith(".ico")
      ? encodeIco(widths.map((size) => ({ size, png: render(svg, size) })))
      : render(svg, widths[0]!);
  }
  return out;
}

if (import.meta.main) {
  for (const [file, bytes] of Object.entries(renderBrandRasters())) {
    writeFileSync(join(BRAND_DIR, file), bytes);
    console.log(`wrote assets/brand/${file} (${bytes.length} bytes)`);
  }
}
