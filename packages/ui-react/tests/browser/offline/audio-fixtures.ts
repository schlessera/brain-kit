/**
 * Deterministic audio for offline capture tests (#1016).
 *
 * Every fixture is generated when a test needs it, from a seeded tone-and-noise
 * pattern: nothing synthesised by TTS, no large binary in the tree. The same
 * spec gives byte-identical WAV bytes in Bun, Node and the browser, because
 * the generator uses only IEEE add/multiply (a polynomial sine, an integer
 * PRNG), never `Math.sin`, whose last bit is engine-defined.
 *
 * The signal: each second carries {@link FIXTURE_TONE_HZ} for its first 750 ms
 * and seeded noise alone for the last 250 ms, so a test can tell the fixture
 * apart from Chromium's built-in fake device by the tone it hears, and a
 * level meter sees the pattern move.
 *
 * Runs in the browser and in Node (the Vitest config writes the fake
 * microphone's file at load time), so this module imports nothing.
 */

export interface AudioFixtureSpec {
  /** Stable name, also the generated file's base name. */
  name: string;
  seconds: number;
  seed: number;
  sampleRate: number;
  /** The tone; {@link FIXTURE_TONE_HZ} when absent. A test that must tell two sources apart gives one another tone. */
  toneHz?: number;
}

/** The tone the fixtures carry; 16 kHz / 500 Hz is exactly 32 samples a cycle. */
export const FIXTURE_TONE_HZ = 500;
const SAMPLE_RATE = 16_000;
const SEED = 0x0d155e05;

/**
 * The three lengths the offline capture work tests against: a short note, one
 * past a minute and a half, and one five seconds over the ten-minute recording
 * cap from the epic's 2026-09-30 retention ruling (#578).
 */
export const AUDIO_FIXTURES = {
  note10s: { name: "odysseus-note-10s", seconds: 10, seed: SEED, sampleRate: SAMPLE_RATE },
  note95s: { name: "odysseus-note-95s", seconds: 95, seed: SEED, sampleRate: SAMPLE_RATE },
  note10m05s: { name: "odysseus-note-10m05s", seconds: 605, seed: SEED, sampleRate: SAMPLE_RATE },
} as const satisfies Record<string, AudioFixtureSpec>;

/** mulberry32: 32-bit integer state, uniform in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** sin(x) for x in [-pi, pi], Taylor to x^13: error below 1e-6, exact arithmetic only. */
function sine(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n <= 6; n++) {
    term = (-term * x2) / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

const PI = 3.141592653589793;

/** 16-bit mono PCM WAV for `spec`. Same spec, same bytes. */
export function generateWav(spec: AudioFixtureSpec): Uint8Array {
  const { sampleRate, seconds } = spec;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError("sampleRate must be a positive integer");
  if (!(seconds > 0)) throw new RangeError("seconds must be positive");
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  // One cycle of the tone, phase in [-pi, pi).
  const period = sampleRate / (spec.toneHz ?? FIXTURE_TONE_HZ);
  const random = prng(spec.seed);
  const toneSamples = (sampleRate * 3) / 4;
  for (let i = 0; i < samples; i++) {
    const inSecond = i % sampleRate;
    const phase = ((i % period) / period) * 2 * PI - PI;
    const tone = inSecond < toneSamples ? 0.5 * sine(phase) : 0;
    const noise = (random() * 2 - 1) * 0.02;
    const value = Math.max(-1, Math.min(1, tone + noise));
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return out;
}

/** The duration a WAV header declares, in milliseconds. Throws on anything but the PCM layout above. */
export function wavDurationMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") throw new Error("not a PCM WAV fixture");
  const byteRate = view.getUint32(28, true);
  const dataBytes = view.getUint32(40, true);
  return (dataBytes / byteRate) * 1000;
}
