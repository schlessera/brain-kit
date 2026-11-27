/**
 * The one PNG encoder of the ui-server test helpers (helpers/markup-images.ts,
 * #4851) writes valid chunks, and the media-flow wrappers over it keep their
 * bytes: the ui-react hygiene fixture serves them, so a size match is not
 * enough.
 */
import { describe, expect, test } from "bun:test";
import { png } from "./helpers/markup-images";
import { noisePng, png as solidPng } from "./helpers/media-flow";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunks(bytes: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
  const out: Array<{ type: string; data: Buffer; crc: number }> = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    out.push({ type, data: bytes.subarray(at + 8, at + 8 + length), crc: bytes.readUInt32BE(at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

function header(bytes: Buffer) {
  const ihdr = chunks(bytes)[0]!;
  expect(ihdr.type).toBe("IHDR");
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4), bitDepth: ihdr.data[8], colourType: ihdr.data[9] };
}

/** Each chunk's stored CRC, against one computed here by an independent implementation. */
function expectValidChunks(bytes: Buffer): void {
  expect([...bytes.subarray(0, 8)]).toEqual(SIGNATURE);
  const found = chunks(bytes);
  expect(found.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  for (const chunk of found) {
    expect({ type: chunk.type, crc: chunk.crc }).toEqual({ type: chunk.type, crc: Bun.hash.crc32(Buffer.concat([Buffer.from(chunk.type, "latin1"), chunk.data])) });
  }
}

const sha256 = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("the PNG encoder", () => {
  test("a solid-colour image has the signature, its header and valid chunk CRCs", () => {
    const image = png(24, 16, { alpha: false, fill: [176, 112, 64] });
    expectValidChunks(image);
    expect(header(image)).toEqual({ width: 24, height: 16, bitDepth: 8, colourType: 2 });
    expect(header(png(3, 5, { fill: [1, 2, 3, 4] }))).toEqual({ width: 3, height: 5, bitDepth: 8, colourType: 6 });
  });

  test("a seeded-noise image has the signature, its header and valid chunk CRCs", () => {
    const image = png(40, 30, { alpha: false, noise: true, seed: 12 });
    expectValidChunks(image);
    expect(header(image)).toEqual({ width: 40, height: 30, bitDepth: 8, colourType: 2 });
  });

  test("seeded noise repeats for one seed and differs for another", () => {
    expect(noisePng(64, 12).equals(noisePng(64, 12))).toBe(true);
    expect(noisePng(64, 12).equals(noisePng(64, 13))).toBe(false);
    expect(png(8, 8, { noise: true, seed: 5 }).equals(png(8, 8, { noise: true, seed: 5 }))).toBe(true);
  });
});

describe("the media-flow wrappers keep their bytes", () => {
  // SHA-256 of each image a media-flow caller builds, as encoded on the merge
  // base before the two encoders became one.
  const SOLID: Array<[number, number, [number, number, number], number, string]> = [
    [24, 16, [176, 112, 64], 86, "f32be75540c1ffacebe48c47b086b5be7daf03596c71360097dffd4ada731e3c"],
    [20, 20, [200, 168, 40], 86, "f259d2b9f839bee8a3ec59d7a28e757ee3edb476b2033a30ce8c3bfb839105ee"],
    [16, 12, [96, 96, 96], 77, "49e43a2cf853d1d32828b23ba40319ca9d2add0efc0451088cd890dd9674cf4b"],
    [18, 12, [120, 80, 48], 80, "9d281000c6fec888fb9a6e7d7eb631fd06435cc2183988487fb97b8a6fb77312"],
    [32, 18, [40, 96, 160], 91, "7060ed207243db913e0f901d764d4f956a5e715df21701a3da9210e3be60d3f7"],
  ];

  test("png(width, height, rgb) for every size the media flow uses", () => {
    for (const [width, height, rgb, bytes, digest] of SOLID) {
      const image = solidPng(width, height, rgb);
      expect({ width, height, bytes: image.length, digest: sha256(image) }).toEqual({ width, height, bytes, digest });
      expectValidChunks(image);
    }
  });

  test("noisePng(side, seed) for the default seed and two others", () => {
    expect(sha256(noisePng(700))).toBe("1517a8cf1f1448213cfbf3238e6a105f5ddda6282d77d66d10b5b7fc492930c7");
    expect(noisePng(700).length).toBe(1_470_983);
    expect(sha256(noisePng(700, 13))).toBe("07aea2368c85bbf2cc04b630723257cc4bc673e0e916ee910ddeb23fb9716f1d");
    expect(sha256(noisePng(5, 7))).toBe("bb4be9d09bc7aceaf416acd6fe6cd35c969c54a5047e538d46e38e5853e23013");
  });
});
