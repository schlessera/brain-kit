import sharp from "sharp";

/** Fictional Odysseus camera data, generated locally without a network fixture. */
export async function taggedPhoto(options: { orientation?: number; date?: string; offset?: string; fraction?: string; zeroGps?: boolean; southWest?: boolean } = {}): Promise<Buffer> {
  const width = 3200, height = 2000;
  const pixels = Buffer.alloc(width * height * 3);
  const colours = [[224, 49, 40], [56, 163, 92], [33, 91, 215], [237, 195, 49]];
  for (let y = 0; y < height; y++) {
    const row = y * width * 3, half = y < height / 2 ? 0 : 2;
    pixels.fill(Buffer.from(colours[half]), row, row + width * 3 / 2);
    pixels.fill(Buffer.from(colours[half + 1]), row + width * 3 / 2, row + width * 3);
  }
  const exif = {
    IFD0: { Artist: "Odysseus", ImageDescription: "Ithaca homecoming" },
    IFD2: {
      DateTimeOriginal: options.date ?? "2026:07:15 12:34:56",
      ...(options.offset === "" ? {} : { OffsetTimeOriginal: options.offset ?? "+02:00" }),
      ...(options.fraction === undefined ? {} : { SubSecTimeOriginal: options.fraction }),
    },
    IFD3: {
      GPSLatitudeRef: options.southWest ? "S" : "N", GPSLongitudeRef: options.southWest ? "W" : "E",
      GPSLatitude: options.zeroGps ? "0/1 0/1 0/1" : "38/1 22/1 12/1",
      GPSLongitude: options.zeroGps ? "0/1 0/1 0/1" : "20/1 43/1 48/1",
    },
  };
  const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .withExif(exif).withMetadata({ orientation: options.orientation ?? 6 })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:title="Odysseus in Ithaca"/></rdf:RDF></x:xmpmeta>')
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const title = Buffer.from("Odysseus at the headland");
  const record = Buffer.concat([Buffer.from([0x1c, 2, 5, 0, title.length]), title]);
  const resource = Buffer.alloc(12);
  resource.write("8BIM"); resource.writeUInt16BE(0x0404, 4); resource.writeUInt32BE(record.length, 8);
  const iptc = Buffer.concat([Buffer.from("Photoshop 3.0\0"), resource, record, Buffer.alloc(record.length % 2)]);
  return Buffer.concat([jpeg.subarray(0, 2), segment(0xed, iptc), segment(0xfe, Buffer.from("Odysseus camera comment")), jpeg.subarray(2)]);
}

function segment(marker: number, content: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(content.length + 2, 2);
  return Buffer.concat([header, content]);
}

/** Independent JPEG marker read: no encoder/EXIF library interprets this check. */
export function metadataMarkers(jpeg: Uint8Array): number[] {
  const bytes = Buffer.from(jpeg), found: number[] = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG fixture");
  for (let at = 2; at < bytes.length;) {
    if (bytes[at] !== 0xff) throw new Error("Invalid JPEG marker");
    const marker = bytes[at + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) found.push(marker);
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return found;
}
