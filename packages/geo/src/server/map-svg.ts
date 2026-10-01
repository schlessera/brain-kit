import type { Font } from "fontkit";
import { readFile } from "node:fs/promises";
import type { BBox, CoastlineResult, Coord } from "../coastline.js";

const R = 6_371_008.8;
export const MAX_MAP_LAT = 85.0511287798066;
const radians = Math.PI / 180;
const round = (value: number) => Number(value.toFixed(3));
export const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
export const mercator = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + lat * radians / 2));
export const inverseMercator = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / radians;

export interface MapViewport {
  bounds: BBox;
  frame: { x: number; y: number; width: number; height: number };
  point: (point: { lat: number; lon: number }) => Coord;
  contains: (point: { lat: number; lon: number }) => boolean;
  scale: { value: number; unit: "m"; lengthPx: number; latitude: number; method: "mercator_at_center_latitude" };
}

/** Isotropic Mercator units; source coordinates are never clamped or changed. */
export function mapViewport(bounds: BBox, width: number, y: number): MapViewport {
  const [west, south, east, north] = bounds;
  const left = R * west * radians, right = R * east * radians, bottom = mercator(south), top = mercator(north);
  const frame = { x: 24, y, width: width - 48, height: Math.round(Math.min(560, (width - 48) * 0.62)) };
  const ratio = Math.min(frame.width / (right - left), frame.height / (top - bottom));
  const offsetX = frame.x + (frame.width - (right - left) * ratio) / 2;
  const offsetY = frame.y + (frame.height - (top - bottom) * ratio) / 2;
  const latitude = inverseMercator((top + bottom) / 2);
  const metresPerPixel = Math.cos(latitude * radians) / ratio;
  const budget = Math.min(140, frame.width / 3) * metresPerPixel;
  const power = 10 ** Math.floor(Math.log10(budget));
  const value = [1, 2, 5, 10].map(n => n * power).filter(n => n <= budget).at(-1)!;
  return { bounds: [...bounds], frame,
    point: point => [round(offsetX + (R * point.lon * radians - left) * ratio), round(offsetY + (top - mercator(point.lat)) * ratio)],
    contains: point => point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north,
    scale: { value, unit: "m", lengthPx: value / metresPerPixel, latitude, method: "mercator_at_center_latitude" } };
}

let fontPromise: Promise<{ regular: Font; medium: Font }> | undefined;
export function mapFonts(): Promise<{ regular: Font; medium: Font }> {
  return fontPromise ??= (async () => {
    const { create } = await import("fontkit");
    const [regular, medium] = await Promise.all([
      readFile(new URL("../../assets/IBMPlexSans-Regular.ttf", import.meta.url)),
      readFile(new URL("../../assets/IBMPlexSans-Medium.ttf", import.meta.url)),
    ]);
    const a = create(regular), b = create(medium);
    if (!("unitsPerEm" in a) || !("unitsPerEm" in b)) throw new Error("Bundled map fonts must be single faces.");
    return { regular: a, medium: b };
  })();
}

export interface MapTextLine { text: string; x: number; baseline: number; size: number; medium: boolean; ink: string }
export function textWidth(font: Font, text: string, size: number): number {
  return font.layout(text).positions.reduce((sum, position) => sum + position.xAdvance, 0) * size / font.unitsPerEm;
}

/** Wrap at words using bundled-font advances; oversized tokens break without losing text. */
export function wrapMapText(font: Font, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    for (const token of paragraph.match(/\S+\s*|\s+/g) ?? []) {
      if (line && textWidth(font, (line + token).trimEnd(), size) > width) { lines.push(line.trimEnd()); line = ""; }
      if (textWidth(font, token.trimEnd(), size) <= width) { line += token; continue; }
      for (const char of token) {
        if (line && textWidth(font, line + char, size) > width) { lines.push(line.trimEnd()); line = ""; }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Glyph outlines eliminate renderer font lookup and preserve measured layout. */
export function mapText(font: Font, line: MapTextLine): string {
  const scale = line.size / font.unitsPerEm, run = font.layout(line.text);
  let penX = 0, penY = 0;
  const paths = run.glyphs.map((glyph, index) => {
    const position = run.positions[index]!;
    const result = `<path d="${glyph.path.toSVG()}" transform="translate(${round((penX + position.xOffset) * scale)} ${round(-(penY + position.yOffset) * scale)}) scale(${scale} ${-scale})"/>`;
    penX += position.xAdvance; penY += position.yAdvance;
    return result;
  }).join("");
  return `<g fill="${line.ink}" transform="translate(${line.x} ${line.baseline})" aria-label="${xml(line.text)}">${paths}</g>`;
}

export function mapPath(coords: Coord[], viewport: MapViewport, close = false): string {
  return coords.map(([lon, lat], index) => {
    const [x, y] = viewport.point({ lat, lon }); return `${index ? "L" : "M"}${x},${y}`;
  }).join("") + (close ? "Z" : "");
}

export function backgroundSvg(geometry: CoastlineResult, viewport: MapViewport): string {
  const land = geometry.land.map(ring => mapPath(ring, viewport, true)).join("");
  const paths = (lines: Coord[][], ink: string, width: number) => lines.map(line => `<path d="${mapPath(line, viewport)}" fill="none" stroke="${ink}" stroke-width="${width}"/>`).join("");
  return `<path d="${land}" fill="#f2f2f1" fill-rule="evenodd"/>`
    + paths(geometry.streets, "#dad8d4", 0.8) + paths(geometry.roads, "#b6b2ac", 1.3) + paths(geometry.coastline, "#65625f", 1.3);
}
