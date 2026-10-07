/**
 * The offline capture fixtures are deterministic (#1016): a test that hears
 * different audio on each run would prove nothing about the capture path.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AUDIO_FIXTURES, generateWav, wavDurationMs } from "./browser/offline/audio-fixtures.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The ten-minute recording cap from #578's 2026-09-30 retention ruling. */
const RECORDING_CAP_MS = 10 * 60 * 1000;

describe("audio fixtures", () => {
  for (const spec of Object.values(AUDIO_FIXTURES)) {
    test(`${spec.name}: two runs give the same SHA-256`, () => {
      const first = generateWav(spec);
      const second = generateWav(spec);
      expect(first.byteLength).toBeGreaterThan(44);
      expect(sha256(second)).toBe(sha256(first));
      expect(wavDurationMs(first)).toBe(spec.seconds * 1000);
    });
  }

  test("the bytes are pinned, so a generator change is a reviewed diff", () => {
    // The same hash comes out of Node, which writes the fake microphone's file.
    expect(sha256(generateWav(AUDIO_FIXTURES.note10s))).toBe("9e089825e89876e5a4b849275aa0ba4e54972f3979924f7b3e20c07d48e0ef40");
  });

  test("the seed decides the noise", () => {
    const base = generateWav(AUDIO_FIXTURES.note10s);
    const reseeded = generateWav({ ...AUDIO_FIXTURES.note10s, seed: AUDIO_FIXTURES.note10s.seed + 1 });
    expect(reseeded.byteLength).toBe(base.byteLength);
    expect(sha256(reseeded)).not.toBe(sha256(base));
  });

  test("the over-cap fixture is longer than the ten-minute cap, the others are inside it", () => {
    expect(wavDurationMs(generateWav(AUDIO_FIXTURES.note10m05s))).toBeGreaterThan(RECORDING_CAP_MS);
    expect(wavDurationMs(generateWav(AUDIO_FIXTURES.note95s))).toBeLessThan(RECORDING_CAP_MS);
  });
});
