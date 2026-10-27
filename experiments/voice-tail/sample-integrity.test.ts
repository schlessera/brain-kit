import { expect, test } from "bun:test";
import { compareScheduledSamples } from "./sample-integrity.js";
const signal = Float32Array.from({ length: 48037 }, (_, i) => (((i * 251 + 17) % 65521) - 32760) / 32768);
const start = 512;
function fixture() { const result = new Float32Array(start + signal.length + 1024); result.set(signal, start); return result; }
test("whole interval sample comparison includes startup, final short chunk and finish silence", () => {
  const result = compareScheduledSamples(fixture(), signal, start);
  expect(result).toEqual({ compared: start + signal.length + 1024, mismatches: 0, firstMismatch: -1, maxError: 0, numericalDifferences: 0, startupSamples: start, finishSamples: 1024 });
});
for (const fault of ["dropped", "repeated", "startup", "finish", "last37", "sub-lsb"] as const) test(`whole interval comparison rejects ${fault} PCM`, () => {
  const actual = fixture();
  if (fault === "dropped") actual.copyWithin(start + 24000, start + 24128);
  if (fault === "repeated") actual.copyWithin(start + 24000, start + 23872, start + 24000);
  if (fault === "startup") actual[0] = .25;
  if (fault === "finish") actual[actual.length - 1] = .25;
  if (fault === "sub-lsb") actual[0] = 1e-10;
  if (fault === "last37") actual.fill(0, start + 48000, start + signal.length);
  expect(compareScheduledSamples(actual, signal, start).mismatches).toBeGreaterThan(0);
});
test("comparison refuses a missing scheduled edge instead of trimming it away", () => {
  expect(() => compareScheduledSamples(fixture().slice(0, start + signal.length - 1), signal, start)).toThrow("outside the captured interval");
});

test("rounding allowance is reported and cannot absorb a changed PCM16 sample", () => {
  const zeroSignal = new Float32Array(2);
  const actual = new Float32Array([0, 1e-10, 0, 0]);
  const comparison = compareScheduledSamples(actual, zeroSignal, 1);
  expect(comparison.mismatches).toBe(0);
  expect(comparison.numericalDifferences).toBe(1);
  expect(comparison.maxError).toBeGreaterThan(0);
  actual[1] = 1 / 32768;
  expect(compareScheduledSamples(actual, zeroSignal, 1).mismatches).toBe(1);
});
