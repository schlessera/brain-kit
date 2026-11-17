/**
 * Width, height and alpha from an image's own header bytes, never from its
 * file name: PNG, JPEG (after EXIF orientation) and WebP.
 *
 * Internal to brain-kit: reached through
 * `@schlessera/brain-common/internal/image-header`, with no compatibility
 * promise (docs/decisions/public-export-boundary.md). Two packages must agree
 * on a markup layer's size and neither may depend on the other: the images
 * module's `markupProblem` (#3785) refuses a layer before any provider is
 * paid, and the chat server's markup application (#3975) refuses one before
 * it is written. Both read the headers here, so a layer the server accepts is
 * one the CLI accepts.
 */

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
