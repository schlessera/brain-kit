/**
 * Real image bytes for the markup tests (#3975): PNGs encoded here with
 * zlib, so their headers, alpha and size are exactly what each test claims,
 * and a JPEG header carrying an EXIF orientation.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export interface PngOptions {
  /** RGBA (colour type 6) or opaque RGB (colour type 2). */
  alpha?: boolean;
  /** Fill each pixel; default fully transparent (or black when opaque). */
  pixel?: (x: number, y: number) => [number, number, number, number];
  /** Random pixels: incompressible, so the file is about width × height × 4 bytes. */
  noise?: boolean;
  /** Pad with a private ancillary chunk so the file is exactly this many bytes. */
  exactBytes?: number;
}

export function png(width: number, height: number, options: PngOptions = {}): Buffer<ArrayBuffer> {
  const alpha = options.alpha ?? true;
  const channels = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  const row = 1 + width * channels;
  let raw: Buffer;
  if (options.noise) {
    raw = Buffer.from(randomBytesLarge(row * height).buffer);
    for (let y = 0; y < height; y++) raw[y * row] = 0;
  } else {
    raw = Buffer.alloc(row * height);
    if (options.pixel) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [r, g, b, a] = options.pixel(x, y);
      const at = y * row + 1 + x * channels;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; if (alpha) raw[at + 3] = a;
    }
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: options.noise ? 0 : 9 }))];
  const end = chunk("IEND", new Uint8Array());
  const size = parts.reduce((n, part) => n + part.length, 0) + end.length;
  if (options.exactBytes !== undefined) {
    const pad = options.exactBytes - size - 12;
    if (pad < 0) throw new Error(`PNG is already ${size} bytes, over ${options.exactBytes}`);
    parts.push(chunk("prVt", new Uint8Array(pad)));
  }
  return Buffer.concat([...parts, end]) as Buffer<ArrayBuffer>;
}

/** `getRandomValues` fills at most 65,536 bytes per call. */
export function randomBytesLarge(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/**
 * A JPEG header stored `width` × `height` with EXIF `orientation`: SOI, an
 * APP1 Exif segment with one IFD entry, then a SOF0 frame header. Enough for
 * every header reader; no scan data follows.
 */
export function jpegWithOrientation(width: number, height: number, orientation: number): Buffer<ArrayBuffer> {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM", 0, "ascii"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]) as Buffer<ArrayBuffer>;
}
