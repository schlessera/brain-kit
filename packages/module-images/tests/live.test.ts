/**
 * Live provider tests — real API calls, real money.
 *
 * These are OFF by default and must stay off in CI. Run them deliberately when
 * a provider may have changed under us:
 *
 *     BRAIN_IMAGES_LIVE=1 bun test packages/module-images/tests/live.test.ts
 *
 * A full run costs roughly $0.35 at current prices and takes a few minutes.
 * Every image model is exercised individually, because they do not share a
 * schema: this suite is what caught that all three Gemini models reject
 * `image/png` and serve JPEG only, and that the bytes arrive inside
 * `steps[].content[]` rather than the `output_image` field the API reference
 * documents.
 *
 * Requires OPENAI_API_KEY and GEMINI_API_KEY.
 */

import { describe, expect, test } from "bun:test";
import { deflateSync } from "zlib";

import { geminiProvider } from "../src/providers/gemini";
import { openaiProvider } from "../src/providers/openai";
import type { ImageInput } from "../src/types";

const LIVE = process.env.BRAIN_IMAGES_LIVE === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";

/** bun:test has no runtime `skipIf` on `describe`, so gate at the test level. */
const live = LIVE ? test : test.skip;

const PROMPT = "a single ripe banana on a plain white background, studio photo";
const TIMEOUT = 240_000;

/** Width/height straight out of the file, so the assertion is about the bytes. */
function pngSize(b: Uint8Array): { w: number; h: number } {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}
function jpegSize(b: Uint8Array): { w: number; h: number } {
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0..SOF15, excluding the non-frame markers in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + len;
  }
  throw new Error("no JPEG frame header found");
}
const ratio = ({ w, h }: { w: number; h: number }) => w / h;

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
/**
 * Whether a PNG can actually carry transparency: colour type 6 (RGBA) or 4
 * (grey+alpha), or a palette with a tRNS chunk. Asserting "it is a PNG" would
 * pass just as happily on an opaque RGB image.
 */
function pngHasAlpha(b: Uint8Array): boolean {
  const colourType = b[25];
  if (colourType === 6 || colourType === 4) return true;
  const ascii = Buffer.from(b.subarray(0, Math.min(b.length, 4096))).toString("latin1");
  return ascii.includes("tRNS");
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return new Uint8Array(out);
}

/**
 * A square RGBA PNG that is opaque except for a transparent hole in the middle.
 * OpenAI reads alpha = 0 as "this is the part you may change", so this is the
 * minimum viable mask — built here rather than committed as a fixture so it
 * always matches the dimensions of whatever image the test generates.
 */
function maskPng(side: number): Uint8Array {
  const raw = Buffer.alloc(side * (side * 4 + 1));
  let p = 0;
  for (let y = 0; y < side; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < side; x++) {
      const hole = x > side * 0.3 && x < side * 0.7 && y > side * 0.3 && y < side * 0.7;
      raw[p++] = 255;
      raw[p++] = 255;
      raw[p++] = 255;
      raw[p++] = hole ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", new Uint8Array(ihdr)),
      chunk("IDAT", new Uint8Array(deflateSync(raw))),
      chunk("IEND", new Uint8Array(0)),
    ])
  );
}

describe("live: gemini image models", () => {
  for (const model of [
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-image",
    "gemini-3-pro-image",
  ]) {
    live(
      `${model} generates a JPEG`,
      async () => {
        const result = await geminiProvider.generate(model, { prompt: PROMPT, resolution: "1K" }, GEMINI_KEY);
        expect(result.images).toHaveLength(1);
        // Every Gemini image model serves JPEG regardless of what is asked for.
        expect(result.images[0].mime).toBe("image/jpeg");
        expect(isJpeg(result.images[0].data)).toBe(true);
        expect(result.images[0].data.byteLength).toBeGreaterThan(10_000);
      },
      TIMEOUT
    );

    live(
      `${model} rejects image/png rather than silently converting`,
      async () => {
        // Free: the API refuses before generating anything.
        await expect(
          geminiProvider.generate(model, { prompt: "x", format: "png" }, GEMINI_KEY)
        ).rejects.toThrow(/not supported.*mime_type|image\/png/i);
      },
      TIMEOUT
    );
  }

  live(
    "an aspect ratio reaches the pixels",
    async () => {
      const result = await geminiProvider.generate(
        "gemini-3.1-flash-lite-image",
        { prompt: PROMPT, aspect: "16:9", resolution: "1K" },
        GEMINI_KEY
      );
      expect(isJpeg(result.images[0].data)).toBe(true);
      expect(ratio(jpegSize(result.images[0].data))).toBeCloseTo(16 / 9, 0);
    },
    TIMEOUT
  );

  live(
    "2K is honoured, and is bigger than 1K",
    async () => {
      const twoK = await geminiProvider.generate(
        "gemini-3.1-flash-image",
        { prompt: PROMPT, aspect: "1:1", resolution: "2K" },
        GEMINI_KEY
      );
      const size = jpegSize(twoK.images[0].data);
      expect(Math.max(size.w, size.h)).toBeGreaterThan(1500);
      expect(ratio(size)).toBeCloseTo(1, 1);
    },
    TIMEOUT
  );

  live(
    "accepts a reference image for a prompt-described edit",
    async () => {
      const base = await geminiProvider.generate(
        "gemini-3.1-flash-lite-image",
        { prompt: PROMPT, resolution: "1K" },
        GEMINI_KEY
      );
      const ref: ImageInput = { data: base.images[0].data, mime: "image/jpeg", label: "base.jpg" };
      const edited = await geminiProvider.generate(
        "gemini-3.1-flash-lite-image",
        { prompt: "make the background deep blue", references: [ref], resolution: "1K" },
        GEMINI_KEY
      );
      expect(isJpeg(edited.images[0].data)).toBe(true);
      expect(Buffer.from(edited.images[0].data).equals(Buffer.from(base.images[0].data))).toBe(false);
    },
    TIMEOUT * 2
  );
});

describe("live: openai image models", () => {
  for (const model of ["gpt-image-2", "gpt-image-1.5"]) {
    live(
      `${model} generates a PNG at the requested size`,
      async () => {
        const result = await openaiProvider.generate(
          model,
          { prompt: PROMPT, quality: "low", size: "1024x1024", format: "png" },
          OPENAI_KEY
        );
        expect(isPng(result.images[0].data)).toBe(true);
        expect(pngSize(result.images[0].data)).toEqual({ w: 1024, h: 1024 });
      },
      TIMEOUT
    );

    live(
      `${model} turns an aspect ratio into pixels of that shape`,
      async () => {
        // OpenAI has no aspect parameter; the module computes a legal size.
        const result = await openaiProvider.generate(
          model,
          { prompt: PROMPT, aspect: "16:9", quality: "low", format: "png" },
          OPENAI_KEY
        );
        const size = pngSize(result.images[0].data);
        expect(ratio(size)).toBeCloseTo(16 / 9, 0);
        expect(size.w % 16).toBe(0);
        expect(size.h % 16).toBe(0);
      },
      TIMEOUT
    );
  }

  live(
    "gpt-image-2 refuses a transparent background",
    async () => {
      // The reason gpt-image-1.5 is kept in the model list at all.
      await expect(
        openaiProvider.generate(
          "gpt-image-2",
          { prompt: "a logo", transparent: true, quality: "low", size: "1024x1024" },
          OPENAI_KEY
        )
      ).rejects.toThrow();
    },
    TIMEOUT
  );

  live(
    "gpt-image-1.5 accepts a transparent background",
    async () => {
      const result = await openaiProvider.generate(
        "gpt-image-1.5",
        { prompt: "a simple flat icon of a banana", transparent: true, quality: "low", size: "1024x1024", format: "png" },
        OPENAI_KEY
      );
      expect(isPng(result.images[0].data)).toBe(true);
      // The point of routing transparency here is an alpha channel, not a PNG.
      expect(pngHasAlpha(result.images[0].data)).toBe(true);
    },
    TIMEOUT
  );

  live(
    "edits with a reference image over multipart",
    async () => {
      const base = await openaiProvider.generate(
        "gpt-image-2",
        { prompt: PROMPT, quality: "low", size: "1024x1024", format: "png" },
        OPENAI_KEY
      );
      const edited = await openaiProvider.generate(
        "gpt-image-2",
        {
          prompt: "put the banana on a deep blue background",
          quality: "low",
          size: "1024x1024",
          references: [{ data: base.images[0].data, mime: "image/png", label: "base.png" }],
        },
        OPENAI_KEY
      );
      expect(isPng(edited.images[0].data)).toBe(true);
    },
    TIMEOUT * 2
  );

  live(
    "inpaints the transparent region of a mask",
    async () => {
      const base = await openaiProvider.generate(
        "gpt-image-2",
        { prompt: PROMPT, quality: "low", size: "1024x1024", format: "png" },
        OPENAI_KEY
      );
      const edited = await openaiProvider.generate(
        "gpt-image-2",
        {
          prompt: "put a bright red apple here",
          quality: "low",
          size: "1024x1024",
          references: [{ data: base.images[0].data, mime: "image/png", label: "base.png" }],
          mask: { data: maskPng(1024), mime: "image/png", label: "mask.png" },
        },
        OPENAI_KEY
      );
      expect(isPng(edited.images[0].data)).toBe(true);
    },
    TIMEOUT * 2
  );
});

/**
 * One base image, reused by every reference test below. Created lazily so the
 * suite spends nothing when it is skipped — a `beforeAll` would bill on every
 * ordinary CI run.
 */
let sharedBase: { data: Uint8Array; mime: string } | null = null;
async function baseImage() {
  if (!sharedBase) {
    const r = await geminiProvider.generate(
      "gemini-3.1-flash-lite-image",
      { prompt: PROMPT, resolution: "1K" },
      GEMINI_KEY
    );
    sharedBase = r.images[0];
  }
  return sharedBase;
}

describe("live: reference images on every model", () => {
  // Each model is exercised separately because they do not share a schema —
  // this suite has already caught a PNG rejection, a response shape that does
  // not match the docs, and a size rejection on one model but not its sibling.
  const cases: { model: string; provider: "openai" | "gemini" }[] = [
    { model: "gpt-image-2", provider: "openai" },
    { model: "gpt-image-1.5", provider: "openai" },
    { model: "gemini-3-pro-image", provider: "gemini" },
    { model: "gemini-3.1-flash-image", provider: "gemini" },
    { model: "gemini-3.1-flash-lite-image", provider: "gemini" },
  ];

  for (const { model, provider } of cases) {
    live(
      `${model} accepts a reference image and changes it`,
      async () => {
        const base = await baseImage();
        const ref: ImageInput = { data: base.data, mime: base.mime, label: "base.jpg" };
        const req = { prompt: "put it on a deep blue background", references: [ref] };

        const edited =
          provider === "openai"
            ? await openaiProvider.generate(
                model,
                { ...req, quality: "low" as const, size: "1024x1024", format: "png" as const },
                OPENAI_KEY
              )
            : await geminiProvider.generate(model, { ...req, resolution: "1K" as const }, GEMINI_KEY);

        expect(edited.images).toHaveLength(1);
        const bytes = edited.images[0].data;
        expect(bytes.byteLength).toBeGreaterThan(10_000);
        expect(provider === "openai" ? isPng(bytes) : isJpeg(bytes)).toBe(true);
        // An edit that returns its input unchanged is a silent failure.
        expect(Buffer.from(bytes).equals(Buffer.from(base.data))).toBe(false);
      },
      TIMEOUT * 2
    );
  }
});

describe("live suite wiring", () => {
  test("is skipped unless BRAIN_IMAGES_LIVE=1", () => {
    // A canary: if this file ever runs its live tests in CI, that is a bug.
    if (!LIVE) expect(live).toBe(test.skip);
  });

  test("the hand-rolled mask is a valid PNG", () => {
    const png = maskPng(64);
    expect(isPng(png)).toBe(true);
    expect(png.byteLength).toBeGreaterThan(100);
  });
});
