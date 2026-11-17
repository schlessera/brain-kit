// Header-only image bytes for the markup checks (#3785). Each carries just
// enough of its format for a header reader: the pixels are never decoded.

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...Buffer.from(type), ...data, 0, 0, 0, 0];

/** A PNG with an IHDR of this size. Colour type 6 is RGBA; 2 is RGB. */
export function png(width: number, height: number, opts: { colorType?: number; trns?: boolean } = {}): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(width), ...be32(height), 8, opts.colorType ?? 6, 0, 0, 0]),
    ...(opts.trns ? chunk("tRNS", [0, 0, 0, 0, 0, 0]) : []),
    ...chunk("IDAT", [0]),
    ...chunk("IEND", []),
  ]);
}

/** A baseline JPEG whose SOF0 stores this size, with an optional EXIF orientation. */
export function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const app1 =
    orientation === undefined
      ? []
      : (() => {
          // "Exif\0\0", big-endian TIFF header, IFD0 with one Orientation entry.
          const body = [
            ...Buffer.from("Exif"), 0, 0,
            0x4d, 0x4d, 0, 42, 0, 0, 0, 8,
            0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
            0, 0, 0, 0,
          ];
          return [0xff, 0xe1, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
        })();
  const sof = [0xff, 0xc0, 0, 11, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 1, 1, 0x11, 0];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

/** An extended-format (VP8X) WebP whose canvas is this size. */
export function webp(width: number, height: number): Uint8Array {
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  return new Uint8Array([
    ...Buffer.from("RIFF"), 22, 0, 0, 0, ...Buffer.from("WEBP"),
    ...Buffer.from("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0,
    ...le24(width - 1), ...le24(height - 1),
  ]);
}
