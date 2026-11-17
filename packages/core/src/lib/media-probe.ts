/**
 * A media file's dimensions and duration for the review card (#2781, design
 * rev 4 §8.1, rev 5 §9/§11): one anchored read of at most
 * {@link MEDIA_PROBE_BYTES} from the start of the file, parsed by header
 * alone. Nothing here decodes pixels or samples, and nothing guesses: a
 * value the header does not state within the read is null.
 *
 * Read: PNG, GIF, JPEG, WebP, BMP (width, height), MP4/MOV/M4A (duration
 * from `mvhd`, and the first visual track's `tkhd` size), WAV (duration
 * from `fmt ` and `data`). Anything else, including a `moov` box that
 * starts past the read, is all null.
 */

/** The most a probe reads: one 64 KiB chunk, from offset 0. */
export const MEDIA_PROBE_BYTES = 64 * 1024;

export interface MediaProbe {
  /** Pixels, or null when the header does not say within the read. */
  width: number | null;
  height: number | null;
  /** Whole milliseconds, or null. */
  durationMs: number | null;
}

const NONE: MediaProbe = Object.freeze({ width: null, height: null, durationMs: null });

/** A positive safe integer, or null. */
const dim = (n: number): number | null => (Number.isSafeInteger(n) && n > 0 ? n : null);
const ascii = (b: Buffer, at: number, length: number) => (at + length <= b.length ? b.toString("latin1", at, at + length) : "");

/** What `head` (the first bytes of one file) says about its size and length. */
export function probeMediaHead(head: Buffer): MediaProbe {
  try {
    return png(head) ?? gif(head) ?? jpeg(head) ?? webp(head) ?? bmp(head) ?? wav(head) ?? isoBmff(head) ?? NONE;
  } catch {
    return NONE;
  }
}

function png(b: Buffer): MediaProbe | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: dim(b.readUInt32BE(16)), height: dim(b.readUInt32BE(20)), durationMs: null };
}

function gif(b: Buffer): MediaProbe | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  return { width: dim(b.readUInt16LE(6)), height: dim(b.readUInt16LE(8)), durationMs: null };
}

/** The first start-of-frame marker's size; markers are walked by their lengths, never searched for. */
function jpeg(b: Buffer): MediaProbe | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return NONE;
    const marker = b[at + 1]!;
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return NONE;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return NONE;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return NONE;
      return { width: dim(b.readUInt16BE(at + 7)), height: dim(b.readUInt16BE(at + 5)), durationMs: null };
    }
    at += 2 + length;
  }
  return NONE;
}

function webp(b: Buffer): MediaProbe | null {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
    return { width: dim(b.readUInt16LE(26) & 0x3fff), height: dim(b.readUInt16LE(28) & 0x3fff), durationMs: null };
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: dim((bits & 0x3fff) + 1), height: dim(((bits >>> 14) & 0x3fff) + 1), durationMs: null };
  }
  if (chunk === "VP8X" && b.length >= 30)
    return { width: dim(b.readUIntLE(24, 3) + 1), height: dim(b.readUIntLE(27, 3) + 1), durationMs: null };
  return NONE;
}

function bmp(b: Buffer): MediaProbe | null {
  if (b.length < 26 || ascii(b, 0, 2) !== "BM") return null;
  const header = b.readUInt32LE(14);
  if (header === 12) return { width: dim(b.readUInt16LE(18)), height: dim(b.readUInt16LE(20)), durationMs: null };
  if (header < 40) return NONE;
  // A negative height is a top-down bitmap of the same size.
  return { width: dim(b.readInt32LE(18)), height: dim(Math.abs(b.readInt32LE(22))), durationMs: null };
}

/** WAV: duration from the `data` size and the `fmt ` byte rate, when both are within the read. */
function wav(b: Buffer): MediaProbe | null {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return null;
  let at = 12, byteRate = 0;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4), size = b.readUInt32LE(at + 4);
    if (id === "fmt " && at + 16 <= b.length) byteRate = b.readUInt32LE(at + 16);
    if (id === "data") return { width: null, height: null, durationMs: byteRate > 0 ? dim(Math.round((size * 1000) / byteRate)) : null };
    at += 8 + size + (size % 2);
  }
  return NONE;
}

/** ISO base media (MP4, MOV, M4A): `moov` → `mvhd` duration, and the first `trak`'s `tkhd` with a visual size. */
function isoBmff(b: Buffer): MediaProbe | null {
  if (ascii(b, 4, 4) !== "ftyp") return null;
  const moov = box(b, 0, b.length, "moov");
  if (!moov) return NONE;
  let durationMs: number | null = null, width: number | null = null, height: number | null = null;
  const mvhd = box(b, moov.start, moov.end, "mvhd");
  if (mvhd && mvhd.end - mvhd.start >= 20) {
    const v1 = b[mvhd.start] === 1;
    const scale = b.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
    const units = v1 ? (mvhd.end - mvhd.start >= 32 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : 0) : b.readUInt32BE(mvhd.start + 16);
    durationMs = scale > 0 ? dim(Math.round((units * 1000) / scale)) : null;
  }
  for (let at = moov.start; at + 8 <= moov.end;) {
    const trak = box(b, at, moov.end, "trak");
    if (!trak) break;
    const tkhd = box(b, trak.start, trak.end, "tkhd");
    if (tkhd) {
      const v1 = b[tkhd.start] === 1, sizeAt = tkhd.start + (v1 ? 88 : 76);
      if (sizeAt + 8 <= tkhd.end) {
        // 16.16 fixed point; an audio track states 0 × 0.
        const w = dim(b.readUInt32BE(sizeAt) >>> 16), h = dim(b.readUInt32BE(sizeAt + 4) >>> 16);
        if (w !== null && h !== null) { width = w; height = h; break; }
      }
    }
    at = trak.end;
  }
  return { width, height, durationMs };
}

/**
 * The first box of `type` among the siblings in [from, to), its payload
 * bounds, or null. A box that runs past the read is only found when it is the
 * one sought, clipped to what was read, so only its fully read children
 * count; a sibling past the read cannot be skipped, so nothing after it is.
 */
function box(b: Buffer, from: number, to: number, type: string): { start: number; end: number } | null {
  let at = from;
  while (at + 8 <= to) {
    let size = b.readUInt32BE(at), header = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      size = Number(b.readBigUInt64BE(at + 8)); header = 16;
    } else if (size === 0) size = to - at;
    if (size < header) return null;
    const found = ascii(b, at + 4, 4) === type;
    if (at + size > to) return found ? { start: at + header, end: to } : null;
    if (found) return { start: at + header, end: at + size };
    at += size;
  }
  return null;
}
