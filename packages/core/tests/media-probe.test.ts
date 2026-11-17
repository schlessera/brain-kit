/**
 * A media file's dimensions and duration for the review card (#2781, rev 5
 * §9): read from the first 64 KiB by header alone, null when the header
 * does not say. Synthetic headers, built byte by byte; the plan test uses a
 * real file in an Odysseus fixture brain. Offline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalFindings } from "../src/lib/hygiene";
import { DEFAULT_MEDIA_POLICY } from "../src/lib/media";
import { planMediaEffect, type MediaEffectPlan } from "../src/lib/media-effects";
import { buildMediaInventory, mediaCandidates } from "../src/lib/media-inventory";
import { MEDIA_PROBE_BYTES, probeMediaHead } from "../src/lib/media-probe";

const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u24le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const box = (type: string, ...payload: Buffer[]) => { const body = Buffer.concat(payload); return Buffer.concat([u32be(8 + body.length), Buffer.from(type, "latin1"), body]); };

function png(w: number, h: number) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from("IHDR"), u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])]);
}
function jpeg(w: number, h: number) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16be(16), Buffer.from("JFIF\0"), Buffer.alloc(9)]);
  // DHT before the frame header: a marker that is not a start-of-frame is skipped by its length.
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4]), u16be(5), Buffer.alloc(3)]);
  const sof2 = Buffer.concat([Buffer.from([0xff, 0xc2]), u16be(11), Buffer.from([8]), u16be(h), u16be(w), Buffer.from([1, 1, 0x11, 0])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof2]);
}
function mvhd(scale: number, units: number) { return box("mvhd", Buffer.alloc(4), Buffer.alloc(8), u32be(scale), u32be(units), Buffer.alloc(80)); }
function tkhd(w: number, h: number) { return box("tkhd", Buffer.alloc(4), Buffer.alloc(72), u32be(w << 16), u32be(h << 16)); }
const ftyp = box("ftyp", Buffer.from("isom"), u32be(0x200), Buffer.from("isomiso2mp41"));

describe("header probe", () => {
  test("PNG, GIF and JPEG state their size", () => {
    expect(probeMediaHead(png(1280, 720)), "PROBE_PNG").toEqual({ width: 1280, height: 720, durationMs: null });
    expect(probeMediaHead(Buffer.concat([Buffer.from("GIF89a"), u16le(320), u16le(200), Buffer.alloc(3)]))).toEqual({ width: 320, height: 200, durationMs: null });
    expect(probeMediaHead(jpeg(4032, 3024)), "PROBE_JPEG").toEqual({ width: 4032, height: 3024, durationMs: null });
  });

  test("WebP in each of its three forms, and BMP top-down", () => {
    const riff = (chunk: string, body: Buffer) => Buffer.concat([Buffer.from("RIFF"), u32le(4 + 8 + body.length), Buffer.from("WEBP"), Buffer.from(chunk), u32le(body.length), body]);
    const vp8 = Buffer.concat([Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), u16le(640), u16le(480)]);
    expect(probeMediaHead(riff("VP8 ", vp8))).toEqual({ width: 640, height: 480, durationMs: null });
    const bits = (640 - 1) | ((480 - 1) << 14);
    expect(probeMediaHead(riff("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(bits)])))).toEqual({ width: 640, height: 480, durationMs: null });
    expect(probeMediaHead(riff("VP8X", Buffer.concat([Buffer.alloc(4), u24le(639), u24le(479)])))).toEqual({ width: 640, height: 480, durationMs: null });
    const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(12), u32le(40), u32le(800), Buffer.from(Int32Array.of(-600).buffer)]);
    expect(probeMediaHead(bmp)).toEqual({ width: 800, height: 600, durationMs: null });
  });

  test("MP4 duration from mvhd and size from the first visual track; WAV duration from its byte rate", () => {
    const audio = box("trak", tkhd(0, 0)), video = box("trak", tkhd(1920, 1080));
    const mp4 = Buffer.concat([ftyp, box("moov", mvhd(1000, 12_345), audio, video)]);
    expect(probeMediaHead(mp4), "PROBE_MP4").toEqual({ width: 1920, height: 1080, durationMs: 12_345 });
    const fmt = Buffer.concat([Buffer.from("fmt "), u32le(16), u16le(1), u16le(2), u32le(44_100), u32le(176_400), u16le(4), u16le(16)]);
    const wav = Buffer.concat([Buffer.from("RIFF"), u32le(0), Buffer.from("WAVE"), fmt, Buffer.from("data"), u32le(176_400 * 3)]);
    expect(probeMediaHead(wav)).toEqual({ width: null, height: null, durationMs: 3000 });
  });

  test("what the read does not reach, or no header states, is null rather than guessed", () => {
    const none = { width: null, height: null, durationMs: null };
    // moov after a large mdat: past the read, so nothing is claimed.
    const late = Buffer.concat([ftyp, Buffer.concat([u32be(8 + 100_000), Buffer.from("mdat")]), Buffer.alloc(MEDIA_PROBE_BYTES)]);
    expect(probeMediaHead(late.subarray(0, MEDIA_PROBE_BYTES)), "PROBE_MOOV_PAST_READ").toEqual(none);
    // A moov that runs past the read still gives what its fully read children state.
    const moov = Buffer.concat([u32be(8 + 200_000), Buffer.from("moov"), mvhd(600, 1_200), box("trak", tkhd(1280, 720))]);
    const truncated = Buffer.concat([ftyp, moov, Buffer.alloc(MEDIA_PROBE_BYTES)]).subarray(0, MEDIA_PROBE_BYTES);
    expect(probeMediaHead(truncated), "PROBE_MOOV_CLIPPED").toEqual({ width: 1280, height: 720, durationMs: 2000 });
    // A track cut off by the read is not read at all.
    const cut = Buffer.concat([ftyp, u32be(8 + 200_000), Buffer.from("moov"), mvhd(600, 1_200), box("trak", tkhd(1280, 720)).subarray(0, 40)]);
    expect(probeMediaHead(cut), "PROBE_TRACK_CUT").toEqual({ width: null, height: null, durationMs: 2000 });
    expect(probeMediaHead(png(1280, 720).subarray(0, 20))).toEqual(none);
    expect(probeMediaHead(Buffer.from("<svg width='10' height='10'/>"))).toEqual(none);
    expect(probeMediaHead(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toEqual(none);
    expect(probeMediaHead(png(0, 720))).toEqual({ width: null, height: 720, durationMs: null });
    expect(probeMediaHead(Buffer.alloc(0))).toEqual(none);
  });
});

describe("the plan's media", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function brain(files: Record<string, Buffer>) {
    const root = mkdtempSync(join(tmpdir(), "brain-media-probe-"));
    dirs.push(root);
    Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]);
    for (const [path, bytes] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
    return root;
  }
  function planFor(root: string, path: string) {
    const ctx = { root, policy: DEFAULT_MEDIA_POLICY, configPath: null };
    const f = [...canonicalFindings(mediaCandidates(buildMediaInventory(root, DEFAULT_MEDIA_POLICY))).values()].find((x) => x.path === path)!;
    return planMediaEffect(ctx, { id: f.id, action: "delete", expectFingerprint: f.fingerprint }) as MediaEffectPlan;
  }

  test("Delete previews the source's size from its header; the premise does not depend on it", () => {
    const root = brain({ "photos/penelope-loom.png": Buffer.concat([png(1024, 768), Buffer.alloc(200)]), "photos/ithaca.mp3": Buffer.alloc(300, 7) });
    const loom = planFor(root, "photos/penelope-loom.png");
    expect(loom.media, "PLAN_MEDIA_PROBED").toEqual({ width: 1024, height: 768, durationMs: null });
    expect(planFor(root, "photos/ithaca.mp3").media).toEqual({ width: null, height: null, durationMs: null });
  });
});
