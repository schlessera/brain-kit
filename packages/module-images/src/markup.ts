/**
 * Markup-guided edits (#3785): the checks a markup layer must pass before any
 * provider is paid, read from file headers only.
 *
 * OpenAI's image-generation guide (checked 2026-11-11) says the layer is a
 * separate transparent PNG, sent as `markup` on `/v1/images/edits` to the GPT
 * Image 2.5 and 2.6 models. It applies to the first input image, must match
 * that image's width and height after orientation, and may not be combined
 * with `mask`. The first image and the layer each hold at most 16,777,216
 * pixels, and the layer file at most 50 MB.
 *   https://developers.openai.com/api/docs/guides/image-generation
 */

import type { ImageInput } from "./types.js";

export const MARKUP_LIMITS = { maxPixels: 16_777_216, maxBytes: 50 * 1024 * 1024 } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ImageHeader {
  format: "png" | "jpeg" | "webp";
  /** As displayed: a JPEG's EXIF orientation 5-8 swaps the stored edges. */
  width: number;
  height: number;
  /** PNG only: an alpha channel, or a tRNS chunk. */
  alpha?: boolean;
}

const u16be = (d: Uint8Array, i: number) => (d[i] << 8) | d[i + 1];
const u32be = (d: Uint8Array, i: number) => ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];
const u16le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8);
const u24le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const ascii = (d: Uint8Array, i: number, n: number) => String.fromCharCode(...d.subarray(i, i + n));

export function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && PNG_SIGNATURE.every((b, i) => data[i] === b);
}

function pngHeader(d: Uint8Array): ImageHeader | null {
  if (d.length < 33 || ascii(d, 12, 4) !== "IHDR") return null;
  const colorType = d[25];
  let alpha = colorType === 4 || colorType === 6;
  // A tRNS chunk gives palette or truecolour images transparency; it must
  // come before the first IDAT.
  for (let i = 8; !alpha && i + 8 <= d.length; ) {
    const len = u32be(d, i);
    const type = ascii(d, i + 4, 4);
    if (type === "tRNS") alpha = true;
    if (type === "IDAT" || type === "IEND") break;
    i += 12 + len;
  }
  return { format: "png", width: u32be(d, 16), height: u32be(d, 20), alpha };
}

/** EXIF orientation from an APP1 segment, or 1 when absent or unreadable. */
function exifOrientation(d: Uint8Array, start: number, end: number): number {
  if (ascii(d, start, 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const le = ascii(d, tiff, 2) === "II";
  if (!le && ascii(d, tiff, 2) !== "MM") return 1;
  const r16 = (i: number) => (le ? u16le(d, i) : u16be(d, i));
  const r32 = (i: number) => (le ? (u16le(d, i) | (u16le(d, i + 2) << 16)) >>> 0 : u32be(d, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 1;
    if (r16(entry) === 0x0112) return r16(entry + 8);
  }
  return 1;
}

function jpegHeader(d: Uint8Array): ImageHeader | null {
  let orientation = 1;
  for (let i = 2; i + 4 <= d.length; ) {
    if (d[i] !== 0xff) return null;
    const marker = d[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = u16be(d, i + 2);
    if (marker === 0xe1) orientation = exifOrientation(d, i + 4, Math.min(d.length, i + 2 + len));
    // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > d.length) return null;
      const height = u16be(d, i + 5);
      const width = u16be(d, i + 7);
      return orientation >= 5 && orientation <= 8
        ? { format: "jpeg", width: height, height: width }
        : { format: "jpeg", width, height };
    }
    i += 2 + len;
  }
  return null;
}

function webpHeader(d: Uint8Array): ImageHeader | null {
  if (d.length < 30) return null;
  const chunk = ascii(d, 12, 4);
  if (chunk === "VP8X") return { format: "webp", width: u24le(d, 24) + 1, height: u24le(d, 27) + 1 };
  if (chunk === "VP8L" && d[20] === 0x2f) {
    const bits = d[21] | (d[22] << 8) | (d[23] << 16) | (d[24] << 24);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && d[23] === 0x9d && d[24] === 0x01 && d[25] === 0x2a) {
    return { format: "webp", width: u16le(d, 26) & 0x3fff, height: u16le(d, 28) & 0x3fff };
  }
  return null;
}

/** Width and height from a PNG, JPEG or WebP header, by signature, not by file name. */
export function imageHeader(data: Uint8Array): ImageHeader | null {
  if (isPng(data)) return pngHeader(data);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return jpegHeader(data);
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return webpHeader(data);
  return null;
}

/**
 * Why a markup layer cannot go with this first reference image, or null when
 * it can. Called before routing and again by the provider, so neither a CLI
 * caller nor a direct one pays for a request the API would refuse.
 */
export function markupProblem(markup: ImageInput, first: ImageInput | undefined): string | null {
  const name = markup.label ?? "the markup layer";
  if (!first) return "--markup annotates the first --ref image; add one with --ref.";
  if (markup.data.byteLength > MARKUP_LIMITS.maxBytes) {
    return `${name} is ${markup.data.byteLength} bytes; a markup layer may be at most 50 MB.`;
  }
  if (!isPng(markup.data)) return `${name} is not a PNG; a markup layer must be a transparent PNG.`;
  const layer = imageHeader(markup.data);
  if (!layer) return `${name} has no readable PNG header.`;
  if (!layer.alpha) {
    return `${name} has no alpha channel; draw the markup on a transparent PNG, not flattened onto the image.`;
  }
  const refName = first.label ?? "the first --ref image";
  const base = imageHeader(first.data);
  if (!base) return `Cannot read the width and height of ${refName}; markup needs a PNG, JPEG or WebP first --ref.`;
  for (const [what, h] of [[refName, base], [name, layer]] as const) {
    if (h.width * h.height > MARKUP_LIMITS.maxPixels) {
      return `${what} is ${h.width}x${h.height}, over the 16,777,216-pixel limit for markup edits.`;
    }
  }
  if (layer.width !== base.width || layer.height !== base.height) {
    return `${name} is ${layer.width}x${layer.height} but ${refName} is ${base.width}x${base.height}; the markup layer must match the first --ref exactly.`;
  }
  return null;
}
